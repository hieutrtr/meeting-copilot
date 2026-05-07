// Phase 4 T-4.2 — Zod schema + tool registry tests.
//
// AC-4 / AC-5 / AC-6 / AC-7 from `docs/tasks/phase-4/T-4.2-mcp-skeleton.md` —
// pinning verification, registry shape, frozen error-code list.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  ExportInputSchema,
  InstallInputSchema,
  PRIVACY_MODE_ENUM,
  STT_PROVIDER_ENUM,
  StartInputSchema,
  StatusInputSchema,
  StopInputSchema,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  errorResult,
  isToolName,
  notImplementedResult,
} from "./tools";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("TOOL_NAMES registry", () => {
  it("lists exactly the 5 Phase-4 tools in the documented order", () => {
    expect([...TOOL_NAMES]).toEqual([
      "bridge_meeting_install",
      "bridge_meeting_start",
      "bridge_meeting_status",
      "bridge_meeting_stop",
      "bridge_meeting_export",
    ]);
  });

  it("isToolName accepts known names and rejects unknown / non-strings", () => {
    expect(isToolName("bridge_meeting_install")).toBe(true);
    expect(isToolName("bridge_meeting_export")).toBe(true);
    expect(isToolName("bridge_dashboard_install")).toBe(false);
    expect(isToolName("")).toBe(false);
    expect(isToolName(undefined)).toBe(false);
    expect(isToolName(123)).toBe(false);
  });
});

describe("TOOL_DEFINITIONS shape (used by tools/list)", () => {
  it("has one definition per registered name, in registry order", () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...TOOL_NAMES]);
  });

  it("every definition carries a non-empty description and a JSON-Schema object", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.inputSchema).toBeTypeOf("object");
      // zod-to-json-schema emits `type: "object"` at the root for object schemas.
      expect((def.inputSchema as { type?: string }).type).toBe("object");
    }
  });

  it("install schema accepts the documented optional shape", () => {
    expect(() => InstallInputSchema.parse({})).not.toThrow();
    expect(() =>
      InstallInputSchema.parse({ source: "github", ref: "v1.0.0" }),
    ).not.toThrow();
    // strict() rejects unknown keys.
    expect(() => InstallInputSchema.parse({ extra: "no" })).toThrow();
  });

  it("start schema requires sttProvider, model, privacyMode and gates enums", () => {
    expect(() => StartInputSchema.parse({})).toThrow();
    expect(() =>
      StartInputSchema.parse({
        contextPaths: ["./README.md"],
        sttProvider: "mlx",
        model: "claude-sonnet-4-6",
        privacyMode: "local-first",
      }),
    ).not.toThrow();
    // Unknown sttProvider rejected.
    expect(() =>
      StartInputSchema.parse({
        contextPaths: [],
        sttProvider: "whisper-cloud",
        model: "claude-sonnet-4-6",
        privacyMode: "local-first",
      }),
    ).toThrow();
  });

  it("status schema accepts empty body and meetingId-only filter", () => {
    expect(() => StatusInputSchema.parse({})).not.toThrow();
    expect(() => StatusInputSchema.parse({ meetingId: "m_42" })).not.toThrow();
    expect(() => StatusInputSchema.parse({ meetingId: "" })).toThrow();
  });

  it("stop schema requires meetingId", () => {
    expect(() => StopInputSchema.parse({})).toThrow();
    expect(() => StopInputSchema.parse({ meetingId: "m_42" })).not.toThrow();
  });

  it("export schema requires meetingId + format from enum", () => {
    expect(() => ExportInputSchema.parse({ meetingId: "m_42" })).toThrow();
    expect(() =>
      ExportInputSchema.parse({ meetingId: "m_42", format: "pdf" }),
    ).toThrow();
    for (const fmt of ["markdown", "json", "vtt", "srt"] as const) {
      expect(() =>
        ExportInputSchema.parse({ meetingId: "m_42", format: fmt }),
      ).not.toThrow();
    }
  });
});

describe("Closed error-code set", () => {
  it("ERROR_CODES is frozen and contains the 8 documented codes", () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expect([...ERROR_CODES].sort()).toEqual(
      [
        "BridgeConfigInvalid",
        "ConfigSchemaUnsupported",
        "ContextNotFound",
        "DeeplinkNotRegistered",
        "InvalidMeetingId",
        "MeetingNotFound",
        "NotImplemented",
        "PrivacyModeViolation",
      ].sort(),
    );
  });

  it("errorResult formats as `<Code>: <message>`", () => {
    const r = errorResult("PrivacyModeViolation", "deepgram blocked under local-first");
    expect(r.isError).toBe(true);
    expect(r.content[0]?.type).toBe("text");
    expect(r.content[0]?.text).toBe(
      "PrivacyModeViolation: deepgram blocked under local-first",
    );
  });

  it("notImplementedResult points at the future task", () => {
    const r = notImplementedResult("T-4.7");
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^NotImplemented: /);
    expect(r.content[0]?.text).toContain("T-4.7");
  });
});

describe("Privacy / STT enum parity (T-4.1 §4 lock)", () => {
  it("STT_PROVIDER_ENUM matches the privacy module's id list", async () => {
    const { isSttProviderId } = await import("../llm/sttPricing");
    for (const provider of STT_PROVIDER_ENUM) {
      expect(isSttProviderId(provider)).toBe(true);
    }
  });

  it("PRIVACY_MODE_ENUM matches privacyMode module", async () => {
    const { PRIVACY_MODES } = await import("../privacy/privacyMode");
    expect([...PRIVACY_MODE_ENUM].sort()).toEqual([...PRIVACY_MODES].sort());
  });
});

describe("package.json pin verification (AC-4..AC-7)", () => {
  function readPackageJson(): {
    raw: string;
    parsed: {
      dependencies?: Record<string, string>;
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
  } {
    const pkgPath = resolve(repoRoot, "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    return { raw, parsed: JSON.parse(raw) };
  }

  it("pins @modelcontextprotocol/sdk to ^1.0.0 (claude-bridge daemon parity)", () => {
    const { raw, parsed } = readPackageJson();
    expect(parsed.dependencies?.["@modelcontextprotocol/sdk"]).toBe("^1.0.0");
    expect(raw).toMatch(/"@modelcontextprotocol\/sdk":\s*"\^1\.0\.0"/);
  });

  it("pins zod to ^3.23.0", () => {
    const { parsed } = readPackageJson();
    expect(parsed.dependencies?.zod).toBe("^3.23.0");
  });

  it("registers `meeting-copilot-mcp` bin pointing at src/mcp/bin.ts", () => {
    const { parsed } = readPackageJson();
    expect(parsed.bin?.["meeting-copilot-mcp"]).toBe("src/mcp/bin.ts");
  });

  it("exposes `mcp-server` script", () => {
    const { parsed } = readPackageJson();
    expect(parsed.scripts?.["mcp-server"]).toBe("bun run src/mcp/bin.ts");
  });
});
