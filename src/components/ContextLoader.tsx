// Phase 1 T-1.8 — ContextLoader UI shell.
//
// Single-file MVP: text-input for the path + "Load file" button. The richer
// file-picker dialog (`tauri-plugin-dialog`) lands with T-1.9, drag-and-drop
// in Phase 1.x — see T-1.8 task doc §"Out-of-scope".

import { useState } from "react";

import { useContextStore } from "../store/contextStore";

export function ContextLoader() {
  const source = useContextStore((s) => s.source);
  const error = useContextStore((s) => s.error);
  const loadFromPath = useContextStore((s) => s.loadFromPath);
  const clear = useContextStore((s) => s.clear);

  const [pathInput, setPathInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleLoad() {
    const trimmed = pathInput.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await loadFromPath(trimmed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="context-loader" aria-label="Context loader">
      <div className="context-loader__row">
        <label htmlFor="context-path-input">Context file path</label>
        <input
          id="context-path-input"
          type="text"
          value={pathInput}
          placeholder="/path/to/PRD.md"
          onChange={(e) => setPathInput(e.currentTarget.value)}
          aria-label="Context file path"
        />
        <button
          type="button"
          onClick={handleLoad}
          disabled={busy || !pathInput.trim()}
          data-testid="context-load-button"
        >
          {busy ? "Loading…" : "Load file"}
        </button>
        {source && (
          <button type="button" onClick={clear} data-testid="context-clear-button">
            Clear
          </button>
        )}
      </div>

      {source && (
        <p className="context-loader__readout" data-testid="context-readout">
          {source.path} · {source.charCount.toLocaleString()} chars · ~
          {source.estimatedTokens.toLocaleString()} tokens
        </p>
      )}

      {error && (
        <p className="context-loader__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
