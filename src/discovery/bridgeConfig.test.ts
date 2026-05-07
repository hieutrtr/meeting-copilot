// Phase 4 T-4.8 — bridgeConfig.ts unit tests.
//
// Pure DI: every fs/env/clock seam is overrideable. No global module mocks,
// no real filesystem writes. The fake fs is an in-memory `Map<path, content>`
// rebuilt per test.

import { describe, expect, it } from "vitest";

import {
  BridgeConfigInvalidError,
  ConfigSchemaUnsupportedError,
  registerMeetingCopilot,
  resolveBridgeHome,
  resolveConfigPath,
  readBridgeConfig,
  type DiscoveryDeps,
} from "./bridgeConfig";

interface FakeFs {
  files: Map<string, string>;
  mkdirs: string[];
  writes: Array<{ path: string; contents: string }>;
  deps: DiscoveryDeps;
}

function makeFakeFs(initial: Record<string, string> = {}, overrides: Partial<DiscoveryDeps> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(initial));
  const mkdirs: string[] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  const deps: DiscoveryDeps = {
    homeDir: () => "/Users/test",
    bridgeHomeEnv: undefined,
    pid: () => 1234,
    now: () => new Date("2026-05-07T10:30:00.000Z"),
    exists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v == null) {
        const err = new Error(`ENOENT: no such file ${p}`) as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    mkdirp: (p) => {
      mkdirs.push(p);
    },
    writeFileAtomic: (p, contents) => {
      writes.push({ path: p, contents });
      files.set(p, contents);
    },
    ...overrides,
  };
  return { files, mkdirs, writes, deps };
}

const DEFAULT_HOME = "/Users/test/.claude-bridge";
const DEFAULT_CFG = `${DEFAULT_HOME}/config.json`;
const APP_PATH = "/Applications/Meeting Copilot.app";
const BIN_PATH = "/Applications/Meeting Copilot.app/Contents/Resources/mcp-bin";

describe("resolveBridgeHome (T-4.8)", () => {
  it("defaults to ~/.claude-bridge under injected homeDir", () => {
    const fs = makeFakeFs();
    expect(resolveBridgeHome(fs.deps)).toBe(DEFAULT_HOME);
  });

  it("honors absolute CLAUDE_BRIDGE_HOME override", () => {
    const fs = makeFakeFs({}, { bridgeHomeEnv: "/tmp/foo" });
    expect(resolveBridgeHome(fs.deps)).toBe("/tmp/foo");
  });

  it("rejects tilde-prefixed CLAUDE_BRIDGE_HOME (no expansion)", () => {
    const fs = makeFakeFs({}, { bridgeHomeEnv: "~/foo" });
    expect(() => resolveBridgeHome(fs.deps)).toThrow(BridgeConfigInvalidError);
  });

  it("rejects relative CLAUDE_BRIDGE_HOME", () => {
    const fs = makeFakeFs({}, { bridgeHomeEnv: "foo/bar" });
    expect(() => resolveBridgeHome(fs.deps)).toThrow(BridgeConfigInvalidError);
  });

  it("rejects CLAUDE_BRIDGE_HOME containing .. segments", () => {
    const fs = makeFakeFs({}, { bridgeHomeEnv: "/tmp/foo/../etc" });
    expect(() => resolveBridgeHome(fs.deps)).toThrow(BridgeConfigInvalidError);
  });

  it("treats empty CLAUDE_BRIDGE_HOME as unset", () => {
    const fs = makeFakeFs({}, { bridgeHomeEnv: "" });
    expect(resolveBridgeHome(fs.deps)).toBe(DEFAULT_HOME);
  });
});

describe("resolveConfigPath (T-4.8)", () => {
  it("joins bridge home + config.json", () => {
    const fs = makeFakeFs();
    expect(resolveConfigPath(fs.deps)).toBe(DEFAULT_CFG);
  });
});

describe("readBridgeConfig (T-4.8)", () => {
  it("returns default-empty shape when config absent", () => {
    const fs = makeFakeFs();
    const cfg = readBridgeConfig(fs.deps);
    expect(cfg.version).toBe(1);
    expect(cfg.meeting_copilots).toEqual([]);
  });

  it("parses an existing config and preserves passthrough keys", () => {
    const fs = makeFakeFs({
      [DEFAULT_CFG]: JSON.stringify({
        version: 1,
        daemon: { version: "0.7.0", db_path: "/x/bridge.db" },
        dashboards: [{ version: "0.1.0", path: "/x/dash", default: true }],
        meeting_copilots: [],
        channels: { telegram: { enabled: true } },
      }),
    });
    const cfg = readBridgeConfig(fs.deps);
    expect(cfg.version).toBe(1);
    expect((cfg as Record<string, unknown>).daemon).toMatchObject({ version: "0.7.0" });
    expect((cfg as Record<string, unknown>).dashboards).toBeInstanceOf(Array);
    expect((cfg as Record<string, unknown>).channels).toMatchObject({ telegram: { enabled: true } });
  });

  it("throws BridgeConfigInvalid on corrupt JSON", () => {
    const fs = makeFakeFs({ [DEFAULT_CFG]: "{not valid json" });
    expect(() => readBridgeConfig(fs.deps)).toThrow(BridgeConfigInvalidError);
  });

  it("throws BridgeConfigInvalid when top-level is an array", () => {
    const fs = makeFakeFs({ [DEFAULT_CFG]: "[]" });
    expect(() => readBridgeConfig(fs.deps)).toThrow(BridgeConfigInvalidError);
  });

  it("throws ConfigSchemaUnsupported when config.version > 1", () => {
    const fs = makeFakeFs({ [DEFAULT_CFG]: JSON.stringify({ version: 2 }) });
    expect(() => readBridgeConfig(fs.deps)).toThrow(ConfigSchemaUnsupportedError);
  });

  it("throws BridgeConfigInvalid when config.version is 0", () => {
    const fs = makeFakeFs({ [DEFAULT_CFG]: JSON.stringify({ version: 0 }) });
    expect(() => readBridgeConfig(fs.deps)).toThrow(BridgeConfigInvalidError);
  });

  it("throws BridgeConfigInvalid when meeting_copilots[].path is wrong type", () => {
    const fs = makeFakeFs({
      [DEFAULT_CFG]: JSON.stringify({
        version: 1,
        meeting_copilots: [{ version: "1.0.0", path: 42 }],
      }),
    });
    expect(() => readBridgeConfig(fs.deps)).toThrow(BridgeConfigInvalidError);
  });
});

describe("registerMeetingCopilot — fresh-config path (T-4.8)", () => {
  it("creates config.json + appends entry when bridge home empty", () => {
    const fs = makeFakeFs();
    const result = registerMeetingCopilot(
      { version: "1.0.0", binPath: BIN_PATH, appPath: APP_PATH },
      fs.deps,
    );
    expect(result.alreadyRegistered).toBe(false);
    expect(result.configPath).toBe(DEFAULT_CFG);
    expect(result.entry.version).toBe("1.0.0");
    expect(result.entry.path).toBe(APP_PATH);
    expect(result.entry.mcp_bin).toBe(BIN_PATH);
    expect(result.entry.installed_at).toBe("2026-05-07T10:30:00.000Z");
    expect(result.entry.default).toBe(false);

    expect(fs.mkdirs).toContain(DEFAULT_HOME);
    expect(fs.writes).toHaveLength(1);
    const persisted = JSON.parse(fs.writes[0]!.contents);
    expect(persisted.version).toBe(1);
    expect(persisted.meeting_copilots).toHaveLength(1);
    expect(persisted.meeting_copilots[0].path).toBe(APP_PATH);
  });

  it("falls back to binPath when appPath omitted", () => {
    const fs = makeFakeFs();
    const result = registerMeetingCopilot(
      { version: "1.0.0", binPath: BIN_PATH },
      fs.deps,
    );
    expect(result.entry.path).toBe(BIN_PATH);
  });

  it("includes installed_from when provided", () => {
    const fs = makeFakeFs();
    const result = registerMeetingCopilot(
      {
        version: "1.0.0",
        binPath: BIN_PATH,
        appPath: APP_PATH,
        installedFrom: "github.com/anthropic/meeting-copilot@v1.0.0",
      },
      fs.deps,
    );
    expect(result.entry.installed_from).toBe("github.com/anthropic/meeting-copilot@v1.0.0");
  });
});

describe("registerMeetingCopilot — append + idempotency (T-4.8)", () => {
  const existingDaemon = {
    version: 1 as const,
    daemon: { version: "0.7.0", socket: "/x/daemon.sock" },
    dashboards: [{ version: "0.1.0", path: "/x/dash", default: true }],
    channels: { telegram: { enabled: true } },
    meeting_copilots: [] as unknown[],
  };

  it("appends entry to existing config preserving passthrough keys", () => {
    const fs = makeFakeFs({ [DEFAULT_CFG]: JSON.stringify(existingDaemon) });
    const result = registerMeetingCopilot(
      { version: "1.0.0", binPath: BIN_PATH, appPath: APP_PATH },
      fs.deps,
    );
    expect(result.alreadyRegistered).toBe(false);
    expect(fs.writes).toHaveLength(1);
    const persisted = JSON.parse(fs.writes[0]!.contents);
    // Original daemon/dashboards/channels keys must survive the round-trip.
    expect(persisted.daemon).toMatchObject({ version: "0.7.0" });
    expect(persisted.dashboards).toEqual([
      { version: "0.1.0", path: "/x/dash", default: true },
    ]);
    expect(persisted.channels).toMatchObject({ telegram: { enabled: true } });
    expect(persisted.meeting_copilots).toHaveLength(1);
  });

  it("is idempotent: matching path → no atomic write, alreadyRegistered:true", () => {
    const initial = {
      ...existingDaemon,
      meeting_copilots: [
        {
          version: "1.0.0",
          path: APP_PATH,
          default: false,
          installed_at: "2026-04-01T00:00:00.000Z",
          mcp_bin: BIN_PATH,
        },
      ],
    };
    const fs = makeFakeFs({ [DEFAULT_CFG]: JSON.stringify(initial) });
    const result = registerMeetingCopilot(
      { version: "1.0.1", binPath: BIN_PATH, appPath: APP_PATH },
      fs.deps,
    );
    expect(result.alreadyRegistered).toBe(true);
    expect(result.entry.installed_at).toBe("2026-04-01T00:00:00.000Z");
    expect(fs.writes).toHaveLength(0);
  });

  it("appends a second entry when the existing one has a different path", () => {
    const initial = {
      ...existingDaemon,
      meeting_copilots: [
        {
          version: "0.9.0",
          path: "/Applications/Meeting Copilot.old.app",
          default: false,
        },
      ],
    };
    const fs = makeFakeFs({ [DEFAULT_CFG]: JSON.stringify(initial) });
    const result = registerMeetingCopilot(
      { version: "1.0.0", binPath: BIN_PATH, appPath: APP_PATH },
      fs.deps,
    );
    expect(result.alreadyRegistered).toBe(false);
    expect(fs.writes).toHaveLength(1);
    const persisted = JSON.parse(fs.writes[0]!.contents);
    expect(persisted.meeting_copilots).toHaveLength(2);
    expect(persisted.meeting_copilots[0].path).toBe("/Applications/Meeting Copilot.old.app");
    expect(persisted.meeting_copilots[1].path).toBe(APP_PATH);
  });
});

describe("registerMeetingCopilot — input validation (T-4.8)", () => {
  it("rejects empty version", () => {
    const fs = makeFakeFs();
    expect(() =>
      registerMeetingCopilot({ version: "", binPath: BIN_PATH }, fs.deps),
    ).toThrow(BridgeConfigInvalidError);
  });

  it("rejects tilde-prefixed binPath", () => {
    const fs = makeFakeFs();
    expect(() =>
      registerMeetingCopilot({ version: "1.0.0", binPath: "~/bin/mcp" }, fs.deps),
    ).toThrow(BridgeConfigInvalidError);
  });

  it("rejects relative binPath", () => {
    const fs = makeFakeFs();
    expect(() =>
      registerMeetingCopilot({ version: "1.0.0", binPath: "bin/mcp" }, fs.deps),
    ).toThrow(BridgeConfigInvalidError);
  });

  it("rejects binPath containing .. segments", () => {
    const fs = makeFakeFs();
    expect(() =>
      registerMeetingCopilot(
        { version: "1.0.0", binPath: "/opt/../etc/passwd" },
        fs.deps,
      ),
    ).toThrow(BridgeConfigInvalidError);
  });

  it("rejects tilde-prefixed appPath", () => {
    const fs = makeFakeFs();
    expect(() =>
      registerMeetingCopilot(
        { version: "1.0.0", binPath: BIN_PATH, appPath: "~/Apps/MC.app" },
        fs.deps,
      ),
    ).toThrow(BridgeConfigInvalidError);
  });

  it("propagates ConfigSchemaUnsupported when config.version > 1", () => {
    const fs = makeFakeFs({ [DEFAULT_CFG]: JSON.stringify({ version: 5 }) });
    expect(() =>
      registerMeetingCopilot(
        { version: "1.0.0", binPath: BIN_PATH, appPath: APP_PATH },
        fs.deps,
      ),
    ).toThrow(ConfigSchemaUnsupportedError);
  });
});

describe("registerMeetingCopilot — atomic write semantics (T-4.8)", () => {
  it("writes JSON with trailing newline (POSIX text-file convention)", () => {
    const fs = makeFakeFs();
    registerMeetingCopilot(
      { version: "1.0.0", binPath: BIN_PATH, appPath: APP_PATH },
      fs.deps,
    );
    expect(fs.writes[0]!.contents.endsWith("\n")).toBe(true);
  });

  it("invokes mkdirp on the bridge-home directory before write", () => {
    const fs = makeFakeFs();
    registerMeetingCopilot(
      { version: "1.0.0", binPath: BIN_PATH, appPath: APP_PATH },
      fs.deps,
    );
    expect(fs.mkdirs[0]).toBe(DEFAULT_HOME);
  });

  it("uses pid-suffixed tmp file via default writer (smoke check on shape)", () => {
    // Custom writer that records the temp-file approach, mirroring the
    // claude-bridge daemon installer pattern.
    const fs = makeFakeFs(
      {},
      {
        writeFileAtomic: (path, contents) => {
          // The default writer would produce `<path>.tmp.<pid>` then rename.
          // Here we only assert that the default path is delivered to the
          // injected writer — the temp-file detail is unit-tested by the
          // default writer behavior in a separate (real-fs) integration.
          fs.writes.push({ path, contents });
          fs.files.set(path, contents);
        },
      },
    );
    registerMeetingCopilot(
      { version: "1.0.0", binPath: BIN_PATH, appPath: APP_PATH },
      fs.deps,
    );
    expect(fs.writes[0]!.path).toBe(DEFAULT_CFG);
  });
});
