// T-W.7 — Tauri command wrappers for the BlackHole Setup Wizard.
//
// Four commands matching `SetupWizardInvokers` (`src/components/SetupWizard/SetupWizard.tsx`):
//
//   setup_detect_blackhole       → audio_capture::detect_blackhole(RealCoreAudioProbe)
//   setup_install_blackhole      → helper_daemon::install_via_brew(Real{Filesystem,ProcessRunner})
//   setup_configure_multi_output → audio_capture::create_multi_output(RealAggregateDeviceCreator,
//                                                                     RealCoreAudioProbe, …)
//   setup_verify_capture         → audio_capture::verify_capture(RealAudioInputProbe, …)
//
// The audio-capture / helper-daemon types are NOT `Serialize`. We define IPC
// DTOs here that mirror the wizard's frontend contract
// (`src/components/SetupWizard/useSetupWizard.ts`), and convert via `From`.
// The wire format is what `useSetupWizard.ts` already consumes — this command
// layer is the boundary that locks the contract down.
//
// Production probes/runners/creators live BEHIND traits in the underlying
// crates (`CoreAudioProbe`, `ProcessRunner`, `FilesystemCheck`,
// `AggregateDeviceCreator`, `AudioInputProbe`). The unit tests inside
// `audio-capture` + `helper-daemon` exercise the trait-driven logic with
// mocks; this command layer is the one place that wires the production impls
// together. The stub bodies of `RealCoreAudioProbe::enumerate_*` and
// `RealAggregateDeviceCreator::create` (deferred to Phase-W follow-up FFI work
// — see `crates/audio-capture/src/blackhole.rs:151` + `multi_output.rs:147`)
// flow through this layer untouched: the IPC contract here is final, the FFI
// body filling lands without a contract change.

use audio_capture::{
    create_multi_output, detect_blackhole, verify_capture, AggregateInfo, BlackHoleStatus,
    ConfigureError, DeviceInfo, RealAggregateDeviceCreator, RealAudioInputProbe,
    RealCoreAudioProbe, VerifyError, VerifyReport, MEETING_COPILOT_MULTI_OUT_NAME,
    VERIFY_PEAK_THRESHOLD,
};
use helper_daemon::{install_via_brew, InstallError, RealFilesystem, RealProcessRunner};
use serde::{Deserialize, Serialize};

// ── DTOs — wire shapes consumed by `useSetupWizard.ts` ───────────────────────

/// Wire shape of `BlackHoleStatus`. Frontend discriminates on `kind`
/// (snake_case). Mirrors `useSetupWizard.ts:40`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlackHoleStatusDto {
    NotInstalled,
    InstalledNotConfigured {
        blackhole_uid: String,
    },
    Configured {
        blackhole_uid: String,
        multi_output_uid: String,
        multi_output_id: u32,
    },
    Verified {
        peak: f32,
        callback_count: u32,
    },
}

impl From<BlackHoleStatus> for BlackHoleStatusDto {
    fn from(status: BlackHoleStatus) -> Self {
        match status {
            BlackHoleStatus::NotInstalled => Self::NotInstalled,
            BlackHoleStatus::InstalledNotConfigured { blackhole_uid } => {
                Self::InstalledNotConfigured { blackhole_uid }
            }
            BlackHoleStatus::Configured {
                blackhole_uid,
                multi_output_uid,
                multi_output_id,
            } => Self::Configured {
                blackhole_uid,
                multi_output_uid,
                multi_output_id,
            },
            BlackHoleStatus::Verified {
                peak,
                callback_count,
            } => Self::Verified {
                peak,
                callback_count,
            },
        }
    }
}

/// Wire shape of `VerifyReport`. Adds `signal_present` (derived from peak >
/// `VERIFY_PEAK_THRESHOLD`) and renames `duration_ms` → `duration_ms_actual`
/// to match `useSetupWizard.ts:55`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerifyReportDto {
    pub peak_amplitude: f32,
    pub signal_present: bool,
    pub duration_ms_actual: u64,
    pub callback_count: u32,
}

impl From<VerifyReport> for VerifyReportDto {
    fn from(r: VerifyReport) -> Self {
        Self {
            signal_present: r.peak_amplitude > VERIFY_PEAK_THRESHOLD,
            peak_amplitude: r.peak_amplitude,
            duration_ms_actual: r.duration_ms,
            callback_count: r.callback_count,
        }
    }
}

/// Wire shape of an install round-trip outcome. Mirrors `useSetupWizard.ts:66`.
/// `brew_found=false` carries the `manual_url` for the wizard's "Open in
/// browser" fallback link.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InstallReportDto {
    pub brew_found: bool,
    pub manual_url: String,
    pub exit_code: Option<i32>,
    pub stderr_tail: Option<String>,
}

// ── Command bodies ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn setup_detect_blackhole() -> Result<BlackHoleStatusDto, String> {
    let probe = RealCoreAudioProbe;
    Ok(detect_blackhole(&probe).into())
}

#[tauri::command]
pub async fn setup_install_blackhole() -> Result<InstallReportDto, String> {
    let fs = RealFilesystem;
    let runner = RealProcessRunner;
    match install_via_brew(&fs, &runner) {
        Ok(_report) => Ok(InstallReportDto {
            brew_found: true,
            manual_url: helper_daemon::MANUAL_INSTALL_URL.to_string(),
            exit_code: Some(0),
            stderr_tail: None,
        }),
        Err(InstallError::BrewNotFound { manual_url }) => Ok(InstallReportDto {
            brew_found: false,
            manual_url: manual_url.to_string(),
            exit_code: None,
            stderr_tail: None,
        }),
        Err(InstallError::BrewFailed { exit_code, stderr }) => Err(format!(
            "brew exited {exit_code:?}: {tail}",
            tail = tail_lines(&stderr, 20)
        )),
        Err(InstallError::SpawnFailed { message }) => {
            Err(format!("failed to run brew: {message}"))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfigureMultiOutputResultDto {
    pub device_id: u32,
}

#[tauri::command]
pub async fn setup_configure_multi_output(
    sub_device_uids: Vec<String>,
) -> Result<ConfigureMultiOutputResultDto, String> {
    let creator = RealAggregateDeviceCreator;
    let probe = RealCoreAudioProbe;
    // Borrow as &[&str] without re-allocating the strings.
    let refs: Vec<&str> = sub_device_uids.iter().map(|s| s.as_str()).collect();
    create_multi_output(&creator, &probe, MEETING_COPILOT_MULTI_OUT_NAME, &refs)
        .map(|device_id| ConfigureMultiOutputResultDto { device_id })
        .map_err(|e: ConfigureError| e.to_string())
}

#[tauri::command]
pub async fn setup_verify_capture(
    device_hint: String,
    duration_ms: u64,
) -> Result<VerifyReportDto, String> {
    let probe = RealAudioInputProbe;
    verify_capture(&probe, &device_hint, duration_ms)
        .map(VerifyReportDto::from)
        .map_err(|e: VerifyError| e.to_string())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

// `DeviceInfo` / `AggregateInfo` are unused by these wrappers but
// re-imported above so any future addition (e.g. an enumerate-only command)
// has them in scope without churning the import block.
#[allow(dead_code)]
fn _ensure_audio_types_imported(_a: DeviceInfo, _b: AggregateInfo) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_blackhole_not_installed_round_trip() {
        let dto: BlackHoleStatusDto = BlackHoleStatus::NotInstalled.into();
        let json = serde_json::to_string(&dto).unwrap();
        // Frontend reducer matches on `kind` (snake_case); keep this stable.
        assert!(json.contains("\"kind\":\"not_installed\""), "got: {json}");
    }

    #[test]
    fn dto_blackhole_configured_carries_uids() {
        let dto: BlackHoleStatusDto = BlackHoleStatus::Configured {
            blackhole_uid: "BlackHole2ch_UID".to_string(),
            multi_output_uid: "MeetingCopilotMultiOut".to_string(),
            multi_output_id: 137,
        }
        .into();
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"kind\":\"configured\""));
        assert!(json.contains("\"multi_output_id\":137"));
        assert!(json.contains("\"blackhole_uid\":\"BlackHole2ch_UID\""));
    }

    #[test]
    fn dto_blackhole_installed_not_configured() {
        let dto: BlackHoleStatusDto = BlackHoleStatus::InstalledNotConfigured {
            blackhole_uid: "BH_UID_X".to_string(),
        }
        .into();
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"kind\":\"installed_not_configured\""));
        assert!(json.contains("\"blackhole_uid\":\"BH_UID_X\""));
    }

    #[test]
    fn dto_verify_report_signal_present_when_peak_above_threshold() {
        let r = VerifyReport {
            peak_amplitude: 0.5,
            callback_count: 240,
            sample_count: 240_000,
            duration_ms: 5_000,
        };
        let dto: VerifyReportDto = r.into();
        assert!(dto.signal_present, "peak 0.5 > threshold {VERIFY_PEAK_THRESHOLD}");
        assert_eq!(dto.duration_ms_actual, 5_000);
        assert_eq!(dto.callback_count, 240);
    }

    #[test]
    fn dto_verify_report_signal_absent_at_or_below_threshold() {
        let r = VerifyReport {
            peak_amplitude: VERIFY_PEAK_THRESHOLD,
            callback_count: 240,
            sample_count: 240_000,
            duration_ms: 5_000,
        };
        let dto: VerifyReportDto = r.into();
        assert!(!dto.signal_present, "peak == threshold should NOT promote");
    }

    #[test]
    fn dto_install_report_brew_not_found_serializes_url() {
        let dto = InstallReportDto {
            brew_found: false,
            manual_url: helper_daemon::MANUAL_INSTALL_URL.to_string(),
            exit_code: None,
            stderr_tail: None,
        };
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("\"brew_found\":false"));
        assert!(json.contains("existential.audio"));
    }

    #[test]
    fn tail_lines_returns_last_n() {
        let s = "a\nb\nc\nd\ne";
        assert_eq!(tail_lines(s, 2), "d\ne");
        assert_eq!(tail_lines(s, 99), s);
    }
}
