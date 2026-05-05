import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

export default function App() {
  const [name, setName] = useState("Meeting Copilot");
  const [greeting, setGreeting] = useState<string>("");
  const [error, setError] = useState<string>("");

  async function handleGreet() {
    setError("");
    try {
      const reply = await invoke<string>("greet", { name });
      setGreeting(reply);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className="container">
      <h1>Meeting Copilot</h1>
      <p className="subtitle">Phase 0 scaffold — T-0.8 IPC smoke test</p>

      <section className="ipc-card">
        <label htmlFor="name-input">Name</label>
        <input
          id="name-input"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <button onClick={handleGreet} data-testid="greet-button">
          Invoke <code>greet</code>
        </button>

        {greeting && (
          <p className="reply" data-testid="greet-result">
            {greeting}
          </p>
        )}
        {error && (
          <p className="error" data-testid="greet-error">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
