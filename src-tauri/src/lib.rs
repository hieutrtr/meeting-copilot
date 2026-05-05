// Phase 0 (T-0.8) shipped a `greet` IPC smoke command — kept as a regression baseline.
// Phase 1 T-1.2 adds `ping`, the new liveness command that delegates to the
// helper-daemon crate (per ARCH App A `crates/helper-daemon`). Real audio /
// meeting-state commands land in T-1.3 .. T-1.9.

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello {name}, from Tauri!")
}

#[tauri::command]
fn ping() -> String {
    helper_daemon::ping().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet, ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greet_smoke() {
        assert_eq!(greet("World"), "Hello World, from Tauri!");
    }

    #[test]
    fn greet_handles_empty_name() {
        assert_eq!(greet(""), "Hello , from Tauri!");
    }

    #[test]
    fn ping_command_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn ping_delegates_to_daemon() {
        assert_eq!(ping(), helper_daemon::ping());
    }
}
