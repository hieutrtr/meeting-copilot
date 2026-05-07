// Phase 3 T-3.7 — ElevenLabs TTS adapter tests.
//
// AC traceability (T-3.7-tts-interface.md):
//   EL-S1 → AC-6 (missing/empty API key throws ElevenLabsTtsConfigError; message references env var, NOT the key value)
//   EL-S2 → AC-7 (request URL: ends with /v1/text-to-speech/{voice}/stream?output_format=pcm_16000)
//   EL-S3 → AC-7 (xi-api-key header carried; no Authorization header)
//   EL-S4 → AC-7 (request body: text + model_id)
//   EL-S5 → AC-2 (default constants pinned: voice_id, model_id, base_url, output_format, sample_rate)
//   EL-S6 → AC-7 (streaming body → AsyncIterable<TtsAudioChunk>: bytes round-trip, sampleRate stamped, tsMs advances)
//   EL-S7 → AC-7 (opts.voice overrides cfg.voiceId)
//   EL-S8 → AC-7 (HTTP non-2xx surfaces a typed Error; message contains status)

import { describe, it, expect } from "vitest";

import {
  ElevenLabsTts,
  ElevenLabsTtsConfigError,
  ELEVENLABS_DEFAULT_BASE_URL,
  ELEVENLABS_DEFAULT_MODEL_ID,
  ELEVENLABS_DEFAULT_OUTPUT_FORMAT,
  ELEVENLABS_DEFAULT_SAMPLE_RATE,
  ELEVENLABS_DEFAULT_VOICE_ID,
} from "./elevenLabsTts";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function fakeFetchCapture(
  responseFactory: () => Response,
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(responseFactory());
  };
  return { fetch: fetchFn, calls };
}

function makeStreamResponse(parts: Uint8Array[], status = 200): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) {
        controller.enqueue(parts[i]);
        i += 1;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status,
    statusText: status === 200 ? "OK" : `Code ${status}`,
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("ElevenLabsTts — config & errors (T-3.7)", () => {
  it("EL-S1a: missing API key throws ElevenLabsTtsConfigError", () => {
    const { fetch } = fakeFetchCapture(() => new Response());
    expect(
      () => new ElevenLabsTts({ apiKey: "", fetch }),
    ).toThrow(ElevenLabsTtsConfigError);
  });

  it("EL-S1b: missing API key error message references env var, NOT key value", () => {
    const { fetch } = fakeFetchCapture(() => new Response());
    try {
      new ElevenLabsTts({ apiKey: "", fetch });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ElevenLabsTtsConfigError);
      expect((e as Error).message).toContain("ELEVENLABS_API_KEY");
    }
  });

  it("EL-S5: default constants pinned (drift gate vs Rust adapter + provider-comparison.md)", () => {
    expect(ELEVENLABS_DEFAULT_VOICE_ID).toBe("21m00Tcm4TlvDq8ikWAM");
    expect(ELEVENLABS_DEFAULT_MODEL_ID).toBe("eleven_turbo_v2");
    expect(ELEVENLABS_DEFAULT_BASE_URL).toBe("https://api.elevenlabs.io");
    expect(ELEVENLABS_DEFAULT_OUTPUT_FORMAT).toBe("pcm_16000");
    expect(ELEVENLABS_DEFAULT_SAMPLE_RATE).toBe(16_000);
  });
});

describe("ElevenLabsTts — request shape (T-3.7)", () => {
  it("EL-S2: URL matches ARCH §4 endpoint shape", () => {
    const { fetch, calls } = fakeFetchCapture(() => makeStreamResponse([]));
    const tts = new ElevenLabsTts({
      apiKey: "k",
      baseUrl: "https://example.test",
      voiceId: "v-alpha",
      fetch,
    });
    const { url } = tts.buildRequest("hi", { voice: "" });
    expect(url).toBe(
      "https://example.test/v1/text-to-speech/v-alpha/stream?output_format=pcm_16000",
    );
    // Sanity: drives a speak() call too — the same URL must appear in fetch calls.
    return collect(tts.speak("hi", { voice: "" })).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(url);
    });
  });

  it("EL-S2b: trailing slashes on baseUrl are normalized", () => {
    const { fetch } = fakeFetchCapture(() => makeStreamResponse([]));
    const tts = new ElevenLabsTts({
      apiKey: "k",
      baseUrl: "https://example.test///",
      voiceId: "v",
      fetch,
    });
    const { url } = tts.buildRequest("hi", { voice: "" });
    expect(url.startsWith("https://example.test/v1/text-to-speech/v/stream")).toBe(true);
  });

  it("EL-S3: xi-api-key header is carried; no Authorization header", () => {
    const { fetch, calls } = fakeFetchCapture(() => makeStreamResponse([]));
    const tts = new ElevenLabsTts({
      apiKey: "secret-tts-42",
      voiceId: "v",
      fetch,
    });
    return collect(tts.speak("hi", { voice: "" })).then(() => {
      const headers = calls[0].init.headers as Record<string, string>;
      const lower: Record<string, string> = {};
      for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
      expect(lower["xi-api-key"]).toBe("secret-tts-42");
      expect(lower["authorization"]).toBeUndefined();
      expect(lower["content-type"]).toBe("application/json");
    });
  });

  it("EL-S4: body contains text + model_id (default modelId pinned)", () => {
    const { fetch, calls } = fakeFetchCapture(() => makeStreamResponse([]));
    const tts = new ElevenLabsTts({ apiKey: "k", voiceId: "v", fetch });
    return collect(tts.speak("hello world", { voice: "" })).then(() => {
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.text).toBe("hello world");
      expect(body.model_id).toBe(ELEVENLABS_DEFAULT_MODEL_ID);
    });
  });

  it("EL-S7: opts.voice overrides cfg.voiceId", () => {
    const { fetch, calls } = fakeFetchCapture(() => makeStreamResponse([]));
    const tts = new ElevenLabsTts({
      apiKey: "k",
      voiceId: "default-v",
      fetch,
    });
    return collect(tts.speak("hi", { voice: "override-v" })).then(() => {
      expect(calls[0].url).toContain("/text-to-speech/override-v/stream");
    });
  });
});

describe("ElevenLabsTts — streaming response → AsyncIterable<TtsAudioChunk>", () => {
  it("EL-S6: streaming body yields chunks with bytes + sampleRate + advancing tsMs", async () => {
    // Two chunks of 16 i16 samples each = 32 bytes per chunk = 1 ms each at 16 kHz.
    // Using larger chunks for clearer ts advancement: 1600 samples = 100 ms each.
    const chunk1 = new Uint8Array(1600 * 2);
    const chunk2 = new Uint8Array(1600 * 2);
    for (let i = 0; i < chunk1.length; i++) chunk1[i] = i & 0xff;
    for (let i = 0; i < chunk2.length; i++) chunk2[i] = (i + 1) & 0xff;

    const { fetch } = fakeFetchCapture(() => makeStreamResponse([chunk1, chunk2]));
    const tts = new ElevenLabsTts({ apiKey: "k", voiceId: "v", fetch });
    const out = await collect(tts.speak("hi", { voice: "" }));

    expect(out).toHaveLength(2);
    expect(out[0].bytes.length).toBe(3200);
    expect(out[0].sampleRate).toBe(16_000);
    expect(out[0].tsMs).toBe(0);
    // Second chunk's ts = 1600 samples / 16000 Hz = 0.1 s = 100 ms.
    expect(out[1].tsMs).toBe(100);
  });

  it("EL-S6b: empty stream yields zero chunks (no error)", async () => {
    const { fetch } = fakeFetchCapture(() => makeStreamResponse([]));
    const tts = new ElevenLabsTts({ apiKey: "k", voiceId: "v", fetch });
    const out = await collect(tts.speak("hi", { voice: "" }));
    expect(out).toEqual([]);
  });

  it("EL-S6c: response without streaming body falls back to arrayBuffer (test mocks)", async () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const fakeResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      body: null,
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(0)),
    } as unknown as Response;

    const fetchFn: typeof fetch = () => Promise.resolve(fakeResponse);
    const tts = new ElevenLabsTts({ apiKey: "k", voiceId: "v", fetch: fetchFn });
    const out = await collect(tts.speak("hi", { voice: "" }));
    expect(out).toHaveLength(1);
    expect(Array.from(out[0].bytes)).toEqual([1, 2, 3, 4]);
  });
});

describe("ElevenLabsTts — error paths", () => {
  it("EL-S8: HTTP non-2xx surfaces a typed Error with status in message", async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        new Response("nope", { status: 401, statusText: "Unauthorized" }),
      );
    const tts = new ElevenLabsTts({ apiKey: "k", voiceId: "v", fetch: fetchFn });
    await expect(collect(tts.speak("hi", { voice: "" }))).rejects.toThrow(/401/);
  });

  it("EL-S8b: name is stable telemetry-friendly identifier", () => {
    const { fetch } = fakeFetchCapture(() => makeStreamResponse([]));
    const tts = new ElevenLabsTts({ apiKey: "k", voiceId: "v", fetch });
    expect(tts.name).toBe("elevenlabs");
  });
});
