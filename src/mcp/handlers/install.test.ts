// Phase 4 T-4.3 — handleInstall unit tests.
//
// All tests use deps injection (no global fs mocking). Fixtures land in
// `src/mcp/__fixtures__/` and are read once per file.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { InstallOutputSchema } from "../tools";
import {
  DEFAULT_APP_BUNDLE_PATH,
  DEFAULT_DOWNLOAD_URL,
  handleInstall,
  type InstallHandlerDeps,
} from "./install";

const fixturesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
);

const INSTALLED_PLIST = readFileSync(
  resolve(fixturesDir, "Info.plist.installed.xml"),
  "utf8",
);
const MALFORMED_PLIST = readFileSync(
  resolve(fixturesDir, "Info.plist.missing-version.xml"),
  "utf8",
);

const EXPECTED_VERSION = "1.0.0";

function asPayload(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function depsReturning(plist: string | null): InstallHandlerDeps {
  return {
    readFile: () => plist,
    packageVersion: EXPECTED_VERSION,
  };
}

describe("handleInstall (T-4.3)", () => {
  it("returns installed:true with version parsed from Info.plist", async () => {
    const result = await handleInstall({}, depsReturning(INSTALLED_PLIST));
    expect(result.isError).toBeFalsy();
    const payload = asPayload(result);
    expect(payload.installed).toBe(true);
    expect(payload.version).toBe("0.3.0");
    expect(payload.expectedVersion).toBe(EXPECTED_VERSION);
    expect(typeof payload.message).toBe("string");
  });

  it("returns installed:false with downloadUrl when bundle missing", async () => {
    const result = await handleInstall({}, depsReturning(null));
    expect(result.isError).toBeFalsy();
    const payload = asPayload(result);
    expect(payload.installed).toBe(false);
    expect(payload.downloadUrl).toBe(DEFAULT_DOWNLOAD_URL);
    expect(payload.expectedVersion).toBe(EXPECTED_VERSION);
    expect(payload.message).toMatch(/Install from/);
  });

  it("returns installed:true but no version when Info.plist is malformed", async () => {
    const result = await handleInstall({}, depsReturning(MALFORMED_PLIST));
    expect(result.isError).toBeFalsy();
    const payload = asPayload(result);
    expect(payload.installed).toBe(true);
    expect(payload.version).toBeUndefined();
    expect(payload.expectedVersion).toBe(EXPECTED_VERSION);
    expect(payload.downloadUrl).toBe(DEFAULT_DOWNLOAD_URL);
    expect(payload.message).toMatch(/malformed/);
    expect(payload.message).toMatch(/Reinstall from/);
  });

  it("output validates against InstallOutputSchema in all three states", async () => {
    for (const plist of [INSTALLED_PLIST, MALFORMED_PLIST, null]) {
      const result = await handleInstall({}, depsReturning(plist));
      expect(() => InstallOutputSchema.parse(result.structuredContent)).not.toThrow();
    }
  });

  it("uses args.path over the default /Applications bundle", async () => {
    let observedPath = "";
    await handleInstall(
      { path: "/tmp/Custom.app" },
      {
        readFile: (p) => {
          observedPath = p;
          return null;
        },
        packageVersion: EXPECTED_VERSION,
      },
    );
    // resolve("/tmp/Custom.app", "Contents/Info.plist") preserves the absolute prefix.
    expect(observedPath.startsWith("/tmp/Custom.app/")).toBe(true);
    expect(observedPath.endsWith("Contents/Info.plist")).toBe(true);
  });

  it("falls back to deps.appBundlePath when args.path is absent", async () => {
    let observedPath = "";
    await handleInstall(
      {},
      {
        readFile: (p) => {
          observedPath = p;
          return null;
        },
        packageVersion: EXPECTED_VERSION,
        appBundlePath: "/Volumes/External.app",
      },
    );
    expect(observedPath.startsWith("/Volumes/External.app/")).toBe(true);
  });

  it("falls back to /Applications when neither args.path nor deps.appBundlePath set", async () => {
    let observedPath = "";
    await handleInstall(
      {},
      {
        readFile: (p) => {
          observedPath = p;
          return null;
        },
        packageVersion: EXPECTED_VERSION,
      },
    );
    expect(observedPath.startsWith(DEFAULT_APP_BUNDLE_PATH)).toBe(true);
  });

  it("uses custom downloadUrl from deps", async () => {
    const result = await handleInstall(
      {},
      {
        readFile: () => null,
        packageVersion: EXPECTED_VERSION,
        downloadUrl: "https://example.com/mc.dmg",
      },
    );
    const payload = asPayload(result);
    expect(payload.downloadUrl).toBe("https://example.com/mc.dmg");
    expect(payload.message).toContain("https://example.com/mc.dmg");
  });

  it("never mutates the filesystem (idempotent across two calls)", async () => {
    const a = await handleInstall({}, depsReturning(INSTALLED_PLIST));
    const b = await handleInstall({}, depsReturning(INSTALLED_PLIST));
    expect(a.structuredContent).toEqual(b.structuredContent);
  });

  it("rejects unknown keys in args (Zod strict mode)", async () => {
    await expect(handleInstall({ extra: "no" })).rejects.toThrow();
  });

  it("accepts the documented optional input shape", async () => {
    await expect(
      handleInstall(
        { source: "github", ref: "v1.0.0", version: "1.0.0" },
        depsReturning(null),
      ),
    ).resolves.toBeTruthy();
  });

  it("matching version yields a 'matches expectedVersion' message", async () => {
    const result = await handleInstall(
      {},
      {
        readFile: () => INSTALLED_PLIST,
        packageVersion: "0.3.0", // matches the fixture's CFBundleShortVersionString
      },
    );
    const payload = asPayload(result);
    expect(payload.message).toMatch(/matches expectedVersion/);
    expect(payload.installed).toBe(true);
    expect(payload.version).toBe("0.3.0");
  });

  it("mismatched version yields an 'upgrade' hint pointing at downloadUrl", async () => {
    const result = await handleInstall(
      {},
      {
        readFile: () => INSTALLED_PLIST,
        packageVersion: "1.0.0",
        downloadUrl: "https://example.com/mc.dmg",
      },
    );
    const payload = asPayload(result);
    expect(payload.message).toMatch(/upgrade/);
    expect(payload.message).toContain("https://example.com/mc.dmg");
  });

  it("default readFile absorbs missing-file errors (no throw on absent path)", async () => {
    // No deps injection — exercise the production default readFile against a
    // path that cannot exist on any developer machine. The handler must
    // resolve to `installed: false` rather than throwing.
    const result = await handleInstall({
      path: "/var/empty/__nonexistent_meeting_copilot_t43_test__.app",
    });
    expect(result.isError).toBeFalsy();
    const payload = asPayload(result);
    expect(payload.installed).toBe(false);
  });
});
