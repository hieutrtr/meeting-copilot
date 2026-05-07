# =============================================================================
# DO NOT SUBMIT THIS FILE AS-IS to homebrew/homebrew-cask.
# This is a TEMPLATE shipped at v1.0.0 cut. Operator MUST substitute every
# `REPLACE_WITH_…` token below + run the local audit BEFORE opening a PR.
#
# Substitution checklist (matching docs/release/DMG-INSTRUCTIONS.md §6 / §7 / §8):
#   1. version            — keep "1.0.0" if it matches the GitHub release tag
#   2. sha256             — REPLACE_WITH_SHA256_OF_NOTARIZED_DMG (from `shasum -a 256`)
#   3. url                — REPLACE_WITH_RELEASE_URL (asset URL from `gh release create`)
#   4. homepage           — REPLACE_WITH_HOMEPAGE_URL (public GitHub repo URL)
#   5. app "Meeting Copilot.app"  — confirm matches src-tauri bundle name
#   6. livecheck { strategy :github_latest } — confirm repo path is correct
#   7. zap trash:          — verify the four paths align with where Tauri persists state
#   8. brew style ./Casks/meeting-copilot.rb     — must exit 0
#   9. brew audit --new --cask ./Casks/meeting-copilot.rb — must exit 0
#  10. PR title: "Add meeting-copilot v1.0.0" against homebrew/homebrew-cask master
# =============================================================================

cask "meeting-copilot" do
  version "1.0.0"
  sha256 "REPLACE_WITH_SHA256_OF_NOTARIZED_DMG"

  url "REPLACE_WITH_RELEASE_URL",
      verified: "github.com/"
  name "Meeting Copilot"
  desc "Realtime meeting assistant with live transcript, auto question detection, and MCP integration"
  homepage "REPLACE_WITH_HOMEPAGE_URL"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"
  depends_on arch: :arm64

  app "Meeting Copilot.app"

  # System audio capture requires BlackHole 2ch + Aggregate Device on macOS.
  # Tauri/cpal cannot tap system output directly; document this as a post-install
  # step (cask cannot install BlackHole — it has its own cask `blackhole-2ch`).
  caveats <<~EOS
    Meeting Copilot needs system audio (mic + speakers) to capture meetings.
    Install BlackHole 2ch and create an Aggregate Device:

      brew install --cask blackhole-2ch

    Then follow the BlackHole + Audio MIDI Setup procedure documented in the
    project README ("Quickstart" section).

    For MCP integration with claude-bridge, register Meeting Copilot in
    ~/.claude-bridge/config.json — see docs/RELEASE-NOTES-v1.0.0.md
    "MCP integration quick-start".
  EOS

  zap trash: [
    "~/Library/Application Support/com.bridge-bot-ts-1.meeting-copilot",
    "~/Library/Caches/com.bridge-bot-ts-1.meeting-copilot",
    "~/Library/Preferences/com.bridge-bot-ts-1.meeting-copilot.plist",
    "~/.claude-bridge/meeting-copilot",
  ]
end
