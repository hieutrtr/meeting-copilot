// Phase 3 T-3.6 — Settings sheet with STT provider picker, per-provider API key,
// and Test Connection button.
//
// Render-only; reads from `useSettingsStore`. The Test Connection seam is
// prop-injected (`testConnection?`) so vitest can swap a deterministic mock
// without any fetch polyfill. Live wiring to the Rust adapters lands in T-3.10.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { STT_PROVIDER_IDS, type SttProviderId } from "../llm/sttPricing";
import {
  PRIVACY_MODES,
  isSttProviderAllowed,
  labelForPrivacyMode,
  tooltipFor,
  type PrivacyMode,
} from "../privacy/privacyMode";
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
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const telemetryEnabled = useSettingsStore((s) => s.telemetryEnabled);
  const setSttProvider = useSettingsStore((s) => s.setSttProvider);
  const setApiKey = useSettingsStore((s) => s.setApiKey);
  const setPrivacyMode = useSettingsStore((s) => s.setPrivacyMode);
  const setTelemetryEnabled = useSettingsStore((s) => s.setTelemetryEnabled);

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

  const onPrivacyModeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as PrivacyMode;
      setPrivacyMode(next);
    },
    [setPrivacyMode],
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
      STT_PROVIDER_IDS.map((id) => {
        const allowed = isSttProviderAllowed(privacyMode, id);
        const tip = allowed ? null : tooltipFor(privacyMode, id);
        return {
          id,
          label: labelFor(id),
          disabled: !allowed,
          title: tip,
        };
      }),
    [privacyMode],
  );

  const privacyModeOptions = useMemo(
    () =>
      PRIVACY_MODES.map((mode) => ({
        id: mode,
        label: labelForPrivacyMode(mode),
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

      <div className="settings-sheet__row settings-sheet__privacy-row">
        <label
          htmlFor="settings-privacy-mode-select"
          className="settings-sheet__label"
        >
          Privacy Mode
        </label>
        <select
          id="settings-privacy-mode-select"
          data-testid="settings-privacy-mode-select"
          aria-label="Privacy mode"
          value={privacyMode}
          onChange={onPrivacyModeChange}
          className="settings-sheet__select"
        >
          {privacyModeOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
        <span
          data-testid="settings-privacy-mode-summary"
          className="settings-sheet__privacy-summary"
        >
          {privacyMode === "local-first"
            ? "Audio stays local. Only MLX is selectable."
            : privacyMode === "cloud"
              ? "Cloud STT + TTS unlocked. Consent banner active."
              : "Local STT, cloud TTS allowed."}
        </span>
      </div>

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
            <option
              key={opt.id}
              value={opt.id}
              disabled={opt.disabled}
              title={opt.title ?? undefined}
              data-testid={`settings-provider-option-${opt.id}`}
            >
              {opt.label}
              {opt.disabled ? " — disabled" : ""}
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

      <div
        className="settings-sheet__row settings-sheet__telemetry-row"
        data-testid="settings-telemetry-row"
      >
        <label
          htmlFor="settings-telemetry-toggle"
          className="settings-sheet__label"
        >
          Telemetry
        </label>
        <input
          id="settings-telemetry-toggle"
          data-testid="settings-telemetry-toggle"
          type="checkbox"
          checked={telemetryEnabled}
          onChange={(e) => setTelemetryEnabled(e.target.checked)}
        />
        <span
          data-testid="settings-telemetry-hint"
          className="settings-sheet__hint"
        >
          Local-only operational log (provider switches, errors, latency). No
          transcript or audio. Off by default.
        </span>
      </div>
    </section>
  );
}
