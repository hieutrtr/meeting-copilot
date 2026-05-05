import "./App.css";

import { ContextLoader } from "./components/ContextLoader";
import { MeetingControls } from "./components/MeetingControls";
import { TranscriptView } from "./components/TranscriptView";
import { useTranscriptStream } from "./hooks/useTranscriptStream";

export default function App() {
  const { chunks } = useTranscriptStream();

  return (
    <main className="container">
      <h1>Meeting Copilot</h1>
      <p className="subtitle">Phase 1 — load context, start meeting, mark questions.</p>

      <ContextLoader />
      <MeetingControls chunks={chunks} />
      <TranscriptView chunks={chunks} />
    </main>
  );
}
