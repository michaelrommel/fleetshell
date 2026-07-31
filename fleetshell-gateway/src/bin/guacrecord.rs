//! guacrecord — post-process Guacamole session recordings.
//!
//! Watches a single "jobs" directory with inotify.  When the gateway writes a
//! `<conn_id>.json` job file there (signalling that a session recording is
//! complete), guacrecord:
//!
//! 1. Runs `guacenc` to produce an MP4/M4V video from the `.guac` file.
//! 2. Parses the `.guac` instruction stream to extract keystroke events.
//! 3. Reconstructs typed text (applying Backspace, tracking modifiers).
//! 4. Segments the text into bursts separated by pauses or length limits.
//! 5. Writes `<recording>.keys.txt` — timestamped plaintext transcript.
//! 6. Writes `<recording>.srt`     — subtitle file for the video player.
//! 7. Moves the job JSON to `<jobs>/done/<conn_id>.json`.
//!
//! Usage:
//!   guacrecord <jobs_dir>
//!
//! The `done/` sub-directory is created automatically inside `jobs_dir`.
//! Processing failures are logged and never crash the watcher loop.

use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Write};
use std::process::Command;

use inotify::{EventMask, Inotify, WatchMask};
use serde::Deserialize;

// ── Job descriptor (deserialised from the gateway's JSON file) ────────────────

#[derive(Debug, Deserialize)]
struct Job {
	conn_id:    String,
	recording:  String,
	target:     String,
	protocol:   String,
	user:       Option<String>,
	width:      u32,
	height:     u32,
	started_ms: u64,
	ended_ms:   u64,
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
	let jobs_dir = env::args().nth(1).unwrap_or_else(|| {
		eprintln!("usage: guacrecord <jobs_dir>");
		std::process::exit(1);
	});

	let done_dir = format!("{}/done", jobs_dir);
	fs::create_dir_all(&done_dir)
		.unwrap_or_else(|e| eprintln!("[guacrecord] could not create done dir: {e}"));

	// Process any job files that already exist (e.g. after a restart).
	if let Ok(entries) = fs::read_dir(&jobs_dir) {
		for entry in entries.flatten() {
			let name = entry.file_name();
			let s = name.to_string_lossy();
			if s.ends_with(".json") && !s.starts_with('.') {
				process_job(&jobs_dir, &done_dir, &s);
			}
		}
	}

	// Watch for new job files via inotify.
	let mut inotify = Inotify::init().expect("inotify init failed");
	inotify
		.watches()
		.add(
			&jobs_dir,
			WatchMask::CLOSE_WRITE | WatchMask::MOVED_TO,
		)
		.expect("inotify watch failed");

	eprintln!("[guacrecord] watching {jobs_dir} for recording jobs");

	let mut buf = [0u8; 4096];
	loop {
		let events = match inotify.read_events_blocking(&mut buf) {
			Ok(e)  => e,
			Err(e) => { eprintln!("[guacrecord] inotify error: {e}"); continue; }
		};
		for event in events {
			if event.mask.contains(EventMask::ISDIR) { continue; }
			if let Some(name) = event.name {
				let s = name.to_string_lossy();
				if s.ends_with(".json") && !s.starts_with('.') {
					process_job(&jobs_dir, &done_dir, &s);
				}
			}
		}
	}
}

// ── Per-job driver ────────────────────────────────────────────────────────────

fn process_job(jobs_dir: &str, done_dir: &str, filename: &str) {
	let json_path = format!("{}/{}", jobs_dir, filename);
	let raw = match fs::read_to_string(&json_path) {
		Ok(s)  => s,
		Err(e) => { eprintln!("[guacrecord] read {json_path}: {e}"); return; }
	};
	let job: Job = match serde_json::from_str(&raw) {
		Ok(j)  => j,
		Err(e) => { eprintln!("[guacrecord] parse {json_path}: {e}"); return; }
	};

	let duration_secs = (job.ended_ms.saturating_sub(job.started_ms)) / 1000;
	eprintln!(
		"[guacrecord] processing conn={} target={} proto={} user={} duration={}s",
		job.conn_id,
		job.target,
		job.protocol,
		job.user.as_deref().unwrap_or("?"),
		duration_secs,
	);

	// 1. Encode video.
	run_guacenc(&job);

	// 2. Parse keystroke events from the .guac file.
	let events = match parse_guac_keystrokes(&job.recording) {
		Ok(e)  => e,
		Err(e) => {
			eprintln!("[guacrecord] parse {}: {e}", job.recording);
			Vec::new()
		}
	};

	// 3. Segment into typing bursts.
	let segments = segment_events(&events);

	// 4. Write text transcript.
	let keys_path = format!("{}.keys.txt", job.recording);
	if let Err(e) = write_keys_txt(&keys_path, &segments, job.started_ms) {
		eprintln!("[guacrecord] write {keys_path}: {e}");
	} else {
		eprintln!("[guacrecord] wrote {keys_path}");
	}

	// 5. Write SRT subtitles.
	let srt_path = format!("{}.srt", job.recording);
	if let Err(e) = write_srt(&srt_path, &segments) {
		eprintln!("[guacrecord] write {srt_path}: {e}");
	} else {
		eprintln!("[guacrecord] wrote {srt_path}");
	}

	// 6. Move job JSON to done/.
	let done_path = format!("{}/{}", done_dir, filename);
	if let Err(e) = fs::rename(&json_path, &done_path) {
		eprintln!("[guacrecord] move {json_path} → {done_path}: {e}");
	}

	eprintln!("[guacrecord] done conn={}", job.conn_id);
}

// ── guacenc invocation ────────────────────────────────────────────────────────

fn run_guacenc(job: &Job) {
	let out = format!("{}.m4v", job.recording);
	let size = format!("{}x{}", job.width, job.height);

	let status = Command::new("guacenc")
		.args(["-s", &size, &job.recording, &out])
		.status();

	match status {
		Ok(s) if s.success() =>
			eprintln!("[guacrecord] guacenc → {out}"),
		Ok(s) =>
			eprintln!("[guacrecord] guacenc exited {:?} for {}", s.code(), job.recording),
		Err(e) =>
			eprintln!("[guacrecord] guacenc exec failed: {e}"),
	}
}

// ── Guacamole instruction parser (sync, file-based) ───────────────────────────
//
// The .guac recording format is the raw Guacamole instruction stream:
//
//   N.OPCODE,N.ARG1,N.ARG2,...;
//
// where N is the decimal byte-length of the immediately following string.
// Elements are comma-separated; instructions are semicolon-terminated.
//
// Relevant instructions:
//   sync,<timestamp_ms>         — wall-clock anchor; all following events
//                                 carry this timestamp until the next sync.
//   key,<pressed>,<keysym>      — pressed=1 (down) or 0 (up); keysym is X11.

#[derive(Debug)]
struct KeyEvent {
	/// Milliseconds from session start (from the last preceding sync).
	timestamp_ms: u64,
	pressed:      bool,
	keysym:       u32,
}

fn parse_guac_keystrokes(path: &str) -> io::Result<Vec<KeyEvent>> {
	let file   = File::open(path)?;
	let mut r  = BufReader::new(file);
	let mut events     = Vec::new();
	let mut current_ms = 0u64;

	loop {
		match read_instruction(&mut r) {
			None => break,
			Some((opcode, args)) => match opcode.as_str() {
				"sync" => {
					if let Some(ts) = args.first() {
						if let Ok(ms) = ts.parse::<u64>() {
							current_ms = ms;
						}
					}
				}
				"key" => {
					if args.len() >= 2 {
						let pressed = args[0] == "1";
						if let Ok(ks) = args[1].parse::<u32>() {
							events.push(KeyEvent {
								timestamp_ms: current_ms,
								pressed,
								keysym: ks,
							});
						}
					}
				}
				_ => {}
			},
		}
	}
	Ok(events)
}

/// Read one Guacamole instruction from a `BufRead`.
/// Returns `None` on EOF or parse error.
fn read_instruction(r: &mut impl BufRead) -> Option<(String, Vec<String>)> {
	let mut parts = Vec::new();
	loop {
		// Read the length prefix (decimal digits followed by '.').
		let mut len_s = String::new();
		loop {
			let mut b = [0u8; 1];
			r.read_exact(&mut b).ok()?;
			match b[0] {
				b'0'..=b'9' => len_s.push(b[0] as char),
				b'.'        => break,
				_           => return None,
			}
		}
		let len: usize = len_s.parse().ok()?;

		// Read the string body.
		let mut body = vec![0u8; len];
		r.read_exact(&mut body).ok()?;
		parts.push(String::from_utf8_lossy(&body).into_owned());

		// Read the separator: ',' continues, ';' ends the instruction.
		let mut sep = [0u8; 1];
		r.read_exact(&mut sep).ok()?;
		match sep[0] {
			b',' => continue,
			b';' => break,
			_    => return None,
		}
	}
	if parts.is_empty() { return None; }
	let opcode = parts.remove(0);
	Some((opcode, parts))
}

// ── Keysym → action ───────────────────────────────────────────────────────────

#[derive(Debug)]
enum KeyAction {
	/// A printable character (already modifier-resolved by guacd).
	Print(char),
	/// Delete the last character from the text buffer.
	Backspace,
	/// Hard line break.
	Enter,
	/// Tab character.
	Tab,
	/// Ctrl+X notation, e.g. `^C`.
	Ctrl(char),
	/// Non-printable special key rendered as a label, e.g. `[F1]`, `[→]`.
	Label(&'static str),
	/// Modifier key (Shift, Ctrl, Alt, Meta) — tracked but produces no output.
	Modifier,
	/// Unknown / unmapped keysym — silently ignored.
	Ignore,
}

/// Map an X11 keysym to a [`KeyAction`].
/// `ctrl` indicates whether a Ctrl modifier key is currently held.
fn keysym_to_action(ks: u32, ctrl: bool) -> KeyAction {
	// ── Modifier keys ─────────────────────────────────────────────────────────
	match ks {
		// Shift L/R, Ctrl L/R, Alt L/R, Meta/Super L/R, AltGr, CapsLock, NumLock
		0xffe1 | 0xffe2 | 0xffe3 | 0xffe4 |
		0xffe7 | 0xffe8 | 0xffe9 | 0xffea |
		0xfe03 | 0xffe5 | 0xff7f => return KeyAction::Modifier,
		_ => {}
	}

	// ── Ctrl+key ──────────────────────────────────────────────────────────────
	if ctrl {
		if let Some(c) = char::from_u32(ks) {
			if c.is_ascii_alphabetic() {
				return KeyAction::Ctrl(c.to_ascii_uppercase());
			}
		}
		// Ctrl+2 = ^@ etc — fall through to normal handling
	}

	// ── Printable ASCII (0x20–0x7e) ───────────────────────────────────────────
	if (0x20..=0x7e).contains(&ks) {
		if let Some(c) = char::from_u32(ks) {
			return KeyAction::Print(c);
		}
	}

	// ── Well-known non-printable keysyms ──────────────────────────────────────
	match ks {
		0xff08 => KeyAction::Backspace,
		0xff09 => KeyAction::Tab,
		0xff0d => KeyAction::Enter,
		0xff1b => KeyAction::Label("[Esc]"),
		0xff50 => KeyAction::Label("[Home]"),
		0xff51 => KeyAction::Label("[←]"),
		0xff52 => KeyAction::Label("[↑]"),
		0xff53 => KeyAction::Label("[→]"),
		0xff54 => KeyAction::Label("[↓]"),
		0xff55 => KeyAction::Label("[PgUp]"),
		0xff56 => KeyAction::Label("[PgDn]"),
		0xff57 => KeyAction::Label("[End]"),
		0xff63 => KeyAction::Label("[Ins]"),
		0xffff => KeyAction::Label("[Del]"),
		0xffbe => KeyAction::Label("[F1]"),
		0xffbf => KeyAction::Label("[F2]"),
		0xffc0 => KeyAction::Label("[F3]"),
		0xffc1 => KeyAction::Label("[F4]"),
		0xffc2 => KeyAction::Label("[F5]"),
		0xffc3 => KeyAction::Label("[F6]"),
		0xffc4 => KeyAction::Label("[F7]"),
		0xffc5 => KeyAction::Label("[F8]"),
		0xffc6 => KeyAction::Label("[F9]"),
		0xffc7 => KeyAction::Label("[F10]"),
		0xffc8 => KeyAction::Label("[F11]"),
		0xffc9 => KeyAction::Label("[F12]"),
		// Numpad (with NumLock off these fall through to arrow/nav keys above).
		0xffb0 => KeyAction::Print('0'),
		0xffb1 => KeyAction::Print('1'),
		0xffb2 => KeyAction::Print('2'),
		0xffb3 => KeyAction::Print('3'),
		0xffb4 => KeyAction::Print('4'),
		0xffb5 => KeyAction::Print('5'),
		0xffb6 => KeyAction::Print('6'),
		0xffb7 => KeyAction::Print('7'),
		0xffb8 => KeyAction::Print('8'),
		0xffb9 => KeyAction::Print('9'),
		0xffaa => KeyAction::Print('*'),
		0xffab => KeyAction::Print('+'),
		0xffad => KeyAction::Print('-'),
		0xffae => KeyAction::Print('.'),
		0xffaf => KeyAction::Print('/'),
		0xff8d => KeyAction::Enter,  // numpad Enter
		_ => KeyAction::Ignore,
	}
}

// ── Text reconstruction + segmentation ───────────────────────────────────────

/// A burst of typing bounded by Enter, a long pause, or a maximum length.
#[derive(Debug)]
struct Segment {
	/// Milliseconds from the start of the guac session.
	start_ms: u64,
	end_ms:   u64,
	/// Reconstructed text (Backspace applied, modifiers resolved).
	text:     String,
}

/// Maximum characters per segment before a word-boundary wrap is forced.
const MAX_SEG_CHARS: usize = 72;
/// Milliseconds of inactivity that starts a new segment.
const PAUSE_THRESHOLD_MS: u64 = 2_000;

fn segment_events(events: &[KeyEvent]) -> Vec<Segment> {
	// Track modifier state.
	let mut ctrl  = false;
	// shift is tracked for completeness but keysyms are already modifier-resolved by guacd.
	let mut _shift = false;

	// Text accumulator for the current segment.
	let mut buf       = String::new();
	let mut start_ms  = 0u64;
	let mut last_ms   = 0u64;
	let mut segments  = Vec::new();

	let flush = |buf: &mut String, start_ms: u64, last_ms: u64, segs: &mut Vec<Segment>| {
		let t = buf.trim_end().to_string();
		if !t.is_empty() {
			segs.push(Segment { start_ms, end_ms: last_ms, text: t });
		}
		buf.clear();
	};

	for ev in events {
		// Only act on key-press events.
		if !ev.pressed {
			// Track modifier releases.
			match ev.keysym {
				0xffe3 | 0xffe4 => ctrl  = false,
				0xffe1 | 0xffe2 => _shift = false,
				_ => {}
			}
			continue;
		}

		// Track modifier presses.
		match ev.keysym {
			0xffe3 | 0xffe4 => { ctrl  = true; continue; }
			0xffe1 | 0xffe2 => { _shift = true; continue; }
			0xffe7 | 0xffe8 | 0xffe9 | 0xffea |
			0xfe03 | 0xffe5 | 0xff7f => continue,
			_ => {}
		}

		// Pause detection: flush current segment before starting a new one.
		if !buf.is_empty() && ev.timestamp_ms.saturating_sub(last_ms) >= PAUSE_THRESHOLD_MS {
			flush(&mut buf, start_ms, last_ms, &mut segments);
		}

		if buf.is_empty() {
			start_ms = ev.timestamp_ms;
		}
		last_ms = ev.timestamp_ms;

		match keysym_to_action(ev.keysym, ctrl) {
			KeyAction::Print(c) => {
				buf.push(c);
				// Length-based wrap at word boundary.
				if buf.len() >= MAX_SEG_CHARS {
					if let Some(pos) = buf.rfind(' ') {
						let tail = buf[pos + 1..].to_string();
						buf.truncate(pos);
						flush(&mut buf, start_ms, last_ms, &mut segments);
						buf = tail;
						start_ms = last_ms;
					} else {
						// No space found — hard wrap.
						flush(&mut buf, start_ms, last_ms, &mut segments);
					}
				}
			}
			KeyAction::Tab => {
				buf.push('\t');
			}
			KeyAction::Backspace => {
				// Remove last character if any.
				buf.pop();
			}
			KeyAction::Enter => {
				// Hard break.
				flush(&mut buf, start_ms, last_ms, &mut segments);
			}
			KeyAction::Ctrl(c) => {
				let s = format!("^{}", c);
				buf.push_str(&s);
				// Control signals are short — flush immediately for clarity.
				flush(&mut buf, start_ms, last_ms, &mut segments);
			}
			KeyAction::Label(l) => {
				buf.push_str(l);
			}
			KeyAction::Modifier | KeyAction::Ignore => {}
		}
	}

	// Flush the final segment.
	flush(&mut buf, start_ms, last_ms, &mut segments);
	segments
}

// ── .keys.txt writer ──────────────────────────────────────────────────────────

fn write_keys_txt(
	path:       &str,
	segments:   &[Segment],
	started_ms: u64,
) -> io::Result<()> {
	let mut f = File::create(path)?;
	for seg in segments {
		let offset_ms = seg.start_ms.saturating_sub(started_ms);
		let ts        = format_hms(offset_ms);
		// Wrap long segments at word boundaries for readability.
		let lines = wrap_text(&seg.text, 78);
		let prefix = format!("[{}]  ", ts);
		let indent = " ".repeat(prefix.len());
		for (i, line) in lines.iter().enumerate() {
			if i == 0 {
				writeln!(f, "{}{}", prefix, line)?;
			} else {
				writeln!(f, "{}{}", indent, line)?;
			}
		}
	}
	Ok(())
}

// ── .srt writer ──────────────────────────────────────────────────────────────

/// Maximum characters per subtitle line and maximum lines per entry.
const SRT_LINE_LEN: usize = 45;
const SRT_MAX_LINES: usize = 2;
/// How long (ms) to display a subtitle after its last keystroke.
const SRT_HOLD_MS: u64 = 3_000;

fn write_srt(path: &str, segments: &[Segment]) -> io::Result<()> {
	let mut f     = File::create(path)?;
	let mut index = 1u32;

	for (i, seg) in segments.iter().enumerate() {
		// Split segment text into lines that fit SRT constraints.
		let srt_lines = wrap_text(&seg.text, SRT_LINE_LEN);
		// Chunk into SRT entries of SRT_MAX_LINES each.
		for (chunk_i, chunk) in srt_lines.chunks(SRT_MAX_LINES).enumerate() {
			let start = if chunk_i == 0 {
				seg.start_ms
			} else {
				// Give continued chunks a tiny gap so players don't merge them.
				seg.start_ms + (chunk_i as u64) * 100
			};

			// End time: hold until the next segment (less 100 ms gap) or for
			// SRT_HOLD_MS after the last keystroke in this segment.
			let natural_end = seg.end_ms + SRT_HOLD_MS;
			let end = if let Some(next) = segments.get(i + 1) {
				natural_end.min(next.start_ms.saturating_sub(100))
			} else {
				natural_end
			};
			// Ensure start < end even for very short segments.
			let end = end.max(start + 500);

			writeln!(f, "{}", index)?;
			writeln!(f, "{} --> {}", format_srt_ts(start), format_srt_ts(end))?;
			for line in chunk {
				writeln!(f, "{}", line)?;
			}
			writeln!(f)?;
			index += 1;
		}
	}
	Ok(())
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/// Format milliseconds as `HH:MM:SS.mmm` (for .keys.txt).
fn format_hms(ms: u64) -> String {
	let h   = ms / 3_600_000;
	let m   = (ms % 3_600_000) / 60_000;
	let s   = (ms % 60_000) / 1_000;
	let rem = ms % 1_000;
	format!("{:02}:{:02}:{:02}.{:03}", h, m, s, rem)
}

/// Format milliseconds as `HH:MM:SS,mmm` (SRT timestamp format).
fn format_srt_ts(ms: u64) -> String {
	let h   = ms / 3_600_000;
	let m   = (ms % 3_600_000) / 60_000;
	let s   = (ms % 60_000) / 1_000;
	let rem = ms % 1_000;
	format!("{:02}:{:02}:{:02},{:03}", h, m, s, rem)
}

/// Wrap `text` into lines no longer than `max_len`, breaking at spaces when
/// possible.
fn wrap_text(text: &str, max_len: usize) -> Vec<String> {
	if text.len() <= max_len {
		return if text.is_empty() { vec![] } else { vec![text.to_string()] };
	}
	let mut lines = Vec::new();
	let mut remaining = text;
	while remaining.len() > max_len {
		// Find the last space within the limit.
		let break_at = remaining[..max_len]
			.rfind(' ')
			.map(|p| (p, p + 1))                // break after space
			.unwrap_or((max_len, max_len));       // hard break
		lines.push(remaining[..break_at.0].to_string());
		remaining = &remaining[break_at.1..];
	}
	if !remaining.is_empty() {
		lines.push(remaining.to_string());
	}
	lines
}
