# Meeting Copilot v1.0.0 — DMG Codesign + Notarize + Staple Checklist

> Operator-side, host-only. The agent did NOT run any of the steps below — Apple Developer credentials are operator-owned. Every `<PLACEHOLDER>` requires substitution before the command runs.
>
> Companion docs: `docs/RELEASE-NOTES-v1.0.0.md` (release content), `docs/release/HOMEBREW-CASK-TEMPLATE.rb` (cask draft once SHA-256 is known).
>
> Sequence summary: **build → codesign → notarize → staple → SHA-256 → release upload → tag push → cask PR.** Skipping or reordering breaks Gatekeeper.

---

## 0. Prerequisites (host setup, one-off)

These are required ONCE per host machine. If any of `xcrun --find notarytool` / `cargo --version` / `tauri --version` errors, install the corresponding toolchain before proceeding.

```bash
# Xcode Command Line Tools (notarytool, codesign, stapler all live here)
xcode-select --install
xcrun --find notarytool          # → /Library/Developer/CommandLineTools/usr/bin/notarytool

# Rust toolchain (Phase 0 carry-forward — sandbox does not have this)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add aarch64-apple-darwin

# Tauri CLI
cargo install tauri-cli --version "^2.0"

# Bun
curl -fsSL https://bun.sh/install | bash

# Apple Developer credentials — store ONCE in keychain via notarytool's --store-credentials
# (after this you reference by profile name instead of typing password each release)
xcrun notarytool store-credentials "AC_PASSWORD" \
  --apple-id "<APPLE_ID_EMAIL>" \
  --team-id "<APPLE_TEAM_ID>" \
  --password "<APP_SPECIFIC_PASSWORD>"
# → "AC_PASSWORD" stored in keychain; reference via --keychain-profile "AC_PASSWORD"
```

`<APPLE_ID_EMAIL>` is your Apple Developer Program login (e.g. `dev@example.com`). `<APPLE_TEAM_ID>` is the 10-character team identifier from `developer.apple.com → Membership`. `<APP_SPECIFIC_PASSWORD>` is a one-time per-tool password generated at `appleid.apple.com → Sign-In and Security → App-Specific Passwords` (NOT your iCloud password).

---

## 1. Pre-flight — sync host with the v1.0.0 tag

```bash
git fetch --tags
git checkout v1.0.0              # detached HEAD on the tagged commit — expected
bun install                      # populates node_modules from bun.lock
cargo build --workspace          # rebuilds Cargo.lock if needed (sandbox couldn't run this);
                                 # NOTE: a Cargo.lock change here lands as a follow-up commit
                                 # on `main`, NOT on the tagged sha. Same pattern as Tauri 2 upstream.
bun test                         # full vitest suite — must be green (900 / 900 across 57 files)
bun run typecheck                # tsc --noEmit — must exit 0
cargo test --workspace           # cargo tests — must be green
```

If any test fails on host, do NOT proceed. Triage on `main` first, cut a `v1.0.1` if a fix is needed.

---

## 2. Build the DMG

```bash
bun run tauri build --target aarch64-apple-darwin
# Build artifact:
#   src-tauri/target/release/bundle/dmg/Meeting Copilot_1.0.0_aarch64.dmg
#   src-tauri/target/release/bundle/macos/Meeting Copilot.app
```

Verify the bundle version:

```bash
defaults read "src-tauri/target/release/bundle/macos/Meeting Copilot.app/Contents/Info.plist" CFBundleShortVersionString
# → 1.0.0
```

If this prints anything other than `1.0.0`, your version bump in `package.json` + `Cargo.toml` did not propagate; abort and re-check.

---

## 3. Codesign the .app bundle

```bash
codesign --deep --force --options runtime \
  --sign "Developer ID Application: <ORG_NAME> (<APPLE_TEAM_ID>)" \
  "src-tauri/target/release/bundle/macos/Meeting Copilot.app"
```

`<ORG_NAME>` is the organization name on your Developer ID certificate (e.g. `Acme Inc.`). The exact string must match the certificate's CN. List installed certs with:

```bash
security find-identity -p codesigning -v
# → Look for "Developer ID Application: <ORG_NAME> (<APPLE_TEAM_ID>)" in the output
```

Verify the signature:

```bash
codesign -vvv --deep --strict "src-tauri/target/release/bundle/macos/Meeting Copilot.app"
# Expected: "satisfies its Designated Requirement"
```

If `codesign -vvv` reports any of `not signed at all`, `code object is not signed at all`, or `invalid signature`, abort and re-run step 3 with a freshly-imported Developer ID cert.

---

## 4. Notarize the DMG

```bash
xcrun notarytool submit \
  "src-tauri/target/release/bundle/dmg/Meeting Copilot_1.0.0_aarch64.dmg" \
  --keychain-profile "AC_PASSWORD" \
  --wait
```

`--wait` blocks until Apple's notarization service responds (typical: 2–10 minutes). Expected output:

```
status: Accepted
```

Any other status (`Invalid`, `In Progress`-stuck, `Rejected`) = fix and retry. Common failures:

- **`Invalid` with `errors: The signature of the binary is invalid`** → step 3 codesign was wrong; re-run `codesign --deep --force --options runtime …`.
- **`Invalid` with `errors: The hardened runtime is missing for binary…`** → `--options runtime` was omitted on a nested binary; re-run codesign with `--deep`.
- **`Rejected` with entitlements complaint** → check `src-tauri/Entitlements.plist` exists and is referenced by `tauri.conf.json`.

For the failure log:

```bash
xcrun notarytool log <SUBMISSION_ID> --keychain-profile "AC_PASSWORD"
```

(`<SUBMISSION_ID>` is printed by `submit`.)

Do **NOT** publish a non-`Accepted` DMG. Gatekeeper will block it on first launch.

---

## 5. Staple the notarization ticket

```bash
xcrun stapler staple "src-tauri/target/release/bundle/dmg/Meeting Copilot_1.0.0_aarch64.dmg"
# Expected: "The staple and validate action worked!"

xcrun stapler validate "src-tauri/target/release/bundle/dmg/Meeting Copilot_1.0.0_aarch64.dmg"
# Expected: "The validate action worked!"
```

Stapling embeds the notarization ticket directly into the DMG so end-users can launch the app offline (without phoning home to Apple's notarization service). A non-stapled DMG works online but throws Gatekeeper warnings on offline machines.

---

## 6. Compute SHA-256 (for the Homebrew cask)

```bash
shasum -a 256 "src-tauri/target/release/bundle/dmg/Meeting Copilot_1.0.0_aarch64.dmg" \
  | awk '{print $1}'
# → 64-character hex string, e.g. a3f1c8...
```

Save the output. It goes into `docs/release/HOMEBREW-CASK-TEMPLATE.rb` line `sha256 "REPLACE_WITH_SHA256_OF_NOTARIZED_DMG"` BEFORE the cask PR is submitted.

---

## 7. Upload to the GitHub release

After the PHASE-4-COMPLETE.md sign-off doc is committed and the v1.0.0 tag is pushed:

```bash
git push origin main             # push any post-tag follow-up commits (e.g. Cargo.lock update)
git push origin v1.0.0           # push the annotated tag

gh release create v1.0.0 \
  "src-tauri/target/release/bundle/dmg/Meeting Copilot_1.0.0_aarch64.dmg" \
  --title "v1.0.0" \
  --notes-file "docs/RELEASE-NOTES-v1.0.0.md"
```

The DMG asset URL printed by `gh release create` (e.g. `https://github.com/<owner>/<repo>/releases/download/v1.0.0/Meeting%20Copilot_1.0.0_aarch64.dmg`) replaces `REPLACE_WITH_RELEASE_URL` in the Homebrew cask template.

---

## 8. Hand-off to Homebrew cask submission

See `docs/release/HOMEBREW-CASK-TEMPLATE.rb` — read the 12-line `# DO NOT SUBMIT THIS FILE AS-IS` comment block at the top of that file BEFORE editing. Substitute every `REPLACE_WITH_…` token with the values you just computed:

| Token | Source |
|---|---|
| `REPLACE_WITH_SHA256_OF_NOTARIZED_DMG` | `shasum -a 256` output from §6 |
| `REPLACE_WITH_RELEASE_URL` | DMG asset URL from `gh release create` in §7 |
| `REPLACE_WITH_HOMEPAGE_URL` | The repo's GitHub URL (operator decides — public repo only) |

Then run the local cask audit:

```bash
brew style ./docs/release/HOMEBREW-CASK-TEMPLATE.rb       # ruby style + cask DSL lint
brew audit --new --cask ./docs/release/HOMEBREW-CASK-TEMPLATE.rb  # full audit
brew install --cask ./docs/release/HOMEBREW-CASK-TEMPLATE.rb       # install locally
brew uninstall --cask meeting-copilot                              # clean up after smoke test
```

Both `brew style` and `brew audit --new` MUST exit 0 before opening a `homebrew/homebrew-cask` PR. If `brew audit` complains about `livecheck` or `auto_updates`, follow the documented homebrew-cask conventions; if it complains about a literal `REPLACE_WITH_…` string still in the file, you skipped a substitution — go back to §6 / §7.

When local audit is clean, copy the `.rb` file into your `homebrew/homebrew-cask` fork at `Casks/m/meeting-copilot.rb`, commit, and open the PR with title `Add meeting-copilot v1.0.0`. Agent does NOT submit the PR — operator owns the final keypress.

---

## 9. Post-release sanity check

After the DMG is live on GitHub releases AND the cask is merged into `homebrew-cask`:

```bash
# Fresh install path — same path an end-user takes
brew install --cask meeting-copilot
brew info --cask meeting-copilot           # → 1.0.0
xcrun stapler validate /Applications/Meeting\ Copilot.app
defaults read /Applications/Meeting\ Copilot.app/Contents/Info.plist CFBundleShortVersionString
# → 1.0.0

# MCP smoke
brew install bun                 # if not present
bun run mcp-server --version     # not directly applicable from a cask install; agent dispatch path:
#   from claude-bridge: bridge_meeting_install({}) → expectedVersion: "1.0.0"
```

If anything in §9 fails, file a `v1.0.1` follow-up issue with the failing command + output. Do NOT yank the v1.0.0 tag — release is immutable once on GitHub.

---

## Appendix — what the agent did vs. what the operator does

| Step | Agent (loop step 13) | Operator (host) |
|---|---|---|
| Bump `package.json#version` + `Cargo.toml#version × 4` | ✅ | — |
| Write release notes | ✅ | — |
| Write DMG instructions (this file) | ✅ | — |
| Write Homebrew cask template | ✅ | — |
| Create local annotated tag `v1.0.0` | ✅ (no push) | — |
| `cargo build --workspace` re-verify | — | ✅ |
| `bun run tauri build` | — | ✅ |
| `codesign` | — | ✅ |
| `xcrun notarytool submit` | — | ✅ |
| `xcrun stapler staple` | — | ✅ |
| Compute SHA-256 | — | ✅ |
| `git push origin v1.0.0` | — | ✅ |
| `gh release create` | — | ✅ |
| Substitute tokens in `HOMEBREW-CASK-TEMPLATE.rb` | — | ✅ |
| `brew style` + `brew audit` + local install smoke | — | ✅ |
| Open `homebrew/homebrew-cask` PR | — | ✅ |
