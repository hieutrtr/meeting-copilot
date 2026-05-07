// Phase 3 T-3.7 — TTS provider interface (TS).
//
// Verbatim from ARCH §4 (lines 130–135) with names tightened:
//
//     interface TTSProvider {
//       name: "mlx" | "elevenlabs"
//       speak(text: string, opts: { voice: string }): AsyncIterable<AudioChunk>
//     }
//
// The interface is async-iterable so the audio player can render the first
// chunk before synthesis is complete (latency target < 400 ms first audio per
// ARCH §4 — `eleven_turbo_v2`). A synchronous `Vec<TtsAudioChunk>` would force
// the caller to buffer the whole utterance, blowing the AC-4 budget once
// production audio output is wired.
//
// Implementations:
//   - `ElevenLabsTts` — `src/tts/elevenLabsTts.ts` (T-3.7).
//   - MLX TTS (`kokoro-mlx` / `parler-tts-mini`) — Phase 3.x, ARCH §4.

export type TtsProviderName = "mlx" | "elevenlabs";

/** One synthesised audio buffer. PCM 16-bit signed, mono, sample-rate stamped
 *  from the request (ElevenLabs default = 16 kHz, matching the helper-daemon's
 *  STT input convention so a future TTS-as-mic loopback path needs no
 *  resampling).
 *
 *  `ts_ms` is relative to the `speak()` call — `0` for the first chunk, then
 *  the running sum of preceding chunk durations. Consumers (audio player) use
 *  it for play-out scheduling. */
export interface TtsAudioChunk {
  bytes: Uint8Array;
  sampleRate: number;
  tsMs: number;
}

export interface TtsSpeakOptions {
  /** ElevenLabs voice identifier (long alphanumeric string). Empty string =
   *  fall back to the provider's default voice constant. */
  voice: string;
}

export interface TtsProvider {
  readonly name: TtsProviderName;
  speak(text: string, opts: TtsSpeakOptions): AsyncIterable<TtsAudioChunk>;
}
