// Phase 4 T-4.8 — Bridge config Zod schema (scoped slice).
//
// We do NOT mirror the full claude-bridge `config.json` shape (the daemon
// owns that — see `claude-bridge/docs/web-dashboard/v2/ARCHITECTURE.md` §16).
// Instead, we describe the slice meeting-copilot reads and writes:
//
//   - top-level `version: number` (must be 1 for now; >1 = unsupported).
//   - top-level `meeting_copilots: Array<MeetingCopilotEntry>`.
//
// Any other top-level key (daemon, dashboards, channels, …) is preserved
// untouched on round-trip via Zod `.passthrough()`. This is critical: the
// daemon and meeting-copilot are concurrent writers of the same JSON file,
// each owning a disjoint set of keys. If either side strips an unknown key
// during a write, the other side's state is destroyed.
//
// Same shape rules apply to entries in `meeting_copilots[]`: we recognize
// {version, path, default, installed_at?, installed_from?, mcp_bin?} and
// pass through anything else.

import * as z from "zod";

// --- Entry schema ---------------------------------------------------------

export const MeetingCopilotEntrySchema = z
  .object({
    version: z.string().min(1),
    /** Absolute filesystem path. We reject tilde-prefixed values pre-write. */
    path: z.string().min(1),
    default: z.boolean().optional().default(false),
    /** ISO 8601 timestamp; written by registerMeetingCopilot at first register. */
    installed_at: z.string().optional(),
    /** Provenance hint (e.g. "github.com/anthropic/meeting-copilot@v1.0.0"). */
    installed_from: z.string().optional(),
    /** Absolute path to the MCP server binary (bin.ts shim or compiled). */
    mcp_bin: z.string().optional(),
  })
  .passthrough();

export type MeetingCopilotEntry = z.infer<typeof MeetingCopilotEntrySchema>;

// --- Top-level config schema ----------------------------------------------

export const BridgeConfigSchema = z
  .object({
    /** Schema version. Daemon emits 1 today (per `dashboard-installer.ts` +
     *  ARCH §16). meeting-copilot rejects values > 1 with
     *  `ConfigSchemaUnsupported`. */
    version: z.number().int().min(1).default(1),
    meeting_copilots: z.array(MeetingCopilotEntrySchema).optional().default([]),
  })
  .passthrough();

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

/** Highest `config.version` meeting-copilot understands. Bumping this is a
 *  breaking change to `BridgeConfigSchema`. */
export const SUPPORTED_CONFIG_VERSION = 1 as const;
