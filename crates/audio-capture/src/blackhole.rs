// BlackHole detection module — T-W.2 (Phase-W BlackHole Setup Wizard).
//
// Surfaces the 4-state `BlackHoleStatus` ladder per `docs/blackhole-wizard-design.md` §1:
//
//   NotInstalled               — covers Swift exit 7 (`experiments/T-0.2/blackhole_capture.swift:166`)
//   InstalledNotConfigured     — device present, no Multi-Output Device contains BH UID
//   Configured                 — Multi-Output Device exists w/ BH in sub-device list
//   Verified { peak, .. }      — set later by T-W.5 verify smoke test (NOT this module)
//
// Probes implemented HERE (T-W.2 ships (a)+(b)+(c); T-W.5 ships (d)):
//   (a) HAL plug-in path exists at /Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver
//   (b) CoreAudio device list contains a device whose name matches /blackhole 2ch/i
//       OR whose UID contains `BlackHole2ch_UID` (mirrors Swift findBlackHole l.144–154)
//   (c) An Aggregate Device with `kAudioAggregateDeviceIsStackedKey=1` exists whose
//       sub-device UID list contains BH UID from (b)
//
// Test seam: the `CoreAudioProbe` trait is the only entry-point to CoreAudio + the filesystem.
// Production impl `RealCoreAudioProbe` uses `coreaudio-sys` (added in Cargo.toml as part of
// T-W.2; the dep-bump is structural — the actual unsafe FFI calls land in T-W.4 once the
// AudioHardwareCreateAggregateDevice path is exercised). Tests use `MockCoreAudio` which
// returns a hand-crafted device table — zero real CoreAudio calls under `cargo test`.

use std::path::Path;

/// HAL plug-in install path. Probe (a) per design §1.
pub const HAL_PLUGIN_PATH: &str = "/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver";

/// Canonical UID substring written by the BlackHole 2ch installer. Probe (b) per design §1.
pub const BLACKHOLE_UID_HINT: &str = "BlackHole2ch_UID";

/// Lower-cased name substring. Probe (b) per design §1.
pub const BLACKHOLE_NAME_HINT_LOWER: &str = "blackhole 2ch";

/// 4-state status ladder per `docs/blackhole-wizard-design.md` §1.
///
/// `Verified` is constructed by T-W.5 (`crates/audio-capture/src/verify.rs`); this module
/// never returns `Verified`. The variant lives here so the type is one closed enum the
/// wizard reducer + Tauri commands can exhaustively match.
#[derive(Debug, Clone, PartialEq)]
pub enum BlackHoleStatus {
    NotInstalled,
    InstalledNotConfigured { blackhole_uid: String },
    Configured { blackhole_uid: String, multi_output_uid: String, multi_output_id: u32 },
    Verified { peak: f32, callback_count: u32 },
}

/// Lightweight projection of a CoreAudio device — only the fields T-W.2 needs.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceInfo {
    pub id: u32,
    pub uid: String,
    pub name: String,
}

/// Lightweight projection of an Aggregate / Multi-Output Device's sub-device list.
#[derive(Debug, Clone, PartialEq)]
pub struct AggregateInfo {
    pub id: u32,
    pub uid: String,
    pub name: String,
    pub is_stacked: bool, // true ⇒ Multi-Output Device, false ⇒ regular Aggregate
    pub sub_device_uids: Vec<String>,
}

/// Test seam. Production impl talks to CoreAudio; tests pass an in-memory mock so no
/// real `AudioObject*` calls fire under `cargo test`.
pub trait CoreAudioProbe {
    /// Probe (a). Returns true iff the HAL plug-in directory exists on disk.
    fn hal_plugin_present(&self) -> bool;

    /// Probe (b) source. All CoreAudio devices currently visible (input + output + aggregate).
    fn enumerate_devices(&self) -> Vec<DeviceInfo>;

    /// Probe (c) source. All Aggregate / Multi-Output Devices with their sub-device UID list.
    fn enumerate_aggregates(&self) -> Vec<AggregateInfo>;
}

/// Locate BlackHole 2ch in a CoreAudio device list.
///
/// Mirrors Swift `findBlackHole` (`experiments/T-0.2/blackhole_capture.swift:144-154`) verbatim
/// modulo language idiom: case-insensitive name match for locale variants OR UID substring.
pub fn find_blackhole(devices: &[DeviceInfo]) -> Option<&DeviceInfo> {
    devices.iter().find(|d| {
        let name_lower = d.name.to_lowercase();
        name_lower.contains(BLACKHOLE_NAME_HINT_LOWER)
            || name_lower.contains("blackhole2ch")
            || d.uid.contains(BLACKHOLE_UID_HINT)
    })
}

/// Locate a Multi-Output Device whose sub-device list includes the supplied BlackHole UID.
///
/// Rejects regular Aggregate Devices (`is_stacked=false`) — those are input-side aggregates and
/// do not route system audio (per design §3 R-W.3 "IsStacked bit semantics"). Only `is_stacked=true`
/// devices count as the wizard's Multi-Output Device.
pub fn find_multi_output_with_blackhole<'a>(
    aggregates: &'a [AggregateInfo],
    blackhole_uid: &str,
) -> Option<&'a AggregateInfo> {
    aggregates.iter().find(|agg| {
        agg.is_stacked
            && agg
                .sub_device_uids
                .iter()
                .any(|uid| uid == blackhole_uid)
    })
}

/// Run probes (a)+(b)+(c) and return the resulting `BlackHoleStatus`.
///
/// Promotion rules:
/// - If neither HAL plug-in nor CoreAudio device sees BlackHole → `NotInstalled`.
/// - If either probe (a) sees the plug-in directory OR probe (b) sees the device but no
///   Multi-Output Device contains it → `InstalledNotConfigured`.
/// - If a Multi-Output Device contains the BlackHole UID → `Configured`.
///
/// `Verified` is exclusively returned by T-W.5 (`verify_capture`); this function does not.
pub fn detect_blackhole<P: CoreAudioProbe>(probe: &P) -> BlackHoleStatus {
    let hal_present = probe.hal_plugin_present();
    let devices = probe.enumerate_devices();
    let blackhole = find_blackhole(&devices);

    let bh_uid = match (hal_present, blackhole) {
        (false, None) => return BlackHoleStatus::NotInstalled,
        // HAL present but device list hasn't refreshed (transient state right after install,
        // before reboot). Treat as InstalledNotConfigured with empty UID — the wizard's
        // "I've installed, retry" branch re-runs detect after CoreAudio re-enumerates.
        (true, None) => return BlackHoleStatus::InstalledNotConfigured {
            blackhole_uid: String::new(),
        },
        (_, Some(d)) => d.uid.clone(),
    };

    let aggregates = probe.enumerate_aggregates();
    match find_multi_output_with_blackhole(&aggregates, &bh_uid) {
        Some(agg) => BlackHoleStatus::Configured {
            blackhole_uid: bh_uid,
            multi_output_uid: agg.uid.clone(),
            multi_output_id: agg.id,
        },
        None => BlackHoleStatus::InstalledNotConfigured {
            blackhole_uid: bh_uid,
        },
    }
}

/// Production probe — wraps real CoreAudio + filesystem calls. Used by the Tauri command
/// `setup_detect_blackhole` (lands in T-W.7). Under `cargo test` nothing constructs this
/// type; tests use `MockCoreAudio` instead.
///
/// The `enumerate_devices` / `enumerate_aggregates` bodies stay TODO-stubbed in T-W.2 because
/// the unsafe `coreaudio-sys` FFI plumbing for AudioObject property reads is shared with T-W.4
/// (`AudioHardwareCreateAggregateDevice`) — keeping the FFI in one module avoids two parallel
/// implementations of the same `cfStringForProperty` helper. T-W.4 fills these in; T-W.7
/// integration tests gate on the filled body.
pub struct RealCoreAudioProbe;

impl Default for RealCoreAudioProbe {
    fn default() -> Self {
        Self
    }
}

impl CoreAudioProbe for RealCoreAudioProbe {
    fn hal_plugin_present(&self) -> bool {
        Path::new(HAL_PLUGIN_PATH).exists()
    }

    fn enumerate_devices(&self) -> Vec<DeviceInfo> {
        // FFI body lands in T-W.4 (shares `cfStringForProperty` helper with the
        // AudioHardwareCreateAggregateDevice path). T-W.2 ships the trait surface +
        // mock-driven tests; production probe returns empty until T-W.4.
        Vec::new()
    }

    fn enumerate_aggregates(&self) -> Vec<AggregateInfo> {
        // Same as above — FFI body lands in T-W.4.
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory CoreAudio mock. Tests construct one with hand-crafted device tables;
    /// no real `AudioObject*` calls fire.
    struct MockCoreAudio {
        hal_present: bool,
        devices: Vec<DeviceInfo>,
        aggregates: Vec<AggregateInfo>,
    }

    impl CoreAudioProbe for MockCoreAudio {
        fn hal_plugin_present(&self) -> bool {
            self.hal_present
        }
        fn enumerate_devices(&self) -> Vec<DeviceInfo> {
            self.devices.clone()
        }
        fn enumerate_aggregates(&self) -> Vec<AggregateInfo> {
            self.aggregates.clone()
        }
    }

    fn dev(id: u32, uid: &str, name: &str) -> DeviceInfo {
        DeviceInfo {
            id,
            uid: uid.to_string(),
            name: name.to_string(),
        }
    }

    fn agg(id: u32, uid: &str, name: &str, is_stacked: bool, subs: &[&str]) -> AggregateInfo {
        AggregateInfo {
            id,
            uid: uid.to_string(),
            name: name.to_string(),
            is_stacked,
            sub_device_uids: subs.iter().map(|s| s.to_string()).collect(),
        }
    }

    // ── Test 1 ───────────────────────────────────────────────────────────────────────────
    #[test]
    fn not_installed_when_neither_hal_nor_device() {
        let probe = MockCoreAudio {
            hal_present: false,
            devices: vec![
                dev(40, "BuiltInSpeakerDevice", "MacBook Pro Speakers"),
                dev(41, "BuiltInMicrophoneDevice", "MacBook Pro Microphone"),
            ],
            aggregates: vec![],
        };
        assert_eq!(detect_blackhole(&probe), BlackHoleStatus::NotInstalled);
    }

    // ── Test 2 ───────────────────────────────────────────────────────────────────────────
    #[test]
    fn installed_when_hal_present_but_not_in_device_list() {
        // Transient post-install / pre-reboot: HAL .driver bundle exists but CoreAudio
        // hasn't loaded the plug-in yet. Should NOT downgrade to NotInstalled.
        let probe = MockCoreAudio {
            hal_present: true,
            devices: vec![dev(40, "BuiltInSpeakerDevice", "MacBook Pro Speakers")],
            aggregates: vec![],
        };
        assert_eq!(
            detect_blackhole(&probe),
            BlackHoleStatus::InstalledNotConfigured {
                blackhole_uid: String::new(),
            }
        );
    }

    // ── Test 3 ───────────────────────────────────────────────────────────────────────────
    #[test]
    fn configured_when_multi_output_includes_bh_uid() {
        let bh_uid = "BlackHole2ch_UID";
        let probe = MockCoreAudio {
            hal_present: true,
            devices: vec![
                dev(40, "BuiltInSpeakerDevice", "MacBook Pro Speakers"),
                dev(99, bh_uid, "BlackHole 2ch"),
            ],
            aggregates: vec![agg(
                500,
                "MeetingCopilotMultiOut",
                "Meeting Copilot Multi-Output",
                true, // is_stacked = 1 ⇒ Multi-Output
                &["BuiltInSpeakerDevice", bh_uid],
            )],
        };
        assert_eq!(
            detect_blackhole(&probe),
            BlackHoleStatus::Configured {
                blackhole_uid: bh_uid.to_string(),
                multi_output_uid: "MeetingCopilotMultiOut".to_string(),
                multi_output_id: 500,
            }
        );
    }

    // ── Test 4 ───────────────────────────────────────────────────────────────────────────
    #[test]
    fn find_blackhole_matches_name_case_insensitive() {
        // Locale-quirk: `BLACKHOLE 2CH` upper-case (some installer locales). Must still match.
        let devices = vec![
            dev(40, "BuiltInSpeakerDevice", "MacBook Pro Speakers"),
            dev(99, "Some_Other_UID", "BLACKHOLE 2CH"),
        ];
        let found = find_blackhole(&devices).expect("uppercase name should match");
        assert_eq!(found.id, 99);
    }

    // ── Test 5 ───────────────────────────────────────────────────────────────────────────
    #[test]
    fn find_blackhole_matches_uid_when_name_unfamiliar() {
        // User has BlackHole installed but renamed it in Audio MIDI Setup. The UID
        // installer-stamp `BlackHole2ch_UID` still wins.
        let devices = vec![
            dev(40, "BuiltInSpeakerDevice", "MacBook Pro Speakers"),
            dev(
                77,
                "BlackHole2ch_UID",
                "My Custom Loopback Renamed By User",
            ),
        ];
        let found = find_blackhole(&devices).expect("UID hint should match even with custom name");
        assert_eq!(found.id, 77);
    }

    // ── Test 6 ───────────────────────────────────────────────────────────────────────────
    #[test]
    fn find_multi_output_rejects_aggregate_without_bh() {
        // Two aggregates exist:
        //   - one is_stacked=true but does NOT contain BH (user has Multi-Output for studio gear).
        //   - one is_stacked=false (regular input Aggregate) that DOES contain BH (Loopback-style setup).
        // Neither qualifies as the wizard's Multi-Output: we need is_stacked=1 AND BH in sub-list.
        let bh_uid = "BlackHole2ch_UID";
        let aggregates = vec![
            agg(
                500,
                "StudioMultiOut",
                "Studio Multi-Output",
                true,
                &["BuiltInSpeakerDevice", "FocusriteScarlettUID"],
            ),
            agg(
                501,
                "RecordingAggregate",
                "Recording Aggregate",
                false, // is_stacked=0 ⇒ regular Aggregate (input), NOT a Multi-Output
                &["BuiltInMicrophoneDevice", bh_uid],
            ),
        ];
        assert!(find_multi_output_with_blackhole(&aggregates, bh_uid).is_none());

        // And just for completeness: when a proper Multi-Output WITH BH exists, we DO find it.
        let aggregates_ok = vec![agg(
            502,
            "MeetingCopilotMultiOut",
            "Meeting Copilot Multi-Output",
            true,
            &["BuiltInSpeakerDevice", bh_uid],
        )];
        let found =
            find_multi_output_with_blackhole(&aggregates_ok, bh_uid).expect("should match");
        assert_eq!(found.id, 502);
    }

    // ── Idempotency / no-regression checks ──────────────────────────────────────────────
    #[test]
    fn detect_is_pure_no_state_mutation_across_calls() {
        // Re-running detect must return identical results. The wizard re-runs detect on
        // every cold-start (R-W.1 mitigation) — any non-determinism here would break that.
        let bh_uid = "BlackHole2ch_UID";
        let probe = MockCoreAudio {
            hal_present: true,
            devices: vec![dev(99, bh_uid, "BlackHole 2ch")],
            aggregates: vec![agg(
                500,
                "MeetingCopilotMultiOut",
                "Meeting Copilot Multi-Output",
                true,
                &["BuiltInSpeakerDevice", bh_uid],
            )],
        };
        let first = detect_blackhole(&probe);
        let second = detect_blackhole(&probe);
        assert_eq!(first, second);
    }

    #[test]
    fn installed_not_configured_when_device_visible_but_no_multi_output() {
        // BlackHole shipped + CoreAudio sees it, but user has NOT yet built the
        // Multi-Output Device. Wizard must promote to Configure step, NOT Verify.
        let bh_uid = "BlackHole2ch_UID";
        let probe = MockCoreAudio {
            hal_present: true,
            devices: vec![
                dev(40, "BuiltInSpeakerDevice", "MacBook Pro Speakers"),
                dev(99, bh_uid, "BlackHole 2ch"),
            ],
            aggregates: vec![], // no aggregates yet
        };
        assert_eq!(
            detect_blackhole(&probe),
            BlackHoleStatus::InstalledNotConfigured {
                blackhole_uid: bh_uid.to_string(),
            }
        );
    }
}
