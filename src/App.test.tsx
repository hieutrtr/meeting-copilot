// @vitest-environment jsdom
//
// T-W.7 part C — App-level wizard mount integration tests.
//
// AC traceability (see docs/tasks/blackhole-wizard/T-W.7-integration.md):
//   WT-1 → app_renders_wizard_when_setup_incomplete
//          settingsStore.setupCompleted=false at mount → SetupWizard renders;
//          the meeting-UI shell ("Meeting Copilot" h1) is NOT in the DOM.
//   WT-2 → app_skips_wizard_when_setup_completed_true
//          settingsStore.setupCompleted=true at mount → SetupWizard never
//          renders; the meeting UI shell mounts directly.
//   WT-3 → app_persists_setup_completed_to_settings_store_after_done
//          Wizard onDone fires → settingsStore.setupCompleted flips to true →
//          App re-renders with the meeting UI; the wizard unmounts.
//   WT-4 → re_running_wizard_after_completion_via_settings_link_re_renders_without_breaking_main_ui
//          Toggling setupCompleted=false post-completion remounts the wizard;
//          a subsequent onDone restores the meeting UI without throwing.
//
// The SetupWizard internals (the 5-step FSM) are exercised by
// `src/components/SetupWizard/SetupWizard.test.tsx` (12 RTL cases). Here we
// stub the wizard to a click-driven onDone trigger so the App-level mount
// gate is the unit under test.

import "@testing-library/jest-dom/vitest";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Tauri invoke / event mocks ───────────────────────────────────────────────
// The meeting-UI shell renders ContextLoader / MeetingControls /
// TranscriptView etc., all of which import `@tauri-apps/api`. We stub them at
// the lowest layer so no real IPC fires.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    // `useMeetingPersist` calls `load_meetings` once on mount and feeds the
    // result into `historyStore.setPastMeetings`. Returning an array (not
    // undefined) keeps `PastMeetings.tsx` from crashing on `past.length`.
    if (cmd === "load_meetings") return [];
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

// `useAskClaude` instantiates an Anthropic client lazily; stub the SDK so
// the import graph stays cheap and never reaches the network.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    public messages: Record<string, unknown>;
    constructor(_opts: { apiKey: string }) {
      this.messages = {
        stream: () => ({
          on: () => undefined,
          finalMessage: async () => ({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }),
        }),
      };
    }
  },
}));

// SetupWizard stub — exposes a single button that fires onDone(). Keeps the
// FSM out of these tests; the wizard's own RTL suite covers it.
vi.mock("./components/SetupWizard/SetupWizard", () => ({
  SetupWizard: ({ onDone }: { onDone: () => void }) => (
    <div data-testid="setup-wizard-root">
      <button
        type="button"
        data-testid="setup-wizard-stub-done"
        onClick={() => onDone()}
      >
        Done
      </button>
    </div>
  ),
}));

const { default: App } = await import("./App");
const { useSettingsStore } = await import("./store/settingsStore");
const { useMeetingStore } = await import("./store/meetingStore");
const { useQuestionStore } = await import("./store/questionStore");
const { useContextStore } = await import("./store/contextStore");
const { useHistoryStore } = await import("./store/historyStore");

// `TranscriptView` calls scrollIntoView for autoscroll. jsdom doesn't
// implement it.
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof originalScrollIntoView;
});

afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

beforeEach(() => {
  // Singleton stores: reset between cases so prior writes (esp. the wizard
  // flipping `setupCompleted=true` in WT-3) don't bleed into the next test.
  useSettingsStore.getState().reset();
  useMeetingStore.getState().reset();
  useQuestionStore.getState().clear();
  useContextStore.getState().clear();
  useHistoryStore.getState().clear();
});

afterEach(() => {
  cleanup();
});

// ── WT-1 ─────────────────────────────────────────────────────────────────────

describe("App — wizard mount when setup incomplete (WT-1)", () => {
  it("renders the SetupWizard when settingsStore.setupCompleted=false", () => {
    expect(useSettingsStore.getState().setupCompleted).toBe(false);

    render(<App />);

    expect(screen.getByTestId("setup-wizard-root")).toBeInTheDocument();
    // Meeting-UI shell is gated off — its h1 must not be in the tree.
    expect(screen.queryByText("Meeting Copilot")).not.toBeInTheDocument();
  });
});

// ── WT-2 ─────────────────────────────────────────────────────────────────────

describe("App — wizard skipped when setup already complete (WT-2)", () => {
  it("renders the meeting UI directly when setupCompleted=true at mount", () => {
    act(() => {
      useSettingsStore.getState().setSetupCompleted(true);
    });

    render(<App />);

    expect(screen.queryByTestId("setup-wizard-root")).not.toBeInTheDocument();
    expect(screen.getByText("Meeting Copilot")).toBeInTheDocument();
  });
});

// ── WT-3 ─────────────────────────────────────────────────────────────────────

describe("App — wizard onDone persists to settings store (WT-3)", () => {
  it("flips setupCompleted=true via the store and unmounts the wizard", async () => {
    expect(useSettingsStore.getState().setupCompleted).toBe(false);
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByTestId("setup-wizard-root")).toBeInTheDocument();
    expect(screen.queryByText("Meeting Copilot")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("setup-wizard-stub-done"));

    // Persistence: the boolean lands in the live store (settingsStore writes
    // through to its injected Storage; that side-effect is covered by
    // settingsStore.test.ts — here we assert the in-memory transition).
    expect(useSettingsStore.getState().setupCompleted).toBe(true);

    // The next render should drop the wizard and mount the meeting UI.
    expect(screen.queryByTestId("setup-wizard-root")).not.toBeInTheDocument();
    expect(screen.getByText("Meeting Copilot")).toBeInTheDocument();
  });
});

// ── WT-4 ─────────────────────────────────────────────────────────────────────

describe("App — re-running wizard after completion (WT-4)", () => {
  it("re-mounts the wizard when setupCompleted is toggled back to false, and a fresh onDone restores the meeting UI", async () => {
    act(() => {
      useSettingsStore.getState().setSetupCompleted(true);
    });
    const user = userEvent.setup();
    render(<App />);

    // Sanity: starts on the meeting UI.
    expect(screen.getByText("Meeting Copilot")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-wizard-root")).not.toBeInTheDocument();

    // Operator opens Settings → "Re-run setup wizard" (deferred UI affordance;
    // the store seam is what matters for this regression).
    act(() => {
      useSettingsStore.getState().setSetupCompleted(false);
    });

    expect(screen.getByTestId("setup-wizard-root")).toBeInTheDocument();
    expect(screen.queryByText("Meeting Copilot")).not.toBeInTheDocument();

    // Completing the wizard a second time must not throw — and must restore
    // the meeting UI without breakage.
    await user.click(screen.getByTestId("setup-wizard-stub-done"));

    expect(useSettingsStore.getState().setupCompleted).toBe(true);
    expect(screen.queryByTestId("setup-wizard-root")).not.toBeInTheDocument();
    expect(screen.getByText("Meeting Copilot")).toBeInTheDocument();
  });
});
