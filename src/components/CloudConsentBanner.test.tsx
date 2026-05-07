// @vitest-environment jsdom
//
// Phase 3 T-3.8 — `CloudConsentBanner` RTL component tests.
//
// AC traceability:
//   CB-U1 → renders ARCH §11 verbatim wording (title + body)
//   CB-U2 → role="alert" + data-testid (a11y + assertion handle)
//   CB-U3 → Privacy audit: no `_API_KEY` substring in the rendered DOM

import "@testing-library/jest-dom/vitest";

import { describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import {
  CLOUD_CONSENT_BANNER_BODY,
  CLOUD_CONSENT_BANNER_TITLE,
  CloudConsentBanner,
} from "./CloudConsentBanner";

describe("CB-U1: ARCH §11 wording verbatim", () => {
  it("renders the fixed title + body", () => {
    render(<CloudConsentBanner />);
    expect(screen.getByText(CLOUD_CONSENT_BANNER_TITLE)).toBeInTheDocument();
    const banner = screen.getByTestId("cloud-consent-banner");
    expect(banner.textContent).toContain(CLOUD_CONSENT_BANNER_TITLE);
    expect(banner.textContent).toContain(CLOUD_CONSENT_BANNER_BODY);
    cleanup();
  });
});

describe("CB-U2: role + testid", () => {
  it("uses role='alert' for screen readers + data-testid for assertions", () => {
    render(<CloudConsentBanner />);
    const banner = screen.getByRole("alert");
    expect(banner).toBeInTheDocument();
    expect(banner.getAttribute("data-testid")).toBe("cloud-consent-banner");
    cleanup();
  });
});

describe("CB-U3: privacy audit — banner DOM has no API key references", () => {
  it("rendered text never includes the env-var name", () => {
    render(<CloudConsentBanner />);
    const banner = screen.getByTestId("cloud-consent-banner");
    expect(banner.textContent ?? "").not.toMatch(/_API_KEY/);
    expect(banner.textContent ?? "").not.toMatch(/DEEPGRAM/i);
    expect(banner.textContent ?? "").not.toMatch(/ELEVENLABS/i);
    cleanup();
  });
});
