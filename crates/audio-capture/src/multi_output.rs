// T-W.4 — CoreAudio Multi-Output Device configurator. Phase-W BlackHole Setup Wizard.
//
// Locks down `docs/blackhole-wizard-design.md` §3 "Configure CFDictionary blueprint":
//
//   AudioHardwareCreateAggregateDevice(description: CFDictionaryRef,
//                                      deviceID: AudioDeviceID*) → OSStatus
//
// where `description` is a CFDictionary with five keys:
//
//   kAudioAggregateDeviceUIDKey            = "MeetingCopilotMultiOut"  (CFString — our brand)
//   kAudioAggregateDeviceNameKey           = <user-visible label>      (CFString)
//   kAudioAggregateDeviceMasterSubDeviceKey= <built-in output UID>     (CFString — clock master)
//   kAudioAggregateDeviceSubDeviceListKey  = [{kAudioSubDeviceUIDKey:built_in},
//                                             {kAudioSubDeviceUIDKey:bh_uid}]
//   kAudioAggregateDeviceIsStackedKey      = 1                          (CFNumber)
//
// THE GOTCHA — design §3 + R-W.3: `kAudioAggregateDeviceIsStackedKey = 1` creates a
// Multi-Output Device (audio fans out to ALL sub-devices, what the meeting needs).
// `0` creates a regular Aggregate Device (sub-devices feed input streams). Setting
// the wrong value silently breaks capture: user hears their meeting on built-in
// speakers but the BlackHole 2ch leg gets no signal → transcription gets nothing.
// `is_stacked_key_is_1_for_multi_output_not_0` is a BLOCKING regression guard
// asserting both this bit and that we never accidentally use the `0` constant.
//
// Idempotency contract — design §3:
//   1. enumerate_aggregates() → look for existing device with UID="MeetingCopilotMultiOut"
//   2. if found and is_stacked AND sub-list contains all required UIDs → return existing ID
//      (no AudioHardware* call)
//   3. otherwise → AudioHardwareCreateAggregateDevice(build_dict(...), &mut id) → return id
//
// Idempotency is critical because (a) the wizard re-runs detect on every cold-start
// (R-W.1 mitigation — Aggregate Devices are *transient*, lost at reboot, must be
// recreated) and (b) the user may quit/relaunch the wizard mid-flow. Re-running the
// configurator must NEVER duplicate the device.
//
// Test seam — `AggregateDeviceCreator` trait. Production impl `RealAggregateDeviceCreator`
// wraps the `unsafe` FFI to `AudioHardwareCreateAggregateDevice`; tests inject
// `MockCreator` which records the dict for shape + key assertions and pops a queued
// AudioDeviceID response. Idempotency is exercised through the existing
// `CoreAudioProbe` seam from T-W.2 — we call `enumerate_aggregates()` to detect a
// pre-existing device.
//
// Note on FFI body: the `unsafe` call to `AudioHardwareCreateAggregateDevice` lands
// in T-W.7 (the Tauri command wrapper) because (a) the same `cfStringForProperty`
// helper has to be shared with `RealCoreAudioProbe::enumerate_devices` and
// `enumerate_aggregates` (T-W.2 deferred its FFI body to T-W.4 / T-W.7 to keep one
// owner of the unsafe block) and (b) the loop sandbox lacks `cargo` and the macOS
// CoreAudio toolchain, so the FFI cannot be runtime-verified here. T-W.4 ships the
// safe core and the test seam; T-W.7 fills `RealAggregateDeviceCreator::create` with
// the matching `unsafe` block.

use std::collections::BTreeMap;

use thiserror::Error;

use crate::blackhole::{AggregateInfo, CoreAudioProbe, BLACKHOLE_NAME_HINT_LOWER, BLACKHOLE_UID_HINT};

/// CoreAudio device id alias. Public so callers can route the returned id into
/// `cpal::Device` / verification capture without re-importing `coreaudio-sys`.
pub type AudioDeviceID = u32;

/// Brand UID for the wizard's Multi-Output Device. Single source of truth — the
/// idempotency probe (`find_existing_multi_out`) and the dict builder both read
/// this constant, so renaming here renames everywhere.
pub const MEETING_COPILOT_MULTI_OUT_UID: &str = "MeetingCopilotMultiOut";

/// User-visible name surfaced in the macOS Sound preferences pane and the Audio
/// MIDI Setup app. Default supplied to `create_multi_output(...)` callers; the
/// wizard may override but typically takes the default.
pub const MEETING_COPILOT_MULTI_OUT_NAME: &str = "Meeting Copilot Multi-Output";

// ── CFDictionary keys (mirror `<CoreAudio/AudioHardware.h>` C constants) ────────
//
// We use the canonical Apple key strings as our test-friendly map keys. Mapping
// them to the real `kAudioAggregateDevice*Key` `CFStringRef` constants is a
// 5-line lookup table inside `RealAggregateDeviceCreator` (T-W.7 unsafe body).

/// `kAudioAggregateDeviceUIDKey` (CFString).
pub const KEY_UID: &str = "kAudioAggregateDeviceUIDKey";
/// `kAudioAggregateDeviceNameKey` (CFString).
pub const KEY_NAME: &str = "kAudioAggregateDeviceNameKey";
/// `kAudioAggregateDeviceMasterSubDeviceKey` (CFString).
pub const KEY_MASTER_SUB_DEVICE: &str = "kAudioAggregateDeviceMasterSubDeviceKey";
/// `kAudioAggregateDeviceSubDeviceListKey` (CFArray of CFDictionary).
pub const KEY_SUB_DEVICE_LIST: &str = "kAudioAggregateDeviceSubDeviceListKey";
/// `kAudioAggregateDeviceIsStackedKey` (CFNumber, 1 = Multi-Output, 0 = Aggregate).
pub const KEY_IS_STACKED: &str = "kAudioAggregateDeviceIsStackedKey";
/// `kAudioSubDeviceUIDKey` — used inside each sub-device dict.
pub const KEY_SUB_DEVICE_UID: &str = "kAudioSubDeviceUIDKey";

/// IsStacked bit value for Multi-Output Device (the one the wizard creates).
/// **Do not change this without updating `is_stacked_key_is_1_for_multi_output_not_0`.**
pub const IS_STACKED_MULTI_OUTPUT: i64 = 1;

/// IsStacked bit value for a regular Aggregate Device (NOT what the wizard creates).
/// Defined here for completeness + the regression test assertion.
pub const IS_STACKED_AGGREGATE: i64 = 0;

/// Test-friendly representation of a CFDictionary value. Production code hands
/// this to a small builder that walks the tree and produces real `CFType` values
/// for the `AudioHardwareCreateAggregateDevice` call (lands T-W.7); tests inspect
/// it directly for key + shape assertions.
#[derive(Debug, Clone, PartialEq)]
pub enum DictValue {
    String(String),
    Integer(i64),
    Array(Vec<DictValue>),
    Dict(BTreeMap<String, DictValue>),
}

/// Alias for the top-level dict shape passed to `AggregateDeviceCreator::create`.
pub type DeviceDict = BTreeMap<String, DictValue>;

#[derive(Debug, Error, PartialEq)]
pub enum ConfigureError {
    /// The supplied `sub_device_uids` slice does not contain a UID matching the
    /// BlackHole 2ch installer stamp. Without BlackHole in the Multi-Output, the
    /// wizard's whole capture path is broken — fail loud.
    #[error("BlackHole 2ch UID not present in sub-device list")]
    BlackHoleNotInSubDevices,

    /// Sub-device list has fewer than 2 entries. A Multi-Output Device with one
    /// sub-device is just that sub-device — degenerate. The wizard always passes
    /// at least `[built_in_output, blackhole]`.
    #[error("sub-device list must contain at least 2 devices (built-in output + BlackHole)")]
    InsufficientSubDevices,

    /// `AudioHardwareCreateAggregateDevice` returned a non-zero `OSStatus`. The
    /// status code is preserved verbatim so the wizard can surface the macOS
    /// four-char-code (e.g. `'!obj'` = `kAudioHardwareBadObjectError`) for
    /// debugging.
    #[error("AudioHardwareCreateAggregateDevice failed (OSStatus {status})")]
    CoreAudioFailed { status: i32 },
}

/// Test seam — issues the actual `AudioHardwareCreateAggregateDevice` call.
///
/// Production impl `RealAggregateDeviceCreator` wraps the unsafe FFI; tests use
/// `MockCreator` which records the dict for assertions and returns a queued ID.
pub trait AggregateDeviceCreator {
    /// Returns the new device's id on success, or the raw `OSStatus` (i32) on
    /// failure. The thin `i32` here keeps the trait FFI-friendly; the safe
    /// wrapper `create_multi_output` lifts it to `ConfigureError::CoreAudioFailed`.
    fn create(&self, dict: &DeviceDict) -> Result<AudioDeviceID, i32>;
}

/// Production creator. The `unsafe` FFI body to `AudioHardwareCreateAggregateDevice`
/// lands in T-W.7 alongside the matching `RealCoreAudioProbe::enumerate_devices` /
/// `enumerate_aggregates` FFI bodies (shared `cfStringForProperty` helper — see
/// `crates/audio-capture/src/blackhole.rs` line 153 note).
///
/// In the meantime this returns a sentinel error so any accidental real-call from
/// `cargo test --workspace` (e.g. via a forgotten production-impl test) trips
/// fast instead of silently calling out to CoreAudio on a CI host that may not
/// have the right entitlements.
#[derive(Debug, Default)]
pub struct RealAggregateDeviceCreator;

impl AggregateDeviceCreator for RealAggregateDeviceCreator {
    fn create(&self, _dict: &DeviceDict) -> Result<AudioDeviceID, i32> {
        // -1 ≈ kAudioHardwareUnspecifiedError; T-W.7 replaces this with the real
        // `AudioHardwareCreateAggregateDevice(...)` call. Documented in the module
        // header above and in T-W.4 review §"Hand-Off Notes for T-W.7".
        Err(-1)
    }
}

/// Lightweight UID-shape probe — does this UID look like the BlackHole 2ch installer
/// stamp? Mirrors the `find_blackhole` matcher in `blackhole.rs`. We DO NOT have
/// the installer's authoritative UID format documented anywhere except the binary —
/// the substring match handles renames + locale variations.
pub fn looks_like_blackhole_uid(uid: &str) -> bool {
    let lc = uid.to_lowercase();
    uid.contains(BLACKHOLE_UID_HINT)
        || lc.contains("blackhole2ch")
        || lc.contains(BLACKHOLE_NAME_HINT_LOWER)
}

/// Build the CFDictionary description passed to `AudioHardwareCreateAggregateDevice`.
///
/// Layout per design §3:
///
/// ```text
/// {
///   kAudioAggregateDeviceUIDKey:             "MeetingCopilotMultiOut",
///   kAudioAggregateDeviceNameKey:            <name>,
///   kAudioAggregateDeviceMasterSubDeviceKey: <master_uid>,
///   kAudioAggregateDeviceSubDeviceListKey: [
///     { kAudioSubDeviceUIDKey: sub_device_uids[0] },
///     { kAudioSubDeviceUIDKey: sub_device_uids[1] },
///     ...
///   ],
///   kAudioAggregateDeviceIsStackedKey:       1,
/// }
/// ```
///
/// The function is `pub` so tests + the T-W.7 FFI wrapper share one builder.
pub fn build_aggregate_dict(name: &str, master_uid: &str, sub_device_uids: &[&str]) -> DeviceDict {
    let mut dict: DeviceDict = BTreeMap::new();
    dict.insert(
        KEY_UID.to_string(),
        DictValue::String(MEETING_COPILOT_MULTI_OUT_UID.to_string()),
    );
    dict.insert(KEY_NAME.to_string(), DictValue::String(name.to_string()));
    dict.insert(
        KEY_MASTER_SUB_DEVICE.to_string(),
        DictValue::String(master_uid.to_string()),
    );
    dict.insert(
        KEY_IS_STACKED.to_string(),
        DictValue::Integer(IS_STACKED_MULTI_OUTPUT),
    );
    let sub_list: Vec<DictValue> = sub_device_uids
        .iter()
        .map(|uid| {
            let mut sub: DeviceDict = BTreeMap::new();
            sub.insert(
                KEY_SUB_DEVICE_UID.to_string(),
                DictValue::String((*uid).to_string()),
            );
            DictValue::Dict(sub)
        })
        .collect();
    dict.insert(KEY_SUB_DEVICE_LIST.to_string(), DictValue::Array(sub_list));
    dict
}

/// Idempotency probe — does a Multi-Output Device with our brand UID already exist
/// AND contain every required sub-device UID? If yes, return its `AudioDeviceID`
/// (no recreate). Mirrors design §3 step 2.
///
/// Rejects:
/// - aggregates with `is_stacked == false` (those are regular Aggregate Devices —
///   recreate as a Multi-Output, do NOT silently route through them);
/// - aggregates whose sub-list is missing any of the required UIDs (reconfiguration
///   needed — recreate).
pub fn find_existing_multi_out(
    aggregates: &[AggregateInfo],
    required_subs: &[&str],
) -> Option<AudioDeviceID> {
    aggregates
        .iter()
        .find(|agg| {
            agg.uid == MEETING_COPILOT_MULTI_OUT_UID
                && agg.is_stacked
                && required_subs
                    .iter()
                    .all(|req| agg.sub_device_uids.iter().any(|u| u == req))
        })
        .map(|a| a.id)
}

/// Create — or return the existing — Multi-Output Device combining the supplied
/// sub-device UIDs.
///
/// **Master sub-device** = `sub_device_uids[0]`. The clock master is the first
/// device in the slice — by convention the wizard passes
/// `[built_in_output_uid, blackhole_uid]` so the system clock follows the
/// built-in output (R-W.1 prevents drift relative to what the user hears).
///
/// **Idempotency** — if `probe.enumerate_aggregates()` reports a Multi-Output
/// Device with our brand UID and the required sub-list, this returns its ID
/// without invoking `creator.create(...)`. Re-running the wizard is therefore a
/// no-op on systems that are already configured.
///
/// **Validation** — the slice must (a) contain at least 2 entries (built-in +
/// BlackHole) and (b) include a UID matching the BlackHole 2ch installer stamp.
/// Failures surface as typed `ConfigureError` for the wizard to render.
///
/// **Rollback on failure** — `create_multi_output` does NOT mutate any persisted
/// state. If `creator.create(...)` returns a non-zero OSStatus, no device is
/// added and no settings field is flipped. The wizard can retry by calling this
/// function again. Per design §3, AudioHardwareCreateAggregateDevice is atomic
/// at the CoreAudio level — partial success is not possible.
pub fn create_multi_output<C, P>(
    creator: &C,
    probe: &P,
    name: &str,
    sub_device_uids: &[&str],
) -> Result<AudioDeviceID, ConfigureError>
where
    C: AggregateDeviceCreator,
    P: CoreAudioProbe,
{
    if sub_device_uids.len() < 2 {
        return Err(ConfigureError::InsufficientSubDevices);
    }
    if !sub_device_uids.iter().any(|uid| looks_like_blackhole_uid(uid)) {
        return Err(ConfigureError::BlackHoleNotInSubDevices);
    }

    // Idempotency check first — no AudioHardware* call if we're already configured.
    let aggregates = probe.enumerate_aggregates();
    if let Some(existing_id) = find_existing_multi_out(&aggregates, sub_device_uids) {
        return Ok(existing_id);
    }

    let master = sub_device_uids[0];
    let dict = build_aggregate_dict(name, master, sub_device_uids);

    creator
        .create(&dict)
        .map_err(|status| ConfigureError::CoreAudioFailed { status })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blackhole::{AggregateInfo, DeviceInfo};
    use std::cell::RefCell;

    /// Records each `create()` call's dict for shape + key assertions; pops the
    /// queued response (FIFO). Empty queue defaults to `Ok(900)` so tests that
    /// don't care about the returned ID stay terse.
    struct MockCreator {
        calls: RefCell<Vec<DeviceDict>>,
        responses: RefCell<Vec<Result<AudioDeviceID, i32>>>,
    }

    impl MockCreator {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                responses: RefCell::new(Vec::new()),
            }
        }
        fn queue_ok(&self, id: AudioDeviceID) -> &Self {
            self.responses.borrow_mut().push(Ok(id));
            self
        }
        fn queue_err(&self, status: i32) -> &Self {
            self.responses.borrow_mut().push(Err(status));
            self
        }
        fn last_call(&self) -> Option<DeviceDict> {
            self.calls.borrow().last().cloned()
        }
        fn call_count(&self) -> usize {
            self.calls.borrow().len()
        }
    }

    impl AggregateDeviceCreator for MockCreator {
        fn create(&self, dict: &DeviceDict) -> Result<AudioDeviceID, i32> {
            self.calls.borrow_mut().push(dict.clone());
            let mut responses = self.responses.borrow_mut();
            if responses.is_empty() {
                return Ok(900);
            }
            responses.remove(0)
        }
    }

    /// Probe mock — only `enumerate_aggregates` is exercised by `create_multi_output`;
    /// the other two methods are stubbed for trait completeness.
    struct MockProbe {
        aggregates: Vec<AggregateInfo>,
    }

    impl MockProbe {
        fn empty() -> Self {
            Self {
                aggregates: Vec::new(),
            }
        }
        fn with_aggregates(aggregates: Vec<AggregateInfo>) -> Self {
            Self { aggregates }
        }
    }

    impl CoreAudioProbe for MockProbe {
        fn hal_plugin_present(&self) -> bool {
            true
        }
        fn enumerate_devices(&self) -> Vec<DeviceInfo> {
            Vec::new()
        }
        fn enumerate_aggregates(&self) -> Vec<AggregateInfo> {
            self.aggregates.clone()
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

    fn expect_string<'a>(dict: &'a DeviceDict, key: &str) -> &'a str {
        match dict.get(key) {
            Some(DictValue::String(s)) => s.as_str(),
            other => panic!("expected String at key `{key}`, got {other:?}"),
        }
    }

    fn expect_integer(dict: &DeviceDict, key: &str) -> i64 {
        match dict.get(key) {
            Some(DictValue::Integer(n)) => *n,
            other => panic!("expected Integer at key `{key}`, got {other:?}"),
        }
    }

    fn expect_sub_uid_list<'a>(dict: &'a DeviceDict) -> Vec<String> {
        match dict.get(KEY_SUB_DEVICE_LIST) {
            Some(DictValue::Array(items)) => items
                .iter()
                .map(|item| match item {
                    DictValue::Dict(sub) => match sub.get(KEY_SUB_DEVICE_UID) {
                        Some(DictValue::String(s)) => s.clone(),
                        _ => panic!("sub-device dict missing kAudioSubDeviceUIDKey"),
                    },
                    _ => panic!("sub-device list entry not a dict"),
                })
                .collect(),
            other => panic!("expected Array at SubDeviceList, got {other:?}"),
        }
    }

    // ── Test 1 — INDEX-mandated #1: creates_multi_output_with_correct_keys ─────
    #[test]
    fn creates_multi_output_with_correct_keys() {
        let creator = MockCreator::new();
        creator.queue_ok(501);
        let probe = MockProbe::empty();

        let id = create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
        )
        .expect("create should succeed");

        assert_eq!(id, 501);
        assert_eq!(creator.call_count(), 1, "creator must be invoked exactly once");

        let dict = creator.last_call().expect("creator should have recorded dict");

        // Key set is exactly the 5 design-§3 keys.
        let mut keys: Vec<&str> = dict.keys().map(|s| s.as_str()).collect();
        keys.sort();
        let mut expected = vec![
            KEY_UID,
            KEY_NAME,
            KEY_MASTER_SUB_DEVICE,
            KEY_SUB_DEVICE_LIST,
            KEY_IS_STACKED,
        ];
        expected.sort();
        assert_eq!(keys, expected, "dict keys must be exactly the design §3 set");

        // Brand UID + name + master + IsStacked all carry the right values.
        assert_eq!(expect_string(&dict, KEY_UID), MEETING_COPILOT_MULTI_OUT_UID);
        assert_eq!(expect_string(&dict, KEY_NAME), MEETING_COPILOT_MULTI_OUT_NAME);
        assert_eq!(
            expect_string(&dict, KEY_MASTER_SUB_DEVICE),
            "BuiltInSpeakerDevice"
        );
        assert_eq!(
            expect_integer(&dict, KEY_IS_STACKED),
            IS_STACKED_MULTI_OUTPUT
        );

        // Sub-device list shape: [{uid: built_in}, {uid: bh}].
        let subs = expect_sub_uid_list(&dict);
        assert_eq!(subs, vec!["BuiltInSpeakerDevice", "BlackHole2ch_UID"]);
    }

    // ── Test 2 — INDEX-mandated #2: idempotent_returns_existing_device_id ──────
    #[test]
    fn idempotent_returns_existing_device_id_when_uid_match() {
        // System already has our Multi-Output. Re-running the wizard MUST return
        // the existing device id and MUST NOT call AudioHardwareCreateAggregateDevice
        // a second time (would either error or duplicate the device).
        let creator = MockCreator::new();
        let probe = MockProbe::with_aggregates(vec![agg(
            777,
            MEETING_COPILOT_MULTI_OUT_UID,
            "Meeting Copilot Multi-Output",
            true, // is_stacked = 1 ⇒ already a Multi-Output
            &["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
        )]);

        let id = create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
        )
        .expect("idempotent path should succeed");

        assert_eq!(id, 777, "must return the *existing* device id, not a new one");
        assert_eq!(
            creator.call_count(),
            0,
            "AudioHardwareCreateAggregateDevice must NOT be called when device already exists"
        );
    }

    // ── Test 3 — INDEX-mandated #3: rejects_when_blackhole_uid_missing ─────────
    #[test]
    fn rejects_when_blackhole_uid_missing_from_sub_devices() {
        // Caller passes a sub-list with no BlackHole UID. Without BlackHole the
        // whole capture path is broken — the function must return a typed error
        // BEFORE issuing the CoreAudio call.
        let creator = MockCreator::new();
        let probe = MockProbe::empty();

        let err = create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BuiltInSpeakerDevice", "FocusriteScarlettUID"],
        )
        .expect_err("expected BlackHoleNotInSubDevices");

        assert_eq!(err, ConfigureError::BlackHoleNotInSubDevices);
        assert_eq!(
            creator.call_count(),
            0,
            "CoreAudio must NOT be called when the precondition fails"
        );
    }

    // ── Test 4 — INDEX-mandated #4 BLOCKING: IsStacked=1 regression guard ──────
    #[test]
    fn is_stacked_key_is_1_for_multi_output_not_0() {
        // BLOCKING (R-W.3 design §3 + §6 risk #3): IsStacked=1 creates a
        // Multi-Output (audio fans out to ALL sub-devices — what we want).
        // IsStacked=0 creates a regular Aggregate (sub-devices feed input
        // streams — silently breaks the meeting). If anyone ever flips this
        // bit, the user hears their meeting on built-in speakers but BlackHole
        // gets nothing → transcription gets nothing.
        let creator = MockCreator::new();
        creator.queue_ok(801);
        let probe = MockProbe::empty();

        create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
        )
        .expect("create should succeed");

        let dict = creator.last_call().expect("dict should be recorded");
        let is_stacked = expect_integer(&dict, KEY_IS_STACKED);

        // Hard-coded `1` — defence in depth against someone refactoring the
        // constant table and accidentally flipping it.
        assert_eq!(is_stacked, 1, "IsStacked MUST be 1 (Multi-Output Device)");
        assert_ne!(
            is_stacked, IS_STACKED_AGGREGATE,
            "IsStacked MUST NOT be the Aggregate-Device value (0)"
        );
        // And the constant the production path consumes is also 1.
        assert_eq!(
            IS_STACKED_MULTI_OUTPUT, 1,
            "IS_STACKED_MULTI_OUTPUT constant drift — was 1, now {}",
            IS_STACKED_MULTI_OUTPUT
        );
        assert_eq!(IS_STACKED_AGGREGATE, 0);
    }

    // ── Test 5 — INDEX-mandated #5: master_sub_device_defaults_to_built_in ─────
    #[test]
    fn master_sub_device_defaults_to_built_in_output() {
        // The wizard passes `[built_in_output_uid, blackhole_uid]` and the first
        // entry becomes the clock master. Verifies the documented contract
        // (sub_device_uids[0] → MasterSubDevice).
        let creator = MockCreator::new();
        creator.queue_ok(900);
        let probe = MockProbe::empty();

        create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
        )
        .expect("create should succeed");

        let dict = creator.last_call().expect("dict should be recorded");
        assert_eq!(
            expect_string(&dict, KEY_MASTER_SUB_DEVICE),
            "BuiltInSpeakerDevice",
            "master sub-device should be the first UID in the slice"
        );

        // Sanity: if the caller ever reorders the slice, the master follows.
        let creator2 = MockCreator::new();
        creator2.queue_ok(901);
        let probe2 = MockProbe::empty();
        create_multi_output(
            &creator2,
            &probe2,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BlackHole2ch_UID", "BuiltInSpeakerDevice"],
        )
        .expect("create should succeed (reverse order)");
        let dict2 = creator2.last_call().expect("dict should be recorded");
        assert_eq!(
            expect_string(&dict2, KEY_MASTER_SUB_DEVICE),
            "BlackHole2ch_UID",
            "first slice entry stays the master regardless of which device it is"
        );
    }

    // ── Test 6 (sentinel) — rollback / no mutation on CoreAudio failure ────────
    #[test]
    fn rollback_on_create_failure_no_partial_state() {
        // R-W.5 sudo-cancel parallel: when AudioHardwareCreateAggregateDevice
        // returns a non-zero OSStatus, the function must (a) surface the status
        // verbatim and (b) leave no partial state behind. The probe is unchanged
        // (no aggregate added), no settings field is flipped, no second call is
        // made by the function itself. The wizard's "Try again" button just
        // re-invokes create_multi_output.
        let creator = MockCreator::new();
        creator.queue_err(1852797029); // OSStatus 'nope' four-char-code
        let probe = MockProbe::empty();

        let err = create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
        )
        .expect_err("expected CoreAudioFailed");

        match err {
            ConfigureError::CoreAudioFailed { status } => {
                assert_eq!(status, 1852797029, "OSStatus must be surfaced verbatim");
            }
            other => panic!("expected CoreAudioFailed, got {other:?}"),
        }
        assert_eq!(creator.call_count(), 1, "create must be called exactly once on failure (no auto-retry)");
    }

    // ── Test 7 (sentinel) — insufficient sub-device list rejected ──────────────
    #[test]
    fn insufficient_sub_devices_rejected_before_creator_call() {
        // A degenerate slice (only BlackHole, no built-in) must error out without
        // calling the creator. Documents the precondition.
        let creator = MockCreator::new();
        let probe = MockProbe::empty();

        let err = create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BlackHole2ch_UID"], // only 1 entry
        )
        .expect_err("expected InsufficientSubDevices");

        assert_eq!(err, ConfigureError::InsufficientSubDevices);
        assert_eq!(creator.call_count(), 0);

        // And empty slice also rejected.
        let err_empty = create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &[],
        )
        .expect_err("expected InsufficientSubDevices for empty slice");
        assert_eq!(err_empty, ConfigureError::InsufficientSubDevices);
    }

    // ── Test 8 (sentinel) — idempotent rejects non-stacked existing aggregate ──
    #[test]
    fn idempotent_does_not_match_aggregate_with_is_stacked_false() {
        // Existing device with our brand UID but `is_stacked=0` (somehow created
        // as a regular Aggregate — corrupt state). MUST NOT short-circuit; instead
        // recreate as a proper Multi-Output. R-W.3 mitigation in idempotency code.
        let creator = MockCreator::new();
        creator.queue_ok(999);
        let probe = MockProbe::with_aggregates(vec![agg(
            42,
            MEETING_COPILOT_MULTI_OUT_UID,
            "Meeting Copilot Multi-Output",
            false, // is_stacked = 0 ⇒ regular Aggregate, NOT a Multi-Output
            &["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
        )]);

        let id = create_multi_output(
            &creator,
            &probe,
            MEETING_COPILOT_MULTI_OUT_NAME,
            &["BuiltInSpeakerDevice", "BlackHole2ch_UID"],
        )
        .expect("recreation should succeed");

        assert_eq!(id, 999, "must be the new id, not the corrupt aggregate's id (42)");
        assert_eq!(
            creator.call_count(),
            1,
            "creator must be invoked to recreate as a proper Multi-Output"
        );
    }

    // ── Test 9 (sentinel) — looks_like_blackhole_uid matcher coverage ──────────
    #[test]
    fn looks_like_blackhole_uid_handles_uid_and_name_variants() {
        assert!(looks_like_blackhole_uid("BlackHole2ch_UID"));
        assert!(looks_like_blackhole_uid("BlackHole2ch_UID_Variant"));
        assert!(looks_like_blackhole_uid("blackhole2ch")); // lowercase
        assert!(looks_like_blackhole_uid("BLACKHOLE 2CH")); // upper-case name variant
        assert!(!looks_like_blackhole_uid("BuiltInSpeakerDevice"));
        assert!(!looks_like_blackhole_uid("FocusriteScarlettUID"));
    }
}
