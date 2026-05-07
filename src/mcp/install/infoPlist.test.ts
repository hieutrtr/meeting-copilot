// Phase 4 T-4.3 — parseInfoPlistVersion unit tests.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseInfoPlistVersion } from "./infoPlist";

const fixturesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
);

const installedPlist = readFileSync(
  resolve(fixturesDir, "Info.plist.installed.xml"),
  "utf8",
);
const missingVersionPlist = readFileSync(
  resolve(fixturesDir, "Info.plist.missing-version.xml"),
  "utf8",
);

describe("parseInfoPlistVersion (T-4.3)", () => {
  it("extracts CFBundleShortVersionString from a realistic Apple plist", () => {
    expect(parseInfoPlistVersion(installedPlist)).toBe("0.3.0");
  });

  it("returns null when the key is absent", () => {
    expect(parseInfoPlistVersion(missingVersionPlist)).toBeNull();
  });

  it("returns null on non-plist / garbage input", () => {
    expect(parseInfoPlistVersion("not xml")).toBeNull();
    expect(parseInfoPlistVersion("")).toBeNull();
    expect(parseInfoPlistVersion("<dict></dict>")).toBeNull();
  });

  it("handles compact / single-line plist formatting", () => {
    const compact = "<key>CFBundleShortVersionString</key><string>2.5.1</string>";
    expect(parseInfoPlistVersion(compact)).toBe("2.5.1");
  });

  it("handles whitespace and newlines between key and string tags", () => {
    const spread =
      "<key>CFBundleShortVersionString</key>\n   \t  <string>1.2.3-beta.4</string>";
    expect(parseInfoPlistVersion(spread)).toBe("1.2.3-beta.4");
  });

  it("returns null when the string body is empty", () => {
    const empty =
      "<key>CFBundleShortVersionString</key><string></string>";
    expect(parseInfoPlistVersion(empty)).toBeNull();
  });

  it("ignores other CFBundle* keys (no false-positive on CFBundleVersion)", () => {
    const onlyBuildNumber =
      "<key>CFBundleVersion</key><string>42</string>";
    expect(parseInfoPlistVersion(onlyBuildNumber)).toBeNull();
  });
});
