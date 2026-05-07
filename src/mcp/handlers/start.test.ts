// Phase 4 T-4.4 — handleStart unit tests.
//
// Coverage targets:
//   - Privacy gate rejects BEFORE spawn (R-2 mitigation in INDEX). The test
//     wraps `spawn` with a tracker; on a privacy-violation request the
//     tracker MUST not fire.
//   - Path-traversal in contextPaths surfaces as `ContextNotFound`.
//   - Spawn is invoked with the array form (no `shell: true`).
//   - Default `pollHandshake` (T-4.5 placeholder) returns the typed
//     `DeeplinkNotRegistered` envelope.
//   - Happy path with injected spawn + injected poll returns the validated
//     `StartOutput` envelope (round-trips through `StartOutputSchema`).
//   - Zod strict mode rejects unknown keys.

import { describe, expect, it } from "vitest";

import { StartOutputSchema } from "../tools";
import {
  handleStart,
  syntheticHandshake,
  type SpawnFn,
  type StartHandlerDeps,
  type SpawnedChildLike,
} from "./start";

interface SpawnTrace {
  cmd: string;
  args: readonly string[];
  options?: Record<string, unknown>;
}

function makeSpawnSpy(): {
  spawn: SpawnFn;
  calls: SpawnTrace[];
} {
  const calls: SpawnTrace[] = [];
  const spawn: SpawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child: SpawnedChildLike = {
      unref: () => undefined,
      on: () => undefined,
    };
    return child;
  };
  return { spawn, calls };
}

function happyDeps(over: Partial<StartHandlerDeps> = {}): StartHandlerDeps {
  const { spawn } = makeSpawnSpy();
  return {
    spawn,
    pollHandshake: async () => syntheticHandshake(),
    now: () => 1_700_000_000_000,
    ...over,
  };
}

const VALID_INPUT = {
  contextPaths: ["/Users/hieu/PRD.md"],
  sttProvider: "mlx",
  model: "claude-sonnet-4-6",
  privacyMode: "local-first",
};

describe("handleStart — happy path (T-4.4)", () => {
  it("returns the validated StartOutput envelope", async () => {
    const result = await handleStart(VALID_INPUT, happyDeps());
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeTruthy();
    expect(() => StartOutputSchema.parse(result.structuredContent)).not.toThrow();
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.meetingId).toBe("m-test");
    expect(payload.pid).toBe(12345);
    expect(payload.rpcSocket).toBe("/tmp/meeting-copilot.sock");
  });

  it("invokes spawn('open', [deeplink], {shell:false, detached:true, stdio:'ignore'})", async () => {
    const { spawn, calls } = makeSpawnSpy();
    await handleStart(VALID_INPUT, {
      spawn,
      pollHandshake: async () => syntheticHandshake(),
    });
    expect(calls).toHaveLength(1);
    const [trace] = calls;
    expect(trace.cmd).toBe("open");
    expect(Array.isArray(trace.args)).toBe(true);
    expect(trace.args).toHaveLength(1);
    expect(trace.args[0].startsWith("meeting-copilot://start?")).toBe(true);
    expect(trace.options?.shell).toBe(false);
    expect(trace.options?.detached).toBe(true);
    expect(trace.options?.stdio).toBe("ignore");
  });

  it("passes the same deeplink string to spawn and to pollHandshake", async () => {
    const { spawn, calls } = makeSpawnSpy();
    let pollDeeplink = "";
    await handleStart(VALID_INPUT, {
      spawn,
      pollHandshake: async ({ deeplink }) => {
        pollDeeplink = deeplink;
        return syntheticHandshake();
      },
    });
    expect(calls).toHaveLength(1);
    expect(pollDeeplink).toBe(calls[0].args[0]);
  });

  it("computes the handshake deadline as now() + handshakeTimeoutMs", async () => {
    let observedDeadline = 0;
    await handleStart(VALID_INPUT, {
      spawn: makeSpawnSpy().spawn,
      now: () => 100_000,
      handshakeTimeoutMs: 7_000,
      pollHandshake: async ({ deadlineEpochMs }) => {
        observedDeadline = deadlineEpochMs;
        return syntheticHandshake();
      },
    });
    expect(observedDeadline).toBe(107_000);
  });
});

describe("handleStart — privacy gate (T-4.4 R-2)", () => {
  it("rejects local-first + deepgram with PrivacyModeViolation, BEFORE spawn", async () => {
    const { spawn, calls } = makeSpawnSpy();
    const result = await handleStart(
      { ...VALID_INPUT, sttProvider: "deepgram", privacyMode: "local-first" },
      { spawn, pollHandshake: async () => syntheticHandshake() },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^PrivacyModeViolation:/);
    // Critical: spawn MUST NOT have been called on the violation path.
    expect(calls).toHaveLength(0);
  });

  it("rejects mixed + elevenlabs (cloud STT in mixed mode is disallowed)", async () => {
    const { spawn, calls } = makeSpawnSpy();
    const result = await handleStart(
      { ...VALID_INPUT, sttProvider: "elevenlabs", privacyMode: "mixed" },
      { spawn, pollHandshake: async () => syntheticHandshake() },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^PrivacyModeViolation:/);
    expect(calls).toHaveLength(0);
  });

  it("ALLOWS cloud + deepgram (both cloud-eligible)", async () => {
    const { spawn, calls } = makeSpawnSpy();
    const result = await handleStart(
      { ...VALID_INPUT, sttProvider: "deepgram", privacyMode: "cloud" },
      { spawn, pollHandshake: async () => syntheticHandshake() },
    );
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });
});

describe("handleStart — path traversal (T-4.4 R-2)", () => {
  it("rejects ../ traversal in contextPaths with ContextNotFound, BEFORE spawn", async () => {
    const { spawn, calls } = makeSpawnSpy();
    const result = await handleStart(
      { ...VALID_INPUT, contextPaths: ["../../etc/passwd"] },
      { spawn, pollHandshake: async () => syntheticHandshake() },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^ContextNotFound:/);
    expect(result.content[0]?.text).toContain("traversal");
    expect(calls).toHaveLength(0);
  });

  it("rejects an empty-string contextPath via Zod (caught upstream)", async () => {
    const { spawn, calls } = makeSpawnSpy();
    // Zod's `.min(1)` on contextPaths[].string catches empty strings before
    // our `validateContextPaths` runs — the handler throws, and `server.ts`'s
    // try/catch turns that into an isError envelope. Either way: spawn must
    // not fire.
    await expect(
      handleStart(
        { ...VALID_INPUT, contextPaths: ["/ok.md", ""] },
        { spawn, pollHandshake: async () => syntheticHandshake() },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("handleStart — spawn / handshake failure paths (T-4.4)", () => {
  it("returns DeeplinkNotRegistered when spawn throws synchronously", async () => {
    const result = await handleStart(VALID_INPUT, {
      spawn: () => {
        throw new Error("ENOENT: open not found");
      },
      pollHandshake: async () => syntheticHandshake(),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^DeeplinkNotRegistered:/);
    expect(result.content[0]?.text).toContain("ENOENT");
  });

  it("returns DeeplinkNotRegistered when pollHandshake rejects", async () => {
    const { spawn } = makeSpawnSpy();
    const result = await handleStart(VALID_INPUT, {
      spawn,
      pollHandshake: async () => {
        throw new Error("socket connect timed out");
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^DeeplinkNotRegistered:/);
    expect(result.content[0]?.text).toContain("socket connect timed out");
  });

  it("default pollHandshake (no T-4.5 yet) returns DeeplinkNotRegistered envelope", async () => {
    const { spawn } = makeSpawnSpy();
    // No pollHandshake injected — exercises the default.
    const result = await handleStart(VALID_INPUT, { spawn });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^DeeplinkNotRegistered:/);
    expect(result.content[0]?.text).toMatch(/T-4\.5/);
  });
});

describe("handleStart — Zod strict mode (T-4.4)", () => {
  it("rejects unknown keys with a thrown Zod error (caught by server.ts)", async () => {
    await expect(
      handleStart(
        { ...VALID_INPUT, secretKey: "yes" },
        happyDeps(),
      ),
    ).rejects.toThrow();
  });

  it("rejects an out-of-enum sttProvider", async () => {
    await expect(
      handleStart(
        { ...VALID_INPUT, sttProvider: "google-cloud-stt" },
        happyDeps(),
      ),
    ).rejects.toThrow();
  });

  it("rejects an out-of-enum privacyMode", async () => {
    await expect(
      handleStart(
        { ...VALID_INPUT, privacyMode: "off" },
        happyDeps(),
      ),
    ).rejects.toThrow();
  });

  it("rejects an out-of-enum model", async () => {
    await expect(
      handleStart(
        { ...VALID_INPUT, model: "gpt-4" },
        happyDeps(),
      ),
    ).rejects.toThrow();
  });
});
