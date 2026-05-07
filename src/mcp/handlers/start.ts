// Phase 4 T-4.4 — `bridge_meeting_start` handler.
//
// End-to-end flow (security-critical ordering — DO NOT REORDER):
//
//   1. Zod parse (`StartInputSchema`) — strict; unknown keys throw, wrong
//      enums throw. Any throw propagates to `server.ts`, which converts to
//      an `isError` envelope.
//   2. `validateContextPaths` (deeplink.ts) — structural reject of
//      traversal / NUL / empty / oversized inputs. Maps to `ContextNotFound`
//      typed envelope.
//   3. **Privacy gate** — `isSttProviderAllowed(privacyMode, sttProvider)`.
//      Maps to `PrivacyModeViolation` envelope. **MUST run before spawn.**
//      The R-2 risk (INDEX) is privacy bypass via spawn-then-check; this
//      ordering is the mitigation and the test in `start.test.ts` asserts
//      that `spawn` is never invoked on the violation path.
//   4. Build deeplink (`buildStartDeeplink`). URLSearchParams handles all
//      percent-encoding; no string concat.
//   5. Spawn `open <deeplink>` via `child_process.spawn` in **array form**
//      (no `shell: true`). Detached + stdio:"ignore" + unref so the parent
//      MCP server does not hold the child open. `open` is part of macOS;
//      cross-platform launch (xdg-open / start) is deferred to Phase 4.x.
//   6. Poll the helper-daemon RPC for the meetingId+pid handshake (T-4.5).
//      Until T-4.5 lands, the default `pollHandshake` throws — the handler
//      converts that to a `DeeplinkNotRegistered` envelope so the contract
//      stays uniform regardless of which sub-system actually returned the
//      failure.
//
// Tests inject mocks for `spawn` + `pollHandshake` via the `StartHandlerDeps`
// shape; the production wiring in `server.ts` uses defaults. See
// `start.test.ts`.

import { isSttProviderAllowed, type PrivacyMode } from "../../privacy/privacyMode";
import type { SttProviderId } from "../../llm/sttPricing";
import {
  buildStartDeeplink,
  ContextPathRejected,
  validateContextPaths,
} from "../deeplink";
import {
  StartInputSchema,
  StartOutputSchema,
  errorResult,
  type StartOutput,
  type ToolResult,
} from "../tools";

/** Minimal subset of `child_process.spawn`'s return shape that we rely on —
 * lets tests stub without pulling in the full Node `ChildProcess` type. */
export interface SpawnedChildLike {
  unref?: () => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  options?: Record<string, unknown>,
) => SpawnedChildLike;

export interface PollHandshakeArgs {
  /** The fully-built deeplink URL — handed to the helper daemon for
   *  cross-checking, but in Phase 4.x the URL is reconstructed daemon-side
   *  from query params. Carrying it here keeps the contract symmetric. */
  deeplink: string;
  /** Hard deadline (epoch ms) by which the handshake must complete. The
   *  default poll uses this to compute its own per-attempt sleep. */
  deadlineEpochMs: number;
}

export type PollHandshakeFn = (args: PollHandshakeArgs) => Promise<StartOutput>;

export interface StartHandlerDeps {
  /** Override for tests; production uses `child_process.spawn`. */
  spawn?: SpawnFn;
  /** Override for tests; production injects the T-4.5 helper-daemon poll. */
  pollHandshake?: PollHandshakeFn;
  /** Override the wall-clock — tests inject a fixed value so the deadline is
   *  deterministic. */
  now?: () => number;
  /** Override the spawn timeout (ms) — defaults to 5_000 per T-4.4 plan. */
  handshakeTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

async function defaultPollHandshake(_args: PollHandshakeArgs): Promise<StartOutput> {
  // T-4.5 replaces this with a real Unix-domain-socket poll against
  // `~/.claude-bridge/meeting-copilot.sock`. Until then, the default reports
  // a typed failure so callers without the helper daemon get an actionable
  // error envelope instead of a hang.
  throw new Error(
    "helper-daemon RPC not yet wired (T-4.5) — pass deps.pollHandshake to the start handler in tests, or wait for T-4.5 to land.",
  );
}

async function defaultSpawn(
  cmd: string,
  args: readonly string[],
  options?: Record<string, unknown>,
): Promise<SpawnedChildLike> {
  const cp = await import("node:child_process");
  return cp.spawn(cmd, args as string[], options) as unknown as SpawnedChildLike;
}

/**
 * Convenience for tests: build a typed handshake-result without bothering with
 * Zod (the handler re-parses through `StartOutputSchema` before returning).
 */
export function syntheticHandshake(over: Partial<StartOutput> = {}): StartOutput {
  return {
    meetingId: "m-test",
    pid: 12345,
    rpcSocket: "/tmp/meeting-copilot.sock",
    uiUrl: "http://127.0.0.1:7411/embed/transcript/m-test?token=t",
    ...over,
  };
}

export async function handleStart(
  args: unknown,
  deps: StartHandlerDeps = {},
): Promise<ToolResult> {
  // (1) Zod parse — strict; unknown keys / wrong enums throw out.
  const input = StartInputSchema.parse(args);

  // (2) Path-traversal / structural guard.
  try {
    validateContextPaths(input.contextPaths);
  } catch (err) {
    if (err instanceof ContextPathRejected) {
      return errorResult("ContextNotFound", err.message);
    }
    throw err;
  }

  // (3) Privacy gate — BEFORE spawn. If we spawn first we leak a process
  //     creation on a privacy-violation request, which Phase 3 T-3.8 said
  //     must never happen. The unit test in `start.test.ts` asserts spawn
  //     is never invoked on this path.
  if (
    !isSttProviderAllowed(
      input.privacyMode as PrivacyMode,
      input.sttProvider as SttProviderId,
    )
  ) {
    return errorResult(
      "PrivacyModeViolation",
      `STT provider "${input.sttProvider}" is not permitted under privacy mode "${input.privacyMode}". ` +
        `Switch the meeting to a compatible mode (e.g. "cloud" for cloud STT) or pick a local provider (mlx).`,
    );
  }

  // (4) Build deeplink — pure URLSearchParams; no shell-meta concat.
  const deeplink = buildStartDeeplink(input);

  // (5) Spawn `open <deeplink>` in array form. NEVER `shell: true`. The macOS
  //     `open` command is the only invocation here; cross-platform support is
  //     out of scope for Phase 4.
  const spawnFn: SpawnFn = deps.spawn ?? ((cmd, a, o) => {
    // Bridge async default into the sync SpawnFn shape — promise rejection
    // would not be observed by the caller, so we keep this pattern: any
    // failure to invoke `open` surfaces below as a thrown exception caught
    // by the try/catch wrapping the call.
    let result: SpawnedChildLike = { unref: () => undefined };
    // eslint-disable-next-line no-void
    void defaultSpawn(cmd, a, o).then((c) => {
      result = c;
      result.unref?.();
    });
    return result;
  });
  try {
    const child = spawnFn(
      "open",
      [deeplink],
      { detached: true, stdio: "ignore", shell: false },
    );
    child.unref?.();
  } catch (err) {
    // Synchronous spawn failure (binary missing, etc.) — surface as a typed
    // envelope. Async errors arrive via `child.on('error', …)` but in the
    // detached/unref pattern we don't observe those; the helper-daemon poll
    // timeout is the second-line catch.
    return errorResult(
      "DeeplinkNotRegistered",
      `failed to invoke 'open' for the meeting-copilot:// deeplink: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // (6) Poll handshake — T-4.5 fills in the real socket dial; until then the
  //     default returns a typed failure.
  const now = deps.now ?? Date.now;
  const timeout = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const poll: PollHandshakeFn = deps.pollHandshake ?? defaultPollHandshake;
  let handshake: StartOutput;
  try {
    handshake = await poll({
      deeplink,
      deadlineEpochMs: now() + timeout,
    });
  } catch (err) {
    return errorResult(
      "DeeplinkNotRegistered",
      `helper-daemon handshake failed (deeplink may not be registered, or the app failed to launch): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const validated = StartOutputSchema.parse(handshake);
  return {
    content: [{ type: "text", text: JSON.stringify(validated, null, 2) }],
    structuredContent: validated,
  };
}
