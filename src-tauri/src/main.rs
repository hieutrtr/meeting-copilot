// experimental, not for prod — Phase 0 T-0.8 scaffold.
// Entry shim. Real entry is `meeting_copilot_lib::run` in lib.rs so the same
// runner works on desktop + (future) mobile via #[tauri::mobile_entry_point].

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    meeting_copilot_lib::run()
}
