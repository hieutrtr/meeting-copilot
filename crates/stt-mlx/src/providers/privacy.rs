// Phase 3 T-3.8 — Backend privacy mode enforcement.
//
// ARCH §11 (lines 395–408) — three-mode constraint matrix mirrored from
// `src/privacy/privacyMode.ts`. The Rust side is a *second gate*: the UI
// disables disallowed picker options + auto-reverts the settings store, but
// any caller that bypasses the UI (direct `factory()` call, future Tauri
// command, hand-edited `localStorage`) MUST still be blocked here.
//
// Short-circuit semantics: `factory_with_privacy(mode, kind, cfg)` returns
// `FactoryError::PrivacyModeViolation` *before* `factory()` runs — so a
// disallowed combination never opens a WS handshake, never reads an API key,
// never spawns a subprocess. Privacy-by-construction at the seam.
//
// Parity gate: `is_provider_allowed(PrivacyMode::Cloud, *)` must be `true` for
// every `ProviderKind` variant; the matching TS gate is `PM-S23`. Drift in
// either direction breaks the whole picker UX.

use crate::provider::SttProvider;

use super::{factory, FactoryError, ProviderConfig, ProviderKind};

/// Privacy mode — see `src/privacy/privacyMode.ts` for the user-facing IDs.
/// `as_str()` matches the TS literals exactly so settings persistence
/// round-trips cleanly between the two surfaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PrivacyMode {
    /// "local-first" — STT MLX only, audio never leaves the machine. Default.
    LocalFirst,
    /// "cloud" — STT may be Deepgram or ElevenLabs; full audio goes to provider.
    Cloud,
    /// "mixed" — STT is local (MLX); cloud is allowed for TTS only (separate seam).
    Mixed,
}

impl PrivacyMode {
    /// Stable string ID — must match the TS `PrivacyMode` literals.
    /// Drift breaks the v2 settings round-trip.
    pub fn as_str(&self) -> &'static str {
        match self {
            PrivacyMode::LocalFirst => "local-first",
            PrivacyMode::Cloud => "cloud",
            PrivacyMode::Mixed => "mixed",
        }
    }

    /// Default mode for new installs — matches `DEFAULT_PRIVACY_MODE` in TS.
    pub fn default_mode() -> Self {
        PrivacyMode::LocalFirst
    }
}

/// Pure constraint matrix. Mirrors `src/privacy/privacyMode.ts::isSttProviderAllowed`.
///
/// Match is exhaustive — adding a new `ProviderKind` variant is a compile error
/// here, forcing the TS + Rust matrices to be updated together.
pub fn is_provider_allowed(mode: PrivacyMode, kind: ProviderKind) -> bool {
    match (mode, kind) {
        // MLX + Fake are local stubs / local model — always allowed.
        (_, ProviderKind::Mlx) | (_, ProviderKind::Fake) => true,
        // Cloud STT (Deepgram, ElevenLabs Scribe) only allowed under Cloud mode.
        (PrivacyMode::Cloud, ProviderKind::Deepgram) => true,
        (PrivacyMode::Cloud, ProviderKind::ElevenLabs) => true,
        // LocalFirst and Mixed both block cloud STT (Mixed = local STT + cloud TTS only,
        // per ARCH §11 line 403).
        (PrivacyMode::LocalFirst, ProviderKind::Deepgram) => false,
        (PrivacyMode::LocalFirst, ProviderKind::ElevenLabs) => false,
        (PrivacyMode::Mixed, ProviderKind::Deepgram) => false,
        (PrivacyMode::Mixed, ProviderKind::ElevenLabs) => false,
    }
}

/// Factory wrapper that enforces the privacy-mode constraint matrix BEFORE
/// constructing the underlying provider. A disallowed `(mode, kind)` pair
/// returns `FactoryError::PrivacyModeViolation` — the test gate for this is
/// `factory_with_privacy_short_circuits_before_construction`, which passes a
/// config with a missing API key and asserts the privacy error wins (no
/// handshake / `SttError::Config` ever surfaces).
pub fn factory_with_privacy(
    mode: PrivacyMode,
    kind: ProviderKind,
    cfg: ProviderConfig,
) -> Result<Box<dyn SttProvider>, FactoryError> {
    if !is_provider_allowed(mode, kind) {
        return Err(FactoryError::PrivacyModeViolation { mode, kind });
    }
    factory(kind, cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::FakeConfig;

    #[test]
    fn privacy_mode_as_str_stable() {
        // Drift here breaks the settings v2 schema round-trip with TS.
        assert_eq!(PrivacyMode::LocalFirst.as_str(), "local-first");
        assert_eq!(PrivacyMode::Cloud.as_str(), "cloud");
        assert_eq!(PrivacyMode::Mixed.as_str(), "mixed");
    }

    #[test]
    fn privacy_mode_default_is_local_first() {
        assert_eq!(PrivacyMode::default_mode(), PrivacyMode::LocalFirst);
    }

    /// 3-cell row for LocalFirst — only local providers allowed.
    #[test]
    fn matrix_local_first_only_local_stt() {
        assert!(is_provider_allowed(PrivacyMode::LocalFirst, ProviderKind::Mlx));
        assert!(is_provider_allowed(PrivacyMode::LocalFirst, ProviderKind::Fake));
        assert!(!is_provider_allowed(
            PrivacyMode::LocalFirst,
            ProviderKind::Deepgram
        ));
        assert!(!is_provider_allowed(
            PrivacyMode::LocalFirst,
            ProviderKind::ElevenLabs
        ));
    }

    /// 4-cell row for Cloud — every provider allowed (parity-gate with TS PM-S23).
    #[test]
    fn matrix_cloud_allows_all() {
        for kind in [
            ProviderKind::Mlx,
            ProviderKind::Fake,
            ProviderKind::Deepgram,
            ProviderKind::ElevenLabs,
        ] {
            assert!(
                is_provider_allowed(PrivacyMode::Cloud, kind),
                "Cloud should allow {:?}",
                kind
            );
        }
    }

    /// 3-cell row for Mixed — local STT only (per ARCH §11 line 403).
    #[test]
    fn matrix_mixed_local_stt_only() {
        assert!(is_provider_allowed(PrivacyMode::Mixed, ProviderKind::Mlx));
        assert!(is_provider_allowed(PrivacyMode::Mixed, ProviderKind::Fake));
        assert!(!is_provider_allowed(PrivacyMode::Mixed, ProviderKind::Deepgram));
        assert!(!is_provider_allowed(PrivacyMode::Mixed, ProviderKind::ElevenLabs));
    }

    /// Parity gate — every `ProviderKind` variant is allowed under Cloud. This
    /// is the Rust mirror of TS `PM-S23` (`STT_PROVIDER_IDS` ⊂ Cloud allow-set).
    #[test]
    fn matrix_cloud_is_superset_of_provider_kinds() {
        // If a new ProviderKind variant is added without updating the matrix,
        // the exhaustive match in `is_provider_allowed` is a compile error.
        // This test asserts the runtime allow-set agrees with that compile-time
        // enforcement.
        for kind in [
            ProviderKind::Mlx,
            ProviderKind::Fake,
            ProviderKind::Deepgram,
            ProviderKind::ElevenLabs,
        ] {
            assert!(is_provider_allowed(PrivacyMode::Cloud, kind));
        }
    }

    /// Fake provider always allowed — mirrors TS PM-S12.
    #[test]
    fn factory_with_privacy_fake_always_allowed() {
        for mode in [
            PrivacyMode::LocalFirst,
            PrivacyMode::Cloud,
            PrivacyMode::Mixed,
        ] {
            let cfg = ProviderConfig::Fake(FakeConfig::default());
            let p = factory_with_privacy(mode, ProviderKind::Fake, cfg)
                .expect("Fake should be allowed in every mode");
            assert_eq!(p.name(), "fake");
        }
    }

    /// Critical privacy gate: a disallowed (mode, kind) MUST short-circuit
    /// before construction so no API-key / handshake side-effect happens.
    ///
    /// The Deepgram adapter is feature-gated; this test only runs when the
    /// feature is enabled. The construction would normally fail with
    /// `SttError::Config("DEEPGRAM_API_KEY missing")` for a `None` key —
    /// we assert the privacy error wins instead.
    #[cfg(feature = "deepgram")]
    #[test]
    fn factory_with_privacy_short_circuits_before_construction_deepgram() {
        use super::super::DeepgramConfig;
        use super::super::BackoffConfig;

        // Config has no API key — would normally produce SttError::Config.
        let cfg = ProviderConfig::Deepgram(DeepgramConfig {
            api_key: None,
            url: "ws://127.0.0.1:1/v1/listen".into(),
            read_drain_timeout: std::time::Duration::from_millis(10),
            backoff: BackoffConfig::default(),
        });
        // LocalFirst + Deepgram is disallowed — privacy error must win.
        let err = factory_with_privacy(
            PrivacyMode::LocalFirst,
            ProviderKind::Deepgram,
            cfg,
        )
        .expect_err("LocalFirst + Deepgram must be rejected");
        match err {
            FactoryError::PrivacyModeViolation { mode, kind } => {
                assert_eq!(mode, PrivacyMode::LocalFirst);
                assert_eq!(kind, ProviderKind::Deepgram);
            }
            other => panic!(
                "expected PrivacyModeViolation, got {other:?} — \
                 privacy gate must short-circuit before construction"
            ),
        }
    }

    /// Mirror short-circuit gate for ElevenLabs.
    #[cfg(feature = "elevenlabs")]
    #[test]
    fn factory_with_privacy_short_circuits_before_construction_elevenlabs() {
        use super::super::ElevenLabsConfig;
        use super::super::BackoffConfig;

        let cfg = ProviderConfig::ElevenLabs(ElevenLabsConfig {
            api_key: None,
            url: "ws://127.0.0.1:1/v1/speech-to-text/scribe-v1/stream".into(),
            read_drain_timeout: std::time::Duration::from_millis(10),
            backoff: BackoffConfig::default(),
        });
        let err = factory_with_privacy(
            PrivacyMode::Mixed,
            ProviderKind::ElevenLabs,
            cfg,
        )
        .expect_err("Mixed + ElevenLabs must be rejected");
        match err {
            FactoryError::PrivacyModeViolation { mode, kind } => {
                assert_eq!(mode, PrivacyMode::Mixed);
                assert_eq!(kind, ProviderKind::ElevenLabs);
            }
            other => panic!("expected PrivacyModeViolation, got {other:?}"),
        }
    }

    /// Pass-through: an allowed (Cloud + Deepgram) with a valid key returns
    /// a real adapter. Construction succeeds; behavior is identical to a
    /// direct `factory()` call.
    #[cfg(feature = "deepgram")]
    #[test]
    fn factory_with_privacy_passes_through_when_allowed() {
        use super::super::DeepgramConfig;
        use super::super::BackoffConfig;

        let cfg = ProviderConfig::Deepgram(DeepgramConfig {
            api_key: Some("test-key".into()),
            url: "ws://127.0.0.1:1/v1/listen".into(),
            read_drain_timeout: std::time::Duration::from_millis(10),
            backoff: BackoffConfig::default(),
        });
        let p = factory_with_privacy(
            PrivacyMode::Cloud,
            ProviderKind::Deepgram,
            cfg,
        )
        .expect("Cloud + Deepgram with valid key must construct");
        assert_eq!(p.name(), "deepgram");
    }
}
