//! Guacamole protocol instruction encoding and decoding.
//!
//! The wire format is a sequence of length-prefixed elements separated by
//! commas and terminated by a semicolon:
//!
//! ```text
//! LENGTH.ELEMENT,LENGTH.ELEMENT,...;
//! ```
//!
//! `LENGTH` is the number of **UTF-8 bytes** in the element string that
//! follows (not the number of Unicode characters).
//!
//! Example — the `size` instruction with width 1920, height 1080, DPI 96:
//!
//! ```text
//! 4.size,4.1920,4.1080,2.96;
//! ```
//!
//! Because lengths are explicit, element values may safely contain `,` or `;`
//! without ambiguity.
//!
//! Reference: <https://guacamole.apache.org/doc/gug/guacamole-protocol.html>

use std::fmt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

// ── Instruction ───────────────────────────────────────────────────────────────

/// A single Guacamole protocol instruction: one opcode plus zero or more
/// argument strings.
#[derive(Debug, Clone, PartialEq)]
pub struct Instruction {
	pub opcode: String,
	pub args:   Vec<String>,
}

impl Instruction {
	pub fn new(opcode: impl Into<String>, args: Vec<String>) -> Self {
		Self { opcode: opcode.into(), args }
	}

	/// Encode to Guacamole wire format.
	///
	/// ```text
	/// LENGTH.OPCODE,LENGTH.ARG1,...;
	/// ```
	pub fn encode(&self) -> String {
		let mut out = encode_element(&self.opcode);
		for arg in &self.args {
			out.push(',');
			out.push_str(&encode_element(arg));
		}
		out.push(';');
		out
	}
}

/// Encode one element as `LENGTH.VALUE`.
/// `str::len()` returns the number of UTF-8 bytes, matching the spec.
fn encode_element(s: &str) -> String {
	format!("{}.{}", s.len(), s)
}

impl fmt::Display for Instruction {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}", self.encode())
	}
}

// ── I/O helpers ───────────────────────────────────────────────────────────────

/// Write one instruction to `w` and flush.
pub async fn write_instruction<W>(w: &mut W, instr: &Instruction) -> std::io::Result<()>
where
	W: AsyncWriteExt + Unpin,
{
	w.write_all(instr.encode().as_bytes()).await?;
	w.flush().await
}

/// Read one complete instruction from `r`.
///
/// Parses the length-prefix format element-by-element so that values
/// containing `,` or `;` are never mistaken for separators or terminators.
///
/// This function is appropriate for the sequential request-response phase of
/// the guacd handshake.  For high-throughput instruction streaming (WebSocket
/// bridge) a buffered reader should wrap `r` before calling this function.
pub async fn read_instruction<R>(r: &mut R) -> std::io::Result<Instruction>
where
	R: AsyncRead + Unpin,
{
	let mut elements: Vec<String> = Vec::new();

	loop {
		// ── 1. Read the decimal length prefix, terminated by '.' ───────────
		let mut len_digits: Vec<u8> = Vec::with_capacity(8);
		loop {
			let b = read_byte(r).await?;
			match b {
				b'0'..=b'9' => len_digits.push(b),
				b'.' => break,
				other => {
					return Err(std::io::Error::new(
						std::io::ErrorKind::InvalidData,
						format!(
							"expected ASCII digit or '.' in length prefix, got 0x{other:02x}"
						),
					))
				}
			}
		}
		if len_digits.is_empty() {
			return Err(std::io::Error::new(
				std::io::ErrorKind::InvalidData,
				"empty length prefix",
			));
		}
		// SAFETY: every byte in len_digits is an ASCII digit, so from_utf8
		// and parse cannot fail.
		let len: usize = std::str::from_utf8(&len_digits)
			.unwrap()
			.parse()
			.unwrap();

		// ── 2. Read exactly `len` bytes for the element value ───────────────
		let mut value_bytes = vec![0u8; len];
		r.read_exact(&mut value_bytes).await?;
		let value = String::from_utf8(value_bytes).map_err(|e| {
			std::io::Error::new(
				std::io::ErrorKind::InvalidData,
				format!("element is not valid UTF-8: {e}"),
			)
		})?;
		elements.push(value);

		// ── 3. Separator: ',' means another element; ';' ends instruction ───
		match read_byte(r).await? {
			b',' => continue,
			b';' => break,
			other => {
				return Err(std::io::Error::new(
					std::io::ErrorKind::InvalidData,
					format!("expected ',' or ';' after element, got 0x{other:02x}"),
				))
			}
		}
	}

	if elements.is_empty() {
		return Err(std::io::Error::new(
			std::io::ErrorKind::InvalidData,
			"instruction contained no elements",
		));
	}

	Ok(Instruction {
		opcode: elements.remove(0),
		args:   elements,
	})
}

/// Read exactly one byte.
async fn read_byte<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<u8> {
	let mut buf = [0u8; 1];
	r.read_exact(&mut buf).await?;
	Ok(buf[0])
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;

	// ── Encoding ─────────────────────────────────────────────────────────────

	#[test]
	fn encode_no_args() {
		let i = Instruction::new("disconnect", vec![]);
		assert_eq!(i.encode(), "10.disconnect;");
	}

	#[test]
	fn encode_with_args() {
		let i = Instruction::new("size", vec![
			"1920".into(),
			"1080".into(),
			"96".into(),
		]);
		assert_eq!(i.encode(), "4.size,4.1920,4.1080,2.96;");
	}

	#[test]
	fn encode_select_rdp() {
		let i = Instruction::new("select", vec!["rdp".into()]);
		assert_eq!(i.encode(), "6.select,3.rdp;");
	}

	#[test]
	fn encode_empty_arg() {
		// An empty string has length 0 — valid in the Guacamole protocol.
		let i = Instruction::new("connect", vec!["host".into(), "".into()]);
		assert_eq!(i.encode(), "7.connect,4.host,0.;");
	}

	#[test]
	fn encode_arg_with_semicolon() {
		// A ';' inside an argument value is included in the element length,
		// so it must not be encoded any differently.
		let i = Instruction::new("test", vec!["a;b".into()]);
		assert_eq!(i.encode(), "4.test,3.a;b;");
	}

	#[test]
	fn encode_unicode_byte_length() {
		// Length counts UTF-8 bytes, not Unicode scalar values.
		// 'é' is U+00E9 = 0xC3 0xA9 (2 bytes).
		let s = "héllo"; // 6 UTF-8 bytes
		assert_eq!(s.len(), 6);
		let i = Instruction::new("t", vec![s.into()]);
		assert_eq!(i.encode(), "1.t,6.héllo;");
	}

	// ── Decoding ─────────────────────────────────────────────────────────────

	#[tokio::test]
	async fn roundtrip_no_args() {
		let original = Instruction::new("disconnect", vec![]);
		let decoded = decode(original.encode()).await;
		assert_eq!(decoded, original);
	}

	#[tokio::test]
	async fn roundtrip_with_args() {
		let original = Instruction::new("size", vec![
			"1920".into(),
			"1080".into(),
			"96".into(),
		]);
		let decoded = decode(original.encode()).await;
		assert_eq!(decoded, original);
	}

	#[tokio::test]
	async fn roundtrip_empty_arg() {
		let original = Instruction::new("connect", vec!["host".into(), "".into(), "pw".into()]);
		let decoded = decode(original.encode()).await;
		assert_eq!(decoded, original);
	}

	#[tokio::test]
	async fn semicolon_inside_value_is_not_terminator() {
		// The length prefix must prevent ';' inside a value from ending
		// the instruction early.
		let original = Instruction::new("test", vec!["val;ue".into()]);
		let decoded = decode(original.encode()).await;
		assert_eq!(decoded.args[0], "val;ue");
	}

	#[tokio::test]
	async fn comma_inside_value_is_not_separator() {
		let original = Instruction::new("test", vec!["a,b,c".into()]);
		let decoded = decode(original.encode()).await;
		assert_eq!(decoded.args[0], "a,b,c");
	}

	#[tokio::test]
	async fn roundtrip_unicode() {
		let original = Instruction::new("test", vec!["héllo".into()]);
		let decoded = decode(original.encode()).await;
		assert_eq!(decoded.args[0], "héllo");
	}

	/// Read two instructions back-to-back from the same stream; confirms the
	/// reader leaves the cursor positioned exactly at the start of the next
	/// instruction.
	#[tokio::test]
	async fn sequential_reads() {
		let mut buf: Vec<u8> = Vec::new();
		buf.extend_from_slice(
			Instruction::new("select", vec!["rdp".into()]).encode().as_bytes(),
		);
		buf.extend_from_slice(
			Instruction::new("args", vec!["hostname".into(), "port".into()])
				.encode()
				.as_bytes(),
		);
		let mut cursor = std::io::Cursor::new(buf);

		let i1 = read_instruction(&mut cursor).await.unwrap();
		let i2 = read_instruction(&mut cursor).await.unwrap();

		assert_eq!(i1.opcode, "select");
		assert_eq!(i1.args, vec!["rdp"]);
		assert_eq!(i2.opcode, "args");
		assert_eq!(i2.args, vec!["hostname", "port"]);
	}

	#[tokio::test]
	async fn eof_before_instruction_is_error() {
		let mut cursor = std::io::Cursor::new(vec![]);
		let result = read_instruction(&mut cursor).await;
		assert!(result.is_err());
	}

	#[tokio::test]
	async fn truncated_value_is_error() {
		// Length says 5 bytes but only 3 are present.
		let mut cursor = std::io::Cursor::new(b"4.test,5.abc;".to_vec());
		let result = read_instruction(&mut cursor).await;
		assert!(result.is_err());
	}

	// ── Helper ───────────────────────────────────────────────────────────────

	/// Encode an instruction then decode it through the async reader.
	async fn decode(encoded: String) -> Instruction {
		let mut cursor = std::io::Cursor::new(encoded.into_bytes());
		read_instruction(&mut cursor).await.expect("decode failed")
	}
}
