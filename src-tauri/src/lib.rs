// experimental, not for prod — Phase 0 T-0.8 scaffold.
// IPC smoke test: a single `greet` command. Frontend in src/App.tsx calls
// `invoke<string>("greet", { name })`. Phase 1 (T-1.1+) replaces this with
// real audio-capture daemon RPC per ARCH §8.2.

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello {name}, from Tauri!")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet])
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
}
