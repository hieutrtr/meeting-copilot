// Phase 3 T-3.7 — TTS feature flag.
//
// ARCH §4: "V1 không bật TTS mặc định (answer là text trên UI). V2 cho phép user
// bật 'spoken answer' cho hands-free mode." Phase 3 ships the seam (trait,
// adapter, button) but defaults the entire surface OFF — `<AnswerPanel/>` does
// NOT render the Speak button unless the parent (App.tsx) explicitly passes the
// `onSpeak` prop, and App.tsx only passes the prop when this flag is true.
//
// The flag reads from Vite's `import.meta.env.VITE_ENABLE_TTS`. Truthy: any
// string except `""`, `"0"`, `"false"`, `"off"`, `"no"` (case-insensitive). The
// pure helper `readTtsFlag(env)` takes the env object directly so tests can
// assert behavior without `vi.stubEnv` round-trips, and the production constant
// `ENABLE_TTS` reads from `import.meta.env` once at module-load time.

export const TTS_FEATURE_FLAG_ENV_VAR = "VITE_ENABLE_TTS" as const;

const FALSY_LITERALS: ReadonlySet<string> = new Set(["", "0", "false", "off", "no"]);

/** Pure helper: given an env-like object, return whether the TTS flag is enabled. */
export function readTtsFlag(env: Record<string, unknown> | null | undefined): boolean {
  if (!env) return false;
  const raw = env[TTS_FEATURE_FLAG_ENV_VAR];
  if (typeof raw !== "string") return false;
  return !FALSY_LITERALS.has(raw.toLowerCase());
}

function readImportMetaEnv(): Record<string, unknown> | null {
  try {
    const meta = import.meta as ImportMeta & {
      env?: Record<string, unknown>;
    };
    return meta.env ?? null;
  } catch {
    return null;
  }
}

/**
 * Module-load snapshot of the flag. App.tsx reads this to decide whether to
 * pass `onSpeak` to `<AnswerPanel/>`. Tests should NOT import this — they
 * exercise `readTtsFlag()` directly with an injected env so each test is
 * isolated.
 */
export const ENABLE_TTS: boolean = readTtsFlag(readImportMetaEnv());
