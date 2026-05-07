// Phase 4 T-4.7 — Shared timestamp formatter unit tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatTimestamp } from "./timestamp";

describe("formatTimestamp", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("zero ms renders as 00:00:00.000 (default separator '.')", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
  });

  it("zero ms renders as 00:00:00,000 with ',' separator", () => {
    expect(formatTimestamp(0, ",")).toBe("00:00:00,000");
  });

  it("rolls over correctly at 1 second + 1 millisecond", () => {
    expect(formatTimestamp(1001)).toBe("00:00:01.001");
  });

  it("zero-pads milliseconds to width 3", () => {
    expect(formatTimestamp(7)).toBe("00:00:00.007");
    expect(formatTimestamp(73)).toBe("00:00:00.073");
    expect(formatTimestamp(700)).toBe("00:00:00.700");
  });

  it("rolls over at 1 hour + 1 minute + 1 second + 123 ms", () => {
    const ms = 3600_000 + 60_000 + 1_000 + 123;
    expect(formatTimestamp(ms)).toBe("01:01:01.123");
  });

  it("preserves 99h cap and wraps via modulo at 100h+", () => {
    // 99h exactly
    expect(formatTimestamp(99 * 3600 * 1000)).toBe("99:00:00.000");
    // 100h wraps to 00 with a console.warn
    expect(formatTimestamp(100 * 3600 * 1000)).toBe("00:00:00.000");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("hours=100 exceeds 99h cap"),
    );
  });

  it("clamps negative input to 0 with a console.warn", () => {
    expect(formatTimestamp(-500)).toBe("00:00:00.000");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clamping negative/NaN input -500 to 0"),
    );
  });

  it("clamps NaN input to 0 with a console.warn", () => {
    expect(formatTimestamp(Number.NaN)).toBe("00:00:00.000");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("floors fractional milliseconds (no rounding artefacts)", () => {
    expect(formatTimestamp(1234.7)).toBe("00:00:01.234");
  });

  it("comma separator passes through unchanged in cue body", () => {
    const ms = 3600_000 * 2 + 60_000 * 30 + 5_000 + 999;
    expect(formatTimestamp(ms, ",")).toBe("02:30:05,999");
  });
});
