// Phase 4 T-4.3 — Pure Info.plist version extractor.
//
// macOS .app bundles ship a `Contents/Info.plist` XML property list with a
// stable `CFBundleShortVersionString` key whose value is the user-visible
// release number (e.g. "0.3.0"). This module reads that single key only —
// no full XML parsing — so we avoid pulling in a dependency for a layout
// that has been frozen since 10.0 (2001).
//
// Failure mode: if the key is absent or the file isn't an Apple plist, we
// return `null`. The caller decides what to do (T-4.3 handler reports a
// "malformed Info.plist" envelope to the operator).

const VERSION_KEY = "CFBundleShortVersionString";

// Match `<key>CFBundleShortVersionString</key>` followed (after optional
// whitespace) by `<string>VALUE</string>`. The character class on VALUE
// excludes `<` so the match cannot bleed past the closing tag.
const VERSION_RE = new RegExp(
  `<key>${VERSION_KEY}</key>\\s*<string>([^<]+)</string>`,
);

/** Extract the bundle's user-visible release version. Returns `null` if the
 *  key is missing or the input is not a recognizable plist. */
export function parseInfoPlistVersion(xml: string): string | null {
  if (typeof xml !== "string" || xml.length === 0) return null;
  const m = xml.match(VERSION_RE);
  if (!m) return null;
  const value = m[1].trim();
  return value.length > 0 ? value : null;
}
