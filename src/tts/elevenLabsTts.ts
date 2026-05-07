// Phase 3 T-3.7 — ElevenLabs TTS adapter (TS).
//
// Implements `TtsProvider` (ARCH §4) by streaming
// `POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000` and
// reading the response as a `ReadableStream` of i16 LE PCM bytes. Each reader
// yield becomes one `TtsAudioChunk`; the sample-rate is stamped from the
// constructor (`16000` by default).
//
// The fetch impl is prop-injected (`fetch?: typeof fetch`) so vitest can pass
// a deterministic mock without a fetch polyfill. The default reads
// `globalThis.fetch` lazily — in jsdom the global is present; in the Tauri
// runtime the global is the WebView's `fetch` (CSP-allowed by Tauri config in
// T-3.10's settings wiring patch).
//
// API key handling: `ELEVENLABS_TTS_KEY_MISSING` is the throw payload used by
// `assertApiKey` so the SettingsSheet (T-3.6) can map it to the same toast as
// the STT-side missing-key path. The key value itself NEVER appears in error
// messages — `name` references only the env var name + provider label.

import type {
  TtsAudioChunk,
  TtsProvider,
  TtsSpeakOptions,
} from "./ttsProvider";

export const ELEVENLABS_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM" as const;
export const ELEVENLABS_DEFAULT_MODEL_ID = "eleven_turbo_v2" as const;
export const ELEVENLABS_DEFAULT_BASE_URL = "https://api.elevenlabs.io" as const;
export const ELEVENLABS_DEFAULT_OUTPUT_FORMAT = "pcm_16000" as const;
export const ELEVENLABS_DEFAULT_SAMPLE_RATE = 16_000 as const;

export const ELEVENLABS_TTS_API_KEY_MISSING_MESSAGE =
  "ElevenLabs TTS: API key missing — set it in Settings or export ELEVENLABS_API_KEY";

export interface ElevenLabsTtsConfig {
  apiKey: string;
  baseUrl?: string;
  voiceId?: string;
  modelId?: string;
  sampleRate?: number;
  /** Test seam — defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/** Thrown on the construction-time API-key check. The error message MUST NOT
 *  include the key value. */
export class ElevenLabsTtsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsTtsConfigError";
  }
}

export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs" as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly sampleRate: number;
  private readonly fetchFn: typeof fetch;

  constructor(cfg: ElevenLabsTtsConfig) {
    if (!cfg.apiKey) {
      throw new ElevenLabsTtsConfigError(ELEVENLABS_TTS_API_KEY_MISSING_MESSAGE);
    }
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? ELEVENLABS_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.voiceId = cfg.voiceId ?? ELEVENLABS_DEFAULT_VOICE_ID;
    this.modelId = cfg.modelId ?? ELEVENLABS_DEFAULT_MODEL_ID;
    this.sampleRate = cfg.sampleRate ?? ELEVENLABS_DEFAULT_SAMPLE_RATE;

    const f = cfg.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new ElevenLabsTtsConfigError(
        "ElevenLabs TTS: no fetch impl available (pass cfg.fetch or run in a fetch-capable runtime)",
      );
    }
    this.fetchFn = f;
  }

  buildRequest(text: string, opts: TtsSpeakOptions): { url: string; init: RequestInit } {
    const voice = opts.voice && opts.voice.length > 0 ? opts.voice : this.voiceId;
    const url = `${this.baseUrl}/v1/text-to-speech/${voice}/stream?output_format=${ELEVENLABS_DEFAULT_OUTPUT_FORMAT}`;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "content-type": "application/json",
        accept: "audio/wav",
      },
      body: JSON.stringify({
        text,
        model_id: this.modelId,
      }),
    };
    return { url, init };
  }

  async *speak(
    text: string,
    opts: TtsSpeakOptions,
  ): AsyncIterable<TtsAudioChunk> {
    const { url, init } = this.buildRequest(text, opts);
    const res = await this.fetchFn(url, init);
    if (!res.ok) {
      throw new Error(
        `ElevenLabs TTS: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const body = res.body;
    if (!body) {
      // Some test mocks omit the streaming body — fall back to arrayBuffer.
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength === 0) return;
      yield {
        bytes: buf,
        sampleRate: this.sampleRate,
        tsMs: 0,
      };
      return;
    }
    const reader = body.getReader();
    let tsMs = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const chunk: TtsAudioChunk = {
          bytes: value,
          sampleRate: this.sampleRate,
          tsMs,
        };
        // Advance ts by chunk duration (ms). Each i16 sample = 2 bytes.
        const samples = Math.floor(value.byteLength / 2);
        tsMs += Math.floor((samples * 1000) / this.sampleRate);
        yield chunk;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // releaseLock can throw if the reader is already closed — ignore.
      }
    }
  }
}
