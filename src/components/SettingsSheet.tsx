// Phase 3 T-3.6 — Settings sheet with STT provider picker, per-provider API key,
// and Test Connection button.
//
// Render-only; reads from `useSettingsStore`. The Test Connection seam is
// prop-injected (`testConnection?`) so vitest can swap a deterministic mock
// without any fetch polyfill. Live wiring to the Rust adapters lands in T-3.10.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { STT_PROVIDER_IDS, type SttProviderId } from "../llm/sttPricing";
import {
  defaultTestSttConnection,
  envVarFor,
  labelFor,
  requiresApiKey,
  type TestConnectionFn,
  type TestConnectionResult,
} from "../settings/testConnection";
import {
  useSettingsStore,
  type ApiKeyProvider,
} from "../store/settingsStore";

type PillStatus = "idle" | "pending" | "success" | "fail";

interface PillState {
  status: PillStatus;
  message: string;
}

const IDLE_PILL: PillState = { status: "idle", message: "" };

export interface SettingsSheetProps {
  /** Override the live test-connection round-trip. Used by component tests. */
  testConnection?: TestConnectionFn;
}

export function SettingsSheet({
  testConnection = defaultTestSttConnection,
}: SettingsSheetProps) {
  const sttProvider = useSettingsStore((s) => s.sttProvider);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const setSttProvider = useSettingsStore((s) => s.setSttProvider);
  const setApiKey = useSettingsStore((s) => s.setApiKey);

  const needsKey = requiresApiKey(sttProvider);
  const apiKeyProvider: ApiKeyProvider | null = needsKey
    ? (sttProvider as ApiKeyProvider)
    : null;
  const apiKeyValue = apiKeyProvider ? apiKeys[apiKeyProvider] : "";

  const [showKey, setShowKey] = useState(false);
  const [pill, setPill] = useState<PillState>(IDLE_PILL);
  const inFlightRef = useRef(false);

  // When the picker changes, reset the pill back to idle — the prior result no
  // longer applies to the new provider.
  useEffect(() => {
    setPill(IDLE_PILL);
    setShowKey(false);
  }, [sttProvider]);

  const onProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as SttProviderId;
      setSttProvider(next);
    },
    [setSttProvider],
  );

  const onApiKeyChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!apiKeyProvider) return;
      setApiKey(apiKeyProvider, e.target.value);
    },
    [apiKeyProvider, setApiKey],
  );

  const onTestClick = useCallback(async () => {
    if (inFlightRef.current) return; // debounce: in-flight click is a no-op
    inFlightRef.current = true;
    setPill({ status: "pending", message: "Testing connection…" });
    let result: TestConnectionResult;
    try {
      result = await testConnection(sttProvider, apiKeyValue);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result = { ok: false, message, latencyMs: 0 };
    } finally {
      inFlightRef.current = false;
    }
    setPill({
      status: result.ok ? "success" : "fail",
      message: result.message,
    });
  }, [testConnection, sttProvider, apiKeyValue]);

  const providerOptions = useMemo(
    () =>
      STT_PROVIDER_IDS.map((id) => ({
        id,
        label: labelFor(id),
      })),
    [],
  );

  return (
    <section
      className="settings-sheet"
      aria-label="Settings"
      data-testid="settings-sheet"
    >
      <h2 className="settings-sheet__heading">Settings</h2>

      <div className="settings-sheet__row">
        <label
          htmlFor="settings-provider-select"
          className="settings-sheet__label"
        >
          STT Provider
        </label>
        <select
          id="settings-provider-select"
          data-testid="settings-provider-select"
          value={sttProvider}
          onChange={onProviderChange}
          className="settings-sheet__select"
        >
          {providerOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-sheet__row">
        <label
          htmlFor="settings-api-key-input"
          className="settings-sheet__label"
        >
          API Key
        </label>
        <input
          id="settings-api-key-input"
          data-testid="settings-api-key-input"
          type={showKey ? "text" : "password"}
          value={apiKeyValue}
          onChange={onApiKeyChange}
          disabled={!needsKey}
          placeholder={
            needsKey
              ? `Paste your ${labelFor(sttProvider)} key (or leave blank to use $${envVarFor(sttProvider)})`
              : "No key required for local providers"
          }
          autoComplete="off"
          spellCheck={false}
          className="settings-sheet__input"
        />
        <label className="settings-sheet__show-key">
          <input
            type="checkbox"
            data-testid="settings-show-key-checkbox"
            checked={showKey}
            onChange={(e) => setShowKey(e.target.checked)}
            disabled={!needsKey}
          />
          Show
        </label>
      </div>

      <div className="settings-sheet__row">
        <button
          type="button"
          data-testid="settings-test-connection-button"
          onClick={onTestClick}
          disabled={pill.status === "pending"}
          className="settings-sheet__test-button"
        >
          {pill.status === "pending" ? "Testing…" : "Test connection"}
        </button>
        <span
          data-testid="settings-test-connection-status"
          data-status={pill.status}
          className={`settings-sheet__pill settings-sheet__pill--${pill.status}`}
          role="status"
          aria-live="polite"
        >
          {pill.status === "idle" ? "" : pill.message}
        </span>
      </div>
    </section>
  );
}
