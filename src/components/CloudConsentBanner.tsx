// Phase 3 T-3.8 — Cloud-mode consent banner.
//
// ARCH §11 (line 405): "Banner đỏ ở top transcript khi đang ở Cloud mode để
// user nhớ obtain consent từ participants." App.tsx mounts this banner above
// `<TranscriptView/>` ONLY when `useSettingsStore.privacyMode === "cloud"`.
//
// Wording is fixed and verbatim — `CloudConsentBanner.test.tsx` (CB-U1) gates
// drift. The privacy audit requires NO API key references in this surface
// (covered by the test asserting the rendered DOM never includes
// `_API_KEY` substrings).

export const CLOUD_CONSENT_BANNER_TITLE = "Cloud mode active." as const;

export const CLOUD_CONSENT_BANNER_BODY =
  "Full audio is being streamed to your STT provider — obtain participant consent before recording." as const;

export function CloudConsentBanner() {
  return (
    <div
      role="alert"
      data-testid="cloud-consent-banner"
      className="cloud-consent-banner"
    >
      <strong>{CLOUD_CONSENT_BANNER_TITLE}</strong>{" "}
      {CLOUD_CONSENT_BANNER_BODY}
    </div>
  );
}
