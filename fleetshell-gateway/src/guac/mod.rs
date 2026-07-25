//! Guacamole protocol implementation — pure MIT, written from the spec.
//!
//! Reference: <https://guacamole.apache.org/doc/gug/guacamole-protocol.html>
//!
//! # Modules
//!
//! | Module | Responsibility |
//! |---|---|
//! | [`protocol`] | Wire-format instruction encoding / decoding |
//! | [`connection`] | guacd TCP connect + opening handshake |

// The public API is intentionally ahead of the callers that will use it.
// Suppress dead-code warnings until the WebSocket handler is wired up.
#![allow(dead_code, unused_imports)]

pub mod connection;
pub mod protocol;

pub use connection::{connect, ConnectionParams, GuacdError, GuacdSession, RdpParams, SshParams, VncParams};
pub use protocol::Instruction;
