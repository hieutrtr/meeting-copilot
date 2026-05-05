# Icons

Phase 0 placeholder: `icon.png` is a 1×1 transparent PNG just to satisfy
`tauri.conf.json`'s `bundle.icon` schema. **Replace before any release build.**

To regenerate proper icons (Phase 1 task — owner of T-1.13 packaging):

```sh
# put a 1024×1024 source PNG at src-tauri/icons/source.png, then:
cargo tauri icon src-tauri/icons/source.png
```

That generates the full set: `32x32.png`, `128x128.png`, `128x128@2x.png`,
`icon.icns` (macOS), `icon.ico` (Windows), various Android/iOS sizes.

The current placeholder is sufficient to launch `cargo tauri dev` (window
shows blank dock icon) but not for `cargo tauri build`.
