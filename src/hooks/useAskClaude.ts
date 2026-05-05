// Phase 1 T-1.11 — `useAskClaude` driver hook.
//
// Bridges the T-1.10 `askClaude` async-generator into React state so the
// `AnswerPanel` stays pure-presentational. The hook:
//   - exposes status / text / usage / costUsd / cacheReadRatio / error
//   - catches BOTH the synchronous `MissingApiKeyError` AND mid-stream SDK
//     errors and surfaces them as `{ status: "error", error }` instead of a
//     render-tree throw (AC-H3 / AC-H4)
//   - cancels any in-flight stream when `ask()` is called again (AC-H6) by
//     incrementing a request-id and ignoring late state updates from the
//     stale generator
//   - cancels on unmount (Effect cleanup) so a hot-reload mid-stream doesn't
//     fire `setState` on an unmounted component

import { useCallback, useEffect, useRef, useState } from "react";

import {
  askClaude,
  type AskClaudeInput,
  type AskClaudeOptions,
  type AskClaudeResult,
} from "../llm/claudeClient";
import type { AnthropicUsage } from "../llm/pricing";

export type UseAskClaudeStatus = "idle" | "streaming" | "done" | "error";

export interface UseAskClaudeState {
  status: UseAskClaudeStatus;
  text: string;
  error: Error | null;
  usage?: AnthropicUsage;
  costUsd?: number;
  cacheReadRatio?: number;
  stopReason?: string;
  ask: (input: AskClaudeInput, opts?: AskClaudeOptions) => void;
  reset: () => void;
}

const INITIAL: Omit<UseAskClaudeState, "ask" | "reset"> = {
  status: "idle",
  text: "",
  error: null,
};

export function useAskClaude(): UseAskClaudeState {
  const [snapshot, setSnapshot] =
    useState<Omit<UseAskClaudeState, "ask" | "reset">>(INITIAL);

  // request-id sequence: every `ask` bumps this; in-flight loops compare
  // against it after each yield and bail if a newer ask has started.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Any in-flight stream becomes stale on unmount.
      requestIdRef.current++;
    };
  }, []);

  const reset = useCallback(() => {
    requestIdRef.current++;
    if (mountedRef.current) setSnapshot(INITIAL);
  }, []);

  const ask = useCallback(
    (input: AskClaudeInput, opts?: AskClaudeOptions) => {
      const myId = ++requestIdRef.current;

      // Reset visible state for the new question. Doing this synchronously
      // before kicking off the generator means the user never sees stale text
      // from a prior ask flicker through.
      setSnapshot({ status: "streaming", text: "", error: null });

      // Wrapping the generator construction in try/catch covers AC-H3:
      // `askClaude` throws `MissingApiKeyError` synchronously before entering
      // the generator body.
      let gen: AsyncGenerator<unknown, AskClaudeResult, void>;
      try {
        gen = askClaude(input, opts) as AsyncGenerator<
          unknown,
          AskClaudeResult,
          void
        >;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (mountedRef.current && requestIdRef.current === myId) {
          setSnapshot({ status: "error", text: "", error: e });
        }
        return;
      }

      void (async () => {
        let aggregated = "";
        try {
          while (true) {
            const step = await gen.next();
            if (requestIdRef.current !== myId) {
              // Stale generator — a newer ask (or reset/unmount) has won.
              // Politely ask the SDK to stop; ignore the resulting value.
              try {
                await gen.return(undefined as unknown as AskClaudeResult);
              } catch {
                /* ignore */
              }
              return;
            }
            if (step.done) {
              const result = step.value;
              if (mountedRef.current && requestIdRef.current === myId) {
                setSnapshot({
                  status: "done",
                  text: result.text,
                  error: null,
                  usage: result.usage,
                  costUsd: result.costUsd,
                  cacheReadRatio: result.cacheReadRatio,
                  stopReason: result.stopReason,
                });
              }
              return;
            }
            const event = step.value as
              | { type: "delta"; text: string }
              | { type: "usage"; usage: AnthropicUsage }
              | { type: "stopReason"; reason: string };
            if (event.type === "delta") {
              aggregated += event.text;
              if (mountedRef.current && requestIdRef.current === myId) {
                const next = aggregated;
                setSnapshot((s) => ({ ...s, text: next, status: "streaming" }));
              }
            }
            // usage/stopReason events are folded into the final `step.value`
            // already; ignore the intermediate yields here.
          }
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          if (mountedRef.current && requestIdRef.current === myId) {
            setSnapshot((s) => ({
              status: "error",
              text: s.text, // preserve partial text seen before the throw
              error: e,
            }));
          }
        }
      })();
    },
    [],
  );

  return { ...snapshot, ask, reset };
}
