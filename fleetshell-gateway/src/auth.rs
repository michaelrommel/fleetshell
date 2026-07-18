/// JWT token verification and connection-level authorisation.
///
/// # JWT claims structure
///
/// In addition to the standard `sub` / `iat` / `exp` claims, every token
/// issued for a fleetshell tunnel must carry:
///
/// ```json
/// {
///   "sub":    "alice",
///   "iat":    1784325058,
///   "exp":    1784411458,
///   "target": "192.168.13.187",
///   "ports":  "443,3000-3020",
///   "gw":     "atlanta-01"
/// }
/// ```
///
/// | Claim    | Required | Description |
/// |----------|----------|-------------|
/// | `target` | yes      | Exact destination host this token authorises. |
/// | `ports`  | yes      | Comma-separated ports/ranges the token covers, e.g. `"443,3000-3020"`. Uses the same format as the client's port spec. |
/// | `gw`     | no       | If present, the `gateway` field in the handshake payload must match. Prevents token reuse on a different gateway instance. |

use std::collections::HashSet;

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use thiserror::Error;

// ── Claims ────────────────────────────────────────────────────────────────────

/// Claims decoded from a fleetshell JWT.
#[derive(Debug, Deserialize)]
pub struct Claims {
    /// Subject — user or service identifier.
    pub sub: Option<String>,
    /// Issued-at (Unix timestamp).
    pub iat: Option<u64>,
    /// Expiry (Unix timestamp).
    pub exp: Option<u64>,

    /// Authorised destination host (exact match against the handshake `target`).
    pub target: String,
    /// Authorised port specification: same comma-separated ports/ranges format
    /// the client uses, e.g. `"443"` or `"443,3000-3020"`.
    pub ports: String,
    /// Optional gateway identifier.  When present the handshake `gateway`
    /// field must equal this value, preventing cross-gateway token reuse.
    pub gw: Option<String>,
}

// ── Errors ────────────────────────────────────────────────────────────────────

/// All the ways a connection can be rejected during JWT / claim validation.
#[derive(Debug, Error)]
pub enum AuthError {
    /// The JWT itself is invalid: bad signature, expired, malformed, or
    /// missing the required `target` / `ports` claims.
    #[error("JWT error: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    /// The JWT is valid but the requested target is not covered by the token.
    #[error("target mismatch: token authorises '{allowed}', request asks for '{requested}'")]
    TargetMismatch { allowed: String, requested: String },

    /// The JWT is valid but the requested port is not in the token's port spec.
    #[error("port {port} is not authorised by this token (allowed: \"{allowed_spec}\")")]
    PortNotAllowed { port: u16, allowed_spec: String },

    /// The JWT carries a `gw` claim that does not match the gateway the
    /// client actually connected to.
    #[error("gateway mismatch: token is bound to '{allowed}', client sent '{requested}'")]
    GatewayMismatch { allowed: String, requested: String },
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Verify the JWT signature + expiry, then check that `req_target`,
/// `req_port`, and `req_gateway` are all authorised by the embedded claims.
///
/// Returns the decoded [`Claims`] on success.  The caller should log the
/// claims for audit purposes; the token value itself must not be logged.
pub fn verify_connection(
    token:       &str,
    secret:      &str,
    req_target:  &str,
    req_port:    u16,
    req_gateway: &str,
) -> Result<Claims, AuthError> {
    // ── 1. Signature + expiry ─────────────────────────────────────────────
    let claims = decode_token(token, secret)?;

    // ── 2. Target must match exactly ──────────────────────────────────────
    if claims.target != req_target {
        return Err(AuthError::TargetMismatch {
            allowed:   claims.target.clone(),
            requested: req_target.to_string(),
        });
    }

    // ── 3. Port must fall within the authorised spec ───────────────────────
    if !port_in_spec(&claims.ports, req_port) {
        return Err(AuthError::PortNotAllowed {
            port:         req_port,
            allowed_spec: claims.ports.clone(),
        });
    }

    // ── 4. Gateway binding (optional claim) ───────────────────────────────
    if let Some(ref allowed_gw) = claims.gw {
        if allowed_gw != req_gateway {
            return Err(AuthError::GatewayMismatch {
                allowed:   allowed_gw.clone(),
                requested: req_gateway.to_string(),
            });
        }
    }

    Ok(claims)
}

// ── Internals ─────────────────────────────────────────────────────────────────

/// Decode and verify signature + expiry.  Does not check custom claims.
///
/// `target` and `ports` are non-optional fields in [`Claims`]; serde will
/// return a deserialisation error (surfaced as [`AuthError::Jwt`]) if either
/// is absent from the token.
fn decode_token(token: &str, secret: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let mut validation = Validation::new(Algorithm::HS256);
    // No standard claims are required beyond what we check ourselves.
    validation.required_spec_claims = HashSet::new();
    // Honour expiry when present; tokens without `exp` are accepted.
    validation.validate_exp = true;

    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )?;

    Ok(data.claims)
}

/// Return `true` if `port` is covered by `spec`.
///
/// `spec` is a comma-separated list of individual ports and inclusive ranges,
/// e.g. `"443"`, `"443,3000-3020"`, `"80,8080,9000-9100"`.
/// Invalid tokens in the spec are silently skipped.
fn port_in_spec(spec: &str, port: u16) -> bool {
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((start, end)) = part.split_once('-') {
            if let (Ok(s), Ok(e)) = (start.trim().parse::<u16>(), end.trim().parse::<u16>()) {
                if s <= port && port <= e {
                    return true;
                }
            }
        } else if let Ok(p) = part.parse::<u16>() {
            if p == port {
                return true;
            }
        }
    }
    false
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::port_in_spec;

    #[test]
    fn single_port_match() {
        assert!(port_in_spec("443", 443));
        assert!(!port_in_spec("443", 80));
    }

    #[test]
    fn range_match() {
        assert!(port_in_spec("3000-3020", 3000));
        assert!(port_in_spec("3000-3020", 3010));
        assert!(port_in_spec("3000-3020", 3020));
        assert!(!port_in_spec("3000-3020", 2999));
        assert!(!port_in_spec("3000-3020", 3021));
    }

    #[test]
    fn mixed_spec() {
        let spec = "443,3000-3020,8080";
        assert!(port_in_spec(spec, 443));
        assert!(port_in_spec(spec, 3005));
        assert!(port_in_spec(spec, 8080));
        assert!(!port_in_spec(spec, 80));
        assert!(!port_in_spec(spec, 3021));
    }
}
