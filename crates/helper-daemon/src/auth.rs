// Phase 4 T-4.9 — Embed-token auth store.
//
// Mints scope-bounded + time-bounded tokens for the dashboard iframe embed
// surface (`crate::embed_http`). One token per meeting at any time; minting
// for a meeting that already has a token overwrites the prior record (the
// dashboard re-asks for a fresh token on every `bridge_meeting_start`).
//
// Storage is in-memory only: a `HashMap<MeetingId, TokenRecord>` behind a
// `Mutex`. No disk persistence — daemon restart invalidates all outstanding
// tokens (R-3 mitigation: leaked-token blast radius is bounded by both the
// 5-min TTL **and** the daemon lifetime).
//
// The clock is injected (`Clock = fn() -> Instant`) so the unit tests can
// drive expiry deterministically without `tokio::time::pause`. Production
// uses `Instant::now`.
//
// Wire usage:
//   1. `bridge_meeting_start` → `TokenStore::mint(meeting_id, now)` →
//      returns `Uuid`; daemon embeds the token in `uiUrl`.
//   2. Iframe loads `…?token=<uuid>` → axum handler calls
//      `TokenStore::verify(meeting_id, &uuid, now)` → `Ok(())` lets the
//      handler continue; `Err(_)` maps to 401.
//   3. `bridge_meeting_stop` → `TokenStore::clear(meeting_id)` → next
//      `verify` returns `NotFound`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use thiserror::Error;
use uuid::Uuid;

/// Token TTL — 5 minutes (T-4.9 §3.2). Long enough to absorb iframe load +
/// SSE connect; short enough that a leaked URL is a low-impact incident.
pub const TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

/// Closure type for the injected wall-clock. Production uses `Instant::now`.
pub type Clock = fn() -> Instant;

#[derive(Debug, Clone, PartialEq, Eq)]
struct TokenRecord {
    token: Uuid,
    expires_at: Instant,
}

/// In-memory token store. Cheap to clone (`Arc` your way around the binary
/// entrypoint if you want shared state — the lib's tests construct a fresh
/// store per test).
#[derive(Debug, Default)]
pub struct TokenStore {
    inner: Mutex<HashMap<String, TokenRecord>>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthError {
    #[error("no token issued for meeting {0:?}")]
    NotFound(String),
    #[error("token expired for meeting {0:?}")]
    Expired(String),
    #[error("token mismatch for meeting {0:?}")]
    Mismatch(String),
}

impl TokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a fresh UUID-v4 token for `meeting_id`. Overwrites any prior
    /// token for the same meeting. Returns the freshly-minted token so the
    /// caller can include it in the response payload.
    pub fn mint(&self, meeting_id: &str, now: Instant) -> Uuid {
        let token = Uuid::new_v4();
        let expires_at = now + TOKEN_TTL;
        let mut store = self.inner.lock().expect("token store mutex poisoned");
        store.insert(
            meeting_id.to_string(),
            TokenRecord { token, expires_at },
        );
        token
    }

    /// Verify a `(meeting_id, token)` pair against the store using the
    /// supplied `now` instant for TTL comparison. Returns `Ok(())` on hit;
    /// `Err(AuthError::*)` otherwise.
    pub fn verify(
        &self,
        meeting_id: &str,
        token: &Uuid,
        now: Instant,
    ) -> Result<(), AuthError> {
        let store = self.inner.lock().expect("token store mutex poisoned");
        let Some(record) = store.get(meeting_id) else {
            return Err(AuthError::NotFound(meeting_id.to_string()));
        };
        if record.expires_at <= now {
            return Err(AuthError::Expired(meeting_id.to_string()));
        }
        if record.token != *token {
            return Err(AuthError::Mismatch(meeting_id.to_string()));
        }
        Ok(())
    }

    /// Drop the token for `meeting_id`, if any. Idempotent — clearing a
    /// non-existent meeting is a no-op. Called by `bridge_meeting_stop`.
    pub fn clear(&self, meeting_id: &str) {
        let mut store = self.inner.lock().expect("token store mutex poisoned");
        store.remove(meeting_id);
    }

    /// Snapshot of the active count — diagnostic only. Not stable API.
    pub fn active_count(&self) -> usize {
        let store = self.inner.lock().expect("token store mutex poisoned");
        store.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn t0() -> Instant {
        // Stable anchor for the fake clock — every test starts here so the
        // arithmetic is easy to read.
        Instant::now()
    }

    #[test]
    fn mint_returns_uuid_v4_and_records_ttl() {
        let store = TokenStore::new();
        let now = t0();
        let token = store.mint("m_1", now);
        // UUID v4 has its version nibble = 4 (top 4 bits of byte 6).
        let bytes = token.as_bytes();
        assert_eq!(bytes[6] >> 4, 4, "expected v4 UUID");
        assert_eq!(store.active_count(), 1);
    }

    #[test]
    fn mint_overwrites_prior_token_for_same_meeting() {
        let store = TokenStore::new();
        let now = t0();
        let first = store.mint("m_1", now);
        let second = store.mint("m_1", now);
        assert_ne!(first, second, "fresh mint should yield a fresh UUID");
        // Old token no longer valid.
        assert_eq!(
            store.verify("m_1", &first, now),
            Err(AuthError::Mismatch("m_1".to_string())),
        );
        // New token valid.
        assert!(store.verify("m_1", &second, now).is_ok());
        // Still only one record.
        assert_eq!(store.active_count(), 1);
    }

    #[test]
    fn verify_accepts_within_ttl() {
        let store = TokenStore::new();
        let now = t0();
        let token = store.mint("m_1", now);
        // Just under the TTL boundary.
        let later = now + (TOKEN_TTL - Duration::from_secs(1));
        assert!(store.verify("m_1", &token, later).is_ok());
    }

    #[test]
    fn verify_rejects_after_ttl_expiry() {
        let store = TokenStore::new();
        let now = t0();
        let token = store.mint("m_1", now);
        // Past the TTL boundary.
        let later = now + TOKEN_TTL + Duration::from_secs(1);
        assert_eq!(
            store.verify("m_1", &token, later),
            Err(AuthError::Expired("m_1".to_string())),
        );
    }

    #[test]
    fn verify_rejects_at_exact_ttl_boundary() {
        // Boundary semantics: `expires_at <= now` → rejected. The token is
        // valid on (now, expires_at) open-closed (i.e. expiry is exclusive).
        let store = TokenStore::new();
        let now = t0();
        let token = store.mint("m_1", now);
        let exactly_ttl = now + TOKEN_TTL;
        assert_eq!(
            store.verify("m_1", &token, exactly_ttl),
            Err(AuthError::Expired("m_1".to_string())),
        );
    }

    #[test]
    fn verify_rejects_unknown_meeting() {
        let store = TokenStore::new();
        let now = t0();
        let token = store.mint("m_1", now);
        assert_eq!(
            store.verify("m_2", &token, now),
            Err(AuthError::NotFound("m_2".to_string())),
        );
    }

    #[test]
    fn verify_rejects_scope_mismatch_after_re_mint() {
        let store = TokenStore::new();
        let now = t0();
        let _t1 = store.mint("m_1", now);
        let t2 = store.mint("m_2", now);
        // Token for m_2 must NOT validate against m_1.
        assert_eq!(
            store.verify("m_1", &t2, now),
            Err(AuthError::Mismatch("m_1".to_string())),
        );
    }

    #[test]
    fn verify_rejects_random_token_for_known_meeting() {
        let store = TokenStore::new();
        let now = t0();
        let _real = store.mint("m_1", now);
        let fake = Uuid::new_v4();
        assert_eq!(
            store.verify("m_1", &fake, now),
            Err(AuthError::Mismatch("m_1".to_string())),
        );
    }

    #[test]
    fn clear_removes_entry_and_subsequent_verify_returns_not_found() {
        let store = TokenStore::new();
        let now = t0();
        let token = store.mint("m_1", now);
        assert!(store.verify("m_1", &token, now).is_ok());
        store.clear("m_1");
        assert_eq!(
            store.verify("m_1", &token, now),
            Err(AuthError::NotFound("m_1".to_string())),
        );
        assert_eq!(store.active_count(), 0);
    }

    #[test]
    fn clear_unknown_meeting_is_noop() {
        let store = TokenStore::new();
        store.clear("never-minted");
        assert_eq!(store.active_count(), 0);
    }

    #[test]
    fn mint_for_two_meetings_keeps_both() {
        let store = TokenStore::new();
        let now = t0();
        let t1 = store.mint("m_1", now);
        let t2 = store.mint("m_2", now);
        assert_eq!(store.active_count(), 2);
        assert!(store.verify("m_1", &t1, now).is_ok());
        assert!(store.verify("m_2", &t2, now).is_ok());
        // Cross-pair: m_1's token must NOT verify against m_2.
        assert_eq!(
            store.verify("m_2", &t1, now),
            Err(AuthError::Mismatch("m_2".to_string())),
        );
    }
}
