// Phase 1 T-1.8 — zustand store slice for the loaded context source.
//
// Single-file MVP per loop INDEX (raw plan T-1.4 sliced down). T-1.10 reads
// `useContextStore.getState().source.content` to build the cached system block
// (ARCH §6.2: `cache_control: { type: "ephemeral" }`).
//
// Rationale for picking zustand over plain React Context: the same store is
// shared by T-1.9 (Start Meeting), T-1.10 (Claude client), and T-1.11
// (AnswerPanel) — bundling four consumers into one slice avoids prop drilling
// without bringing the boilerplate of Redux/Toolkit. ~3 KB gzipped.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import type { ContextSource } from "../../shared/types";

/// Mirrors `helper_daemon::ContextFile`. The Rust side serialises with
/// `serde(rename_all = "camelCase")` so this is the literal IPC shape.
export interface ContextFilePayload {
  path: string;
  content: string;
  charCount: number;
  estimatedTokens: number;
}

export interface ContextState {
  source: ContextSource | null;
  /** content held off the public `ContextSource` so the cached system block
   *  can be reconstructed by T-1.10 without a re-read. */
  content: string | null;
  error: string | null;
  loadFromPath: (path: string) => Promise<void>;
  clear: () => void;
}

export const READ_CONTEXT_FILE_COMMAND = "read_context_file" as const;

export const useContextStore = create<ContextState>((set) => ({
  source: null,
  content: null,
  error: null,
  loadFromPath: async (path: string) => {
    try {
      const payload = await invoke<ContextFilePayload>(READ_CONTEXT_FILE_COMMAND, { path });
      const source: ContextSource = {
        id: payload.path,
        path: payload.path,
        charCount: payload.charCount,
        estimatedTokens: payload.estimatedTokens,
        loadedAt: Date.now(),
      };
      set({ source, content: payload.content, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  clear: () => set({ source: null, content: null, error: null }),
}));
