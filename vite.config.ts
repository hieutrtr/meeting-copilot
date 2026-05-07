import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

// T-4.9 — Add a second rollup entry for the dashboard iframe embed bundle.
// The main app keeps `index.html` as its entry; the embed entry is built to
// `dist/embed/transcript.html` and loaded by the helper-daemon HTTP layer
// (`crates/helper-daemon/src/embed_http.rs`).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        embedTranscript: path.resolve(__dirname, "src/embed/transcript.html"),
      },
    },
  },
});
