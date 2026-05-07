// T-W.7 — Typed `invoke` wrappers for the BlackHole Setup Wizard's four
// Tauri commands. Mirrors `src-tauri/src/commands/setup.rs` 1:1.
//
// Why a separate file from `useSetupWizard.ts` types: the wizard reducer
// owns the in-memory state shape (it carries fields like `retryCount` that
// the wire format does not). This module is the IPC boundary — the shapes
// here MUST stay byte-identical with the Rust DTOs in
// `src-tauri/src/commands/setup.rs::*Dto`.
//
// Tests mock `@tauri-apps/api/core` directly (same seam used by
// `persistClient.ts` / `contextStore.test.ts`).

import { invoke } from "@tauri-apps/api/core";

import type {
  BlackHoleStatus,
  InstallReport,
  VerifyReport,
} from "../components/SetupWizard/useSetupWizard";

export const SETUP_DETECT_BLACKHOLE = "setup_detect_blackhole" as const;
export const SETUP_INSTALL_BLACKHOLE = "setup_install_blackhole" as const;
export const SETUP_CONFIGURE_MULTI_OUTPUT = "setup_configure_multi_output" as const;
export const SETUP_VERIFY_CAPTURE = "setup_verify_capture" as const;

/// Mirror of the Rust `ConfigureMultiOutputResultDto`. The wizard's
/// `Configure` step consumes `device_id` and threads it into the verify
/// invoker.
export interface ConfigureMultiOutputResult {
  device_id: number;
}

export async function setupDetectBlackhole(): Promise<BlackHoleStatus> {
  return await invoke<BlackHoleStatus>(SETUP_DETECT_BLACKHOLE);
}

export async function setupInstallBlackhole(): Promise<InstallReport> {
  return await invoke<InstallReport>(SETUP_INSTALL_BLACKHOLE);
}

export async function setupConfigureMultiOutput(
  subDeviceUids: string[],
): Promise<ConfigureMultiOutputResult> {
  return await invoke<ConfigureMultiOutputResult>(SETUP_CONFIGURE_MULTI_OUTPUT, {
    subDeviceUids,
  });
}

export async function setupVerifyCapture(
  deviceHint: string,
  durationMs: number,
): Promise<VerifyReport> {
  return await invoke<VerifyReport>(SETUP_VERIFY_CAPTURE, {
    deviceHint,
    durationMs,
  });
}
