// Phase 1 T-1.13 — Stop→persist + hydrate-on-open IPC wrappers.
//
// Thin `invoke` wrappers around the Tauri commands `save_meeting` /
// `load_meetings` registered in `src-tauri/src/lib.rs`. The Rust side bundles
// the row DTOs into `helper_daemon::MeetingSnapshot`; the TS shape is
// byte-identical because both serialise via `serde(rename_all = "camelCase")`
// + the canonical `shared/types.ts` definitions.
//
// Tests mock `@tauri-apps/api/core` directly (same seam used by
// `contextStore.test.ts`).

import { invoke } from "@tauri-apps/api/core";

import type {
  Answer,
  ContextSource,
  MeetingSession,
  Question,
  TranscriptChunk,
} from "../../shared/types";

export const SAVE_MEETING_COMMAND = "save_meeting" as const;
export const LOAD_MEETINGS_COMMAND = "load_meetings" as const;

/// Bundle the React side passes to the Tauri `save_meeting` command on Stop.
/// Mirrors `helper_daemon::MeetingSnapshot` 1:1.
export interface MeetingSnapshot {
  meeting: MeetingSession;
  chunks: TranscriptChunk[];
  questions: Question[];
  answer?: Answer;
  contextSource?: ContextSource;
}

export async function saveMeetingSnapshot(snapshot: MeetingSnapshot): Promise<void> {
  await invoke(SAVE_MEETING_COMMAND, { snapshot });
}

export async function loadMeetings(): Promise<MeetingSession[]> {
  return await invoke<MeetingSession[]>(LOAD_MEETINGS_COMMAND);
}
