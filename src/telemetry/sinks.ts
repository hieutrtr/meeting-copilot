// Phase 3 T-3.9 — Telemetry sinks.
//
// The append loop talks to a `TelemetrySink`; the in-memory sink (test gate +
// the production stand-in until Phase 3.x lands the Tauri-fs sink) holds the
// rotation contract. The no-op sink is a safety belt — it is what the append
// loop should NOT touch when the opt-in flag is OFF, but it is also the safe
// default if a caller forgets to wire a real sink.
//
// Byte counting uses TextEncoder (UTF-8) — emoji / non-ASCII characters take
// more than one JS-string code unit, and a naive `.length` would let large
// non-ASCII payloads sneak past the byte cap. The encoder is created lazily
// (Vitest jsdom + node both expose it).

export interface TelemetrySink {
  /** Append a single line. Implementations append a trailing "\n". */
  append(line: string): void;
  /** Force a rotation regardless of size. Generally append() decides on its own. */
  rotate(): void;
  /** Bytes in the *current* segment (does not include archives). */
  size(): number;
  /** Test-only inspection. Production sinks may omit. */
  inspect?(): { current: string; archives: readonly string[]; rotations: number };
}

export interface MemorySinkOptions {
  /** Rotate when an append would push the current segment past this many bytes. */
  maxBytes?: number;
  /** Keep at most this many ARCHIVED segments (oldest dropped on overflow). */
  maxFiles?: number;
}

/** Default 10 MB per segment per AC line: "log file rotates at 10 MB". */
export const DEFAULT_TELEMETRY_MAX_BYTES = 10_000_000 as const;
export const DEFAULT_TELEMETRY_MAX_FILES = 3 as const;

let _encoder: TextEncoder | null = null;
function utf8ByteLength(s: string): number {
  if (!_encoder) _encoder = new TextEncoder();
  return _encoder.encode(s).length;
}

export function createMemorySink(opts?: MemorySinkOptions): TelemetrySink {
  const maxBytes = opts?.maxBytes ?? DEFAULT_TELEMETRY_MAX_BYTES;
  const maxFiles = opts?.maxFiles ?? DEFAULT_TELEMETRY_MAX_FILES;

  let current = "";
  let currentBytes = 0;
  const archives: string[] = [];
  let rotations = 0;

  function rotate(): void {
    archives.unshift(current);
    while (archives.length > maxFiles) archives.pop();
    current = "";
    currentBytes = 0;
    rotations += 1;
  }

  function append(line: string): void {
    if (typeof line !== "string") return;
    const lineBytes = utf8ByteLength(line) + 1; // +1 for the trailing "\n"
    // Pre-rotate when the next append would cross the cap. A single line that
    // by itself exceeds maxBytes still goes through (we only rotate when there
    // is something to preserve) — the next append will rotate it out.
    if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
      rotate();
    }
    current += line + "\n";
    currentBytes += lineBytes;
  }

  function size(): number {
    return currentBytes;
  }

  function inspect() {
    return {
      current,
      archives: Object.freeze([...archives]),
      rotations,
    };
  }

  return { append, rotate, size, inspect };
}

export function createNoopSink(): TelemetrySink {
  return {
    append: () => undefined,
    rotate: () => undefined,
    size: () => 0,
    inspect: () => ({ current: "", archives: Object.freeze([]), rotations: 0 }),
  };
}
