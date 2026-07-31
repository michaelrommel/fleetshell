//! guacrecord — post-process Guacamole session recordings.
//!
//! Watches a single "jobs" directory with inotify.  When the gateway writes a
//! `<conn_id>.json` job file there (signalling that a session recording is
//! complete), guacrecord:
//!
//! 1. Runs `guacenc` to produce an MP4/M4V video from the `.guac` file.
//! 2. Parses the `.guac` instruction stream to extract keystroke events.
//! 3. Reconstructs typed text, segments into bursts.
//! 4. Writes `<recording>.keys.txt` — timestamped plaintext transcript.
//! 5. Writes `<recording>.srt`     — subtitle file for the video player.
//! 6. Writes `<recording>.meta.json` — compact session metadata.
//! 7. Writes `<recording>.zip`     — bundle of m4v + keys + srt + meta.
//! 8. Uploads all six files to S3 under
//!    `guacamole/recordings/<ip>/<YYYY-MM-DD>/` (when GUACD_S3_BUCKET is set).
//! 9. Moves the job JSON to `<jobs>/done/<conn_id>.json`.
//!
//! Usage:
//!   guacrecord <jobs_dir>
//!
//! Environment variables:
//!   GUACD_S3_BUCKET   — S3 bucket name (e.g. dev-s3-fleetshell); S3 upload
//!                       is skipped when unset.
//!   GUACD_S3_REGION   — AWS region; falls back to AWS_REGION / AWS_DEFAULT_REGION.
//!
//! The `done/` sub-directory is created automatically inside `jobs_dir`.
//! Processing failures are logged and never crash the watcher loop.

use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{TimeZone, Utc};
use inotify::{EventMask, Inotify, WatchMask};
use opendal::{Operator, layers::RetryLayer, services::S3};
use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

// ── Job descriptor ────────────────────────────────────────────────────────────

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

// ── Session metadata written alongside the recording ─────────────────────────

#[derive(Debug, Serialize)]
struct SessionMeta<'a> {
	conn_id:      &'a str,
	target:       &'a str,
	protocol:     &'a str,
	user:         Option<&'a str>,
	width:        u32,
	height:       u32,
	started:      String,   // RFC-3339
	ended:        String,
	duration_secs: u64,
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
	// Install ring as the rustls crypto provider for this binary.
	// opendal uses reqwest → rustls; ring keeps us consistent with the
	// rest of the fleetshell-gateway workspace.
	let _ = rustls::crypto::ring::default_provider().install_default();

	let jobs_dir = env::args().nth(1).unwrap_or_else(|| {
		eprintln!("usage: guacrecord <jobs_dir>");
		std::process::exit(1);
	});

	let done_dir = format!("{}/done", jobs_dir);
	fs::create_dir_all(&done_dir)
		.unwrap_or_else(|e| eprintln!("[guacrecord] could not create done dir: {e}"));

	// Build S3 operator once — shared across all processing tasks.
	let op = build_s3_operator();
	match &op {
		Some(_) => eprintln!(
			"[guacrecord] S3 upload enabled → bucket={}",
			env::var("GUACD_S3_BUCKET").unwrap_or_default(),
		),
		None => eprintln!("[guacrecord] GUACD_S3_BUCKET not set — running local-only"),
	}

	// Process any job files that pre-date this startup (e.g. after a restart).
	if let Ok(entries) = fs::read_dir(&jobs_dir) {
		for entry in entries.flatten() {
			let name = entry.file_name().to_string_lossy().to_string();
			if name.ends_with(".json") && !name.starts_with('.') {
				process_job(&jobs_dir, &done_dir, &name, op.as_ref()).await;
			}
		}
	}

	// inotify watches one directory — no per-device watches needed.
	// The blocking read runs in a dedicated thread; filenames are forwarded
	// to the async side via an unbounded channel.
	let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
	let jd = jobs_dir.clone();

	tokio::task::spawn_blocking(move || {
		let mut inotify = Inotify::init().expect("inotify init");
		inotify
			.watches()
			.add(&jd, WatchMask::CLOSE_WRITE | WatchMask::MOVED_TO)
			.expect("inotify watch");
		eprintln!("[guacrecord] watching {jd} for recording jobs");

		let mut buf = [0u8; 4096];
		loop {
			match inotify.read_events_blocking(&mut buf) {
				Ok(events) => {
					for ev in events {
						if ev.mask.contains(EventMask::ISDIR) { continue; }
						if let Some(name) = ev.name {
							let s = name.to_string_lossy().to_string();
							if s.ends_with(".json") && !s.starts_with('.') {
								let _ = tx.send(s);
							}
						}
					}
				}
				Err(e) => eprintln!("[guacrecord] inotify error: {e}"),
			}
		}
	});

	while let Some(filename) = rx.recv().await {
		process_job(&jobs_dir, &done_dir, &filename, op.as_ref()).await;
	}
}

// ── S3 operator ───────────────────────────────────────────────────────────────

/// Build an OpenDAL S3 operator from environment variables.
///
/// Returns `None` when `GUACD_S3_BUCKET` is not set so callers can skip
/// S3 upload transparently.  Credentials are auto-discovered from the ECS
/// task role via `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`.
fn build_s3_operator() -> Option<Operator> {
	let bucket = env::var("GUACD_S3_BUCKET").ok()
		.filter(|s| !s.is_empty())?;

	let region = env::var("GUACD_S3_REGION")
		.or_else(|_| env::var("AWS_REGION"))
		.or_else(|_| env::var("AWS_DEFAULT_REGION"))
		.unwrap_or_else(|_| "us-east-1".to_string());

	let builder = S3::default()
		.bucket(&bucket)
		.region(&region);

	Operator::new(builder)
		.ok()?
		.layer(
			RetryLayer::new()
				.with_max_times(3)
				.with_min_delay(Duration::from_millis(200))
				.with_max_delay(Duration::from_secs(5))
				.with_jitter(),
		)
		.finish()
		.into()
}

// ── Per-job driver ────────────────────────────────────────────────────────────

async fn process_job(
	jobs_dir: &str,
	done_dir: &str,
	filename: &str,
	op:       Option<&Operator>,
) {
	let json_path = format!("{}/{}", jobs_dir, filename);

	let raw = match fs::read_to_string(&json_path) {
		Ok(s)  => s,
		Err(e) => { eprintln!("[guacrecord] read {json_path}: {e}"); return; }
	};
	let job: Job = match serde_json::from_str(&raw) {
		Ok(j)  => j,
		Err(e) => { eprintln!("[guacrecord] parse {json_path}: {e}"); return; }
	};

	let duration_secs = job.ended_ms.saturating_sub(job.started_ms) / 1000;
	eprintln!(
		"[guacrecord] processing conn={} target={} proto={} user={} duration={}s",
		job.conn_id, job.target, job.protocol,
		job.user.as_deref().unwrap_or("?"),
		duration_secs,
	);

	// Derive stem (path without .guac extension) for all sibling files.
	let stem = job.recording.strip_suffix(".guac").unwrap_or(&job.recording);

	// 1. Encode video (guacenc appends .m4v to the full input name;
	//    we rename the result to remove the .guac).
	run_guacenc(&job, stem);

	// 2. Parse keystroke events.
	let events = parse_guac_keystrokes(&job.recording).unwrap_or_default();
	let segments = segment_events(&events);

	// 3. Write text outputs.
	let keys_path = format!("{}.keys.txt", stem);
	let srt_path  = format!("{}.srt",      stem);
	if let Err(e) = write_keys_txt(&keys_path, &segments) {
		eprintln!("[guacrecord] write {keys_path}: {e}");
	} else {
		eprintln!("[guacrecord] wrote {keys_path}");
	}
	if let Err(e) = write_srt(&srt_path, &segments) {
		eprintln!("[guacrecord] write {srt_path}: {e}");
	} else {
		eprintln!("[guacrecord] wrote {srt_path}");
	}

	// 4. Write metadata JSON.
	let meta_path = format!("{}.meta.json", stem);
	if let Err(e) = write_meta_json(&meta_path, &job, duration_secs) {
		eprintln!("[guacrecord] write {meta_path}: {e}");
	} else {
		eprintln!("[guacrecord] wrote {meta_path}");
	}

	// 5. Create ZIP bundle (all files including the raw .guac recording).
	// The .guac is the lossless original and enables browser-based playback
	// via guacamole-common-js SessionRecording; storage cost is bounded by
	// the 90-day retention policy.
	let m4v_path = format!("{}.m4v", stem);
	let zip_path = format!("{}.zip", stem);
	let zip_inputs = [&job.recording, &m4v_path, &keys_path, &srt_path, &meta_path];
	if let Err(e) = create_zip(&zip_path, &zip_inputs) {
		eprintln!("[guacrecord] create zip {zip_path}: {e}");
	} else {
		eprintln!("[guacrecord] wrote {zip_path}");
	}

	// 6. Upload all files to S3.
	if let Some(operator) = op {
		upload_session(operator, &job, stem).await;
	}

	// 7. Move job JSON to done/.
	let done_path = format!("{}/{}", done_dir, filename);
	if let Err(e) = fs::rename(&json_path, &done_path) {
		eprintln!("[guacrecord] move {json_path} → {done_path}: {e}");
	}

	eprintln!("[guacrecord] done conn={}", job.conn_id);
}

// ── guacenc ───────────────────────────────────────────────────────────────────

fn run_guacenc(job: &Job, stem: &str) {
	let guacenc_out = format!("{}.m4v", job.recording);
	let final_out   = format!("{}.m4v", stem);
	let size        = format!("{}x{}", job.width, job.height);

	let status = Command::new("guacenc")
		.args(["-s", &size, &job.recording])
		.status();

	match status {
		Ok(s) if s.success() => {
			if guacenc_out != final_out {
				if let Err(e) = fs::rename(&guacenc_out, &final_out) {
					eprintln!("[guacrecord] rename {guacenc_out} → {final_out}: {e}");
				} else {
					eprintln!("[guacrecord] guacenc → {final_out}");
				}
			} else {
				eprintln!("[guacrecord] guacenc → {final_out}");
			}
		}
		Ok(s)  => eprintln!("[guacrecord] guacenc exited {:?} for {}", s.code(), job.recording),
		Err(e) => eprintln!("[guacrecord] guacenc exec failed: {e}"),
	}
}

// ── Metadata JSON ─────────────────────────────────────────────────────────────

fn write_meta_json(path: &str, job: &Job, duration_secs: u64) -> io::Result<()> {
	let fmt_ms = |ms: u64| {
		Utc.timestamp_millis_opt(ms as i64)
			.single()
			.map(|dt| dt.to_rfc3339())
			.unwrap_or_default()
	};

	let meta = SessionMeta {
		conn_id:      &job.conn_id,
		target:       &job.target,
		protocol:     &job.protocol,
		user:         job.user.as_deref(),
		width:        job.width,
		height:       job.height,
		started:      fmt_ms(job.started_ms),
		ended:        fmt_ms(job.ended_ms),
		duration_secs,
	};

	fs::write(path, serde_json::to_string_pretty(&meta)
		.map_err(|e| io::Error::new(io::ErrorKind::Other, e))?)
}

// ── ZIP bundle ────────────────────────────────────────────────────────────────

fn create_zip(zip_path: &str, inputs: &[&String]) -> io::Result<()> {
	let file    = File::create(zip_path)?;
	let mut zip = ZipWriter::new(file);
	let opts    = SimpleFileOptions::default()
		.compression_method(zip::CompressionMethod::Deflated);

	for path in inputs {
		if !Path::new(path).exists() { continue; }
		let name = Path::new(path)
			.file_name()
			.unwrap_or_default()
			.to_string_lossy();
		zip.start_file(name.as_ref(), opts)?;
		let mut src = File::open(path)?;
		io::copy(&mut src, &mut zip)?;
	}
	zip.finish()?;
	Ok(())
}

// ── S3 upload ─────────────────────────────────────────────────────────────────

async fn upload_session(op: &Operator, job: &Job, stem: &str) {
	// S3 key prefix:  guacamole/recordings/<ip>/YYYY-MM-DD/
	let day = Utc
		.timestamp_millis_opt(job.started_ms as i64)
		.single()
		.unwrap_or_else(Utc::now)
		.format("%Y-%m-%d")
		.to_string();

	let session_name = Path::new(stem)
		.file_name()
		.unwrap_or_default()
		.to_string_lossy()
		.to_string();

	let prefix = format!("guacamole/recordings/{}/{}/", job.target, day);

	// All files to upload; missing ones (e.g. guacenc failed) are skipped.
	let files: &[(&str, &str)] = &[
		(&job.recording,             ".guac"),     // forensic original
		(&format!("{stem}.m4v"),     ".m4v"),      // video
		(&format!("{stem}.keys.txt"),".keys.txt"),  // transcript
		(&format!("{stem}.srt"),     ".srt"),       // subtitles
		(&format!("{stem}.zip"),     ".zip"),       // download bundle
		(&format!("{stem}.meta.json"),".meta.json"),// metadata
	];

	for (local_path, ext) in files {
		if !Path::new(local_path).exists() { continue; }
		let s3_key = format!("{}{}{}", prefix, session_name, ext);
		match upload_file(op, local_path, &s3_key).await {
			Ok(())  => eprintln!("[guacrecord] s3 ← {s3_key}"),
			Err(e)  => eprintln!("[guacrecord] s3 upload failed {local_path}: {e:#}"),
		}
	}
}

/// Stream a local file into S3 via OpenDAL.
///
/// Using a streaming writer avoids loading multi-hundred-MB `.guac`/`.m4v`
/// files fully into memory.  OpenDAL handles multipart upload automatically.
async fn upload_file(op: &Operator, local_path: &str, s3_key: &str) -> Result<()> {
	use tokio::io::AsyncReadExt;

	let mut file   = tokio::fs::File::open(local_path).await
		.with_context(|| format!("open {local_path}"))?;
	let mut writer = op.writer(s3_key).await
		.with_context(|| format!("S3 writer for {s3_key}"))?;

	let mut buf = vec![0u8; 8 * 1024 * 1024]; // 8 MB chunks
	loop {
		let n = file.read(&mut buf).await?;
		if n == 0 { break; }
		writer.write(bytes::Bytes::copy_from_slice(&buf[..n])).await
			.with_context(|| format!("S3 write chunk to {s3_key}"))?;
	}
	writer.close().await
		.with_context(|| format!("S3 close {s3_key}"))?;

	Ok(())
}

// ── Guacamole instruction parser ──────────────────────────────────────────────

#[derive(Debug)]
struct KeyEvent {
	timestamp_ms: u64,
	pressed:      bool,
	keysym:       u32,
}

fn parse_guac_keystrokes(path: &str) -> io::Result<Vec<KeyEvent>> {
	let file   = File::open(path)?;
	let mut r  = BufReader::new(file);
	let mut events    = Vec::new();
	let mut baseline: Option<u64> = None;

	loop {
		match read_instruction(&mut r) {
			None => break,
			Some((opcode, args)) => match opcode.as_str() {
				"sync" => {
					if let Some(ts) = args.first().and_then(|s| s.parse().ok()) {
						baseline.get_or_insert(ts);
					}
				}
				"key" if args.len() >= 3 => {
					if let (Ok(ks), Ok(ts)) = (args[0].parse::<u32>(), args[2].parse::<u64>()) {
						events.push(KeyEvent {
							timestamp_ms: ts,
							pressed:      args[1] == "1",
							keysym:       ks,
						});
					}
				}
				_ => {}
			},
		}
	}

	// Normalise: subtract first sync timestamp so offsets are session-relative.
	let base = baseline.unwrap_or_else(|| events.first().map(|e| e.timestamp_ms).unwrap_or(0));
	for ev in &mut events {
		ev.timestamp_ms = ev.timestamp_ms.saturating_sub(base);
	}
	Ok(events)
}

fn read_instruction(r: &mut impl BufRead) -> Option<(String, Vec<String>)> {
	let mut parts = Vec::new();
	loop {
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
		let mut body = vec![0u8; len];
		r.read_exact(&mut body).ok()?;
		parts.push(String::from_utf8_lossy(&body).into_owned());
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
	Print(char),
	Enter,
	Tab,
	Ctrl(char),
	Label(&'static str),
	Modifier,
	Ignore,
}

fn keysym_to_action(ks: u32, ctrl: bool) -> KeyAction {
	match ks {
		0xffe1 | 0xffe2 | 0xffe3 | 0xffe4 |
		0xffe7 | 0xffe8 | 0xffe9 | 0xffea |
		0xfe03 | 0xffe5 | 0xff7f => return KeyAction::Modifier,
		_ => {}
	}
	if ctrl {
		if let Some(c) = char::from_u32(ks) {
			if c.is_ascii_alphabetic() {
				return KeyAction::Ctrl(c.to_ascii_uppercase());
			}
		}
	}
	if (0x20..=0x7e).contains(&ks) {
		if let Some(c) = char::from_u32(ks) { return KeyAction::Print(c); }
	}
	match ks {
		0xff08 => KeyAction::Label("[\u{232b}]"),
		0xff09 => KeyAction::Tab,
		0xff0d => KeyAction::Enter,
		0xff1b => KeyAction::Label("[Esc]"),
		0xff50 => KeyAction::Label("[Home]"),
		0xff51 => KeyAction::Label("[\u{2190}]"),
		0xff52 => KeyAction::Label("[\u{2191}]"),
		0xff53 => KeyAction::Label("[\u{2192}]"),
		0xff54 => KeyAction::Label("[\u{2193}]"),
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
		0xff8d => KeyAction::Enter,
		_      => KeyAction::Ignore,
	}
}

// ── Segmentation ──────────────────────────────────────────────────────────────

#[derive(Debug)]
struct Segment {
	start_ms: u64,
	end_ms:   u64,
	text:     String,
}

const MAX_SEG_CHARS:    usize = 72;
const PAUSE_THRESHOLD_MS: u64 = 2_000;

fn segment_events(events: &[KeyEvent]) -> Vec<Segment> {
	let mut ctrl   = false;
	let mut _shift = false;
	let mut buf      = String::new();
	let mut start_ms = 0u64;
	let mut last_ms  = 0u64;
	let mut segments = Vec::new();

	let flush = |buf: &mut String, start_ms: u64, last_ms: u64, segs: &mut Vec<Segment>| {
		let t = buf.trim_end().to_string();
		if !t.is_empty() {
			segs.push(Segment { start_ms, end_ms: last_ms, text: t });
		}
		buf.clear();
	};

	for ev in events {
		if !ev.pressed {
			match ev.keysym {
				0xffe3 | 0xffe4 => ctrl   = false,
				0xffe1 | 0xffe2 => _shift = false,
				_ => {}
			}
			continue;
		}
		match ev.keysym {
			0xffe3 | 0xffe4 => { ctrl   = true;  continue; }
			0xffe1 | 0xffe2 => { _shift = true;  continue; }
			0xffe7 | 0xffe8 | 0xffe9 | 0xffea |
			0xfe03 | 0xffe5 | 0xff7f => continue,
			_ => {}
		}

		if !buf.is_empty() && ev.timestamp_ms.saturating_sub(last_ms) >= PAUSE_THRESHOLD_MS {
			flush(&mut buf, start_ms, last_ms, &mut segments);
		}
		if buf.is_empty() { start_ms = ev.timestamp_ms; }
		last_ms = ev.timestamp_ms;

		match keysym_to_action(ev.keysym, ctrl) {
			KeyAction::Print(c) => {
				buf.push(c);
				if buf.chars().count() >= MAX_SEG_CHARS {
					if let Some(pos) = buf.rfind(' ') {
						let tail = buf[pos + 1..].to_string();
						buf.truncate(pos);
						flush(&mut buf, start_ms, last_ms, &mut segments);
						buf = tail;
						start_ms = last_ms;
					} else {
						flush(&mut buf, start_ms, last_ms, &mut segments);
					}
				}
			}
			KeyAction::Tab      => buf.push('\t'),
			KeyAction::Enter    => flush(&mut buf, start_ms, last_ms, &mut segments),
			KeyAction::Ctrl(c)  => {
				buf.push_str(&format!("^{c}"));
				flush(&mut buf, start_ms, last_ms, &mut segments);
			}
			KeyAction::Label(l) => buf.push_str(l),
			KeyAction::Modifier | KeyAction::Ignore => {}
		}
	}
	flush(&mut buf, start_ms, last_ms, &mut segments);
	segments
}

// ── .keys.txt writer ──────────────────────────────────────────────────────────

fn write_keys_txt(path: &str, segments: &[Segment]) -> io::Result<()> {
	let mut f = File::create(path)?;
	for seg in segments {
		let ts     = format_hms(seg.start_ms);
		let lines  = wrap_text(&seg.text, 78);
		let prefix = format!("[{ts}]  ");
		let indent = " ".repeat(prefix.len());
		for (i, line) in lines.iter().enumerate() {
			if i == 0 { writeln!(f, "{prefix}{line}")?; }
			else       { writeln!(f, "{indent}{line}")?; }
		}
	}
	Ok(())
}

// ── .srt writer ───────────────────────────────────────────────────────────────

const SRT_LINE_LEN:  usize = 45;
const SRT_MAX_LINES: usize = 2;
const SRT_HOLD_MS:   u64   = 3_000;

fn write_srt(path: &str, segments: &[Segment]) -> io::Result<()> {
	let mut f     = File::create(path)?;
	let mut index = 1u32;
	for (i, seg) in segments.iter().enumerate() {
		let srt_lines = wrap_text(&seg.text, SRT_LINE_LEN);
		for (ci, chunk) in srt_lines.chunks(SRT_MAX_LINES).enumerate() {
			let start = seg.start_ms + (ci as u64) * 100;
			let natural_end = seg.end_ms + SRT_HOLD_MS;
			let end = segments.get(i + 1)
				.map(|n| natural_end.min(n.start_ms.saturating_sub(100)))
				.unwrap_or(natural_end)
				.max(start + 500);
			writeln!(f, "{index}")?;
			writeln!(f, "{} --> {}", format_srt_ts(start), format_srt_ts(end))?;
			for line in chunk { writeln!(f, "{line}")?; }
			writeln!(f)?;
			index += 1;
		}
	}
	Ok(())
}

// ── Formatting helpers ────────────────────────────────────────────────────────

fn format_hms(ms: u64) -> String {
	let h   = ms / 3_600_000;
	let m   = (ms % 3_600_000) / 60_000;
	let s   = (ms % 60_000) / 1_000;
	let rem = ms % 1_000;
	format!("{h:02}:{m:02}:{s:02}.{rem:03}")
}

fn format_srt_ts(ms: u64) -> String {
	let h   = ms / 3_600_000;
	let m   = (ms % 3_600_000) / 60_000;
	let s   = (ms % 60_000) / 1_000;
	let rem = ms % 1_000;
	format!("{h:02}:{m:02}:{s:02},{rem:03}")
}

fn wrap_text(text: &str, max_len: usize) -> Vec<String> {
	if text.chars().count() <= max_len {
		return if text.is_empty() { vec![] } else { vec![text.to_string()] };
	}
	let mut lines     = Vec::new();
	let mut remaining = text;
	while remaining.chars().count() > max_len {
		let max_byte = remaining
			.char_indices()
			.nth(max_len)
			.map(|(i, _)| i)
			.unwrap_or(remaining.len());
		let (head_end, tail_start) = remaining[..max_byte]
			.rfind(' ')
			.map(|p| (p, p + 1))
			.unwrap_or((max_byte, max_byte));
		if head_end == 0 { break; }
		lines.push(remaining[..head_end].to_string());
		remaining = &remaining[tail_start..];
	}
	if !remaining.is_empty() { lines.push(remaining.to_string()); }
	lines
}
