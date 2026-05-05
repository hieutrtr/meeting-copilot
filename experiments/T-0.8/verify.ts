// experimental, not for prod — Phase 0 T-0.8 structural verifier.
// Single-file bun-runnable assertions. Exit 0 = all green, exit 1 = any miss.
//
// Why bun and not pure bash? JSON parse + grep stay in one TypeScript file with
// strong typing, easier to audit, no jq dependency. Same shape as
// experiments/T-0.5/scripts/run-bench.ts.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

function fileExists(rel: string, name: string) {
  const p = resolve(ROOT, rel);
  record(name, existsSync(p), `path=${rel}`);
}

function fileContains(rel: string, pattern: RegExp, name: string) {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) {
    record(name, false, `missing: ${rel}`);
    return;
  }
  const txt = readFileSync(p, "utf8");
  const m = pattern.exec(txt);
  record(name, m !== null, `pattern=${pattern} -> ${m ? "match" : "no match"}`);
}

function jsonParses(rel: string, name: string): unknown | null {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) {
    record(name, false, `missing: ${rel}`);
    return null;
  }
  try {
    const obj = JSON.parse(readFileSync(p, "utf8"));
    record(name, true, `parsed`);
    return obj;
  } catch (e) {
    record(name, false, `parse error: ${(e as Error).message}`);
    return null;
  }
}

// AC-1: project root layout matches ARCH App A
fileExists("package.json", "AC-1a/package.json exists");
fileExists("index.html", "AC-1b/index.html exists");
fileExists("vite.config.ts", "AC-1c/vite.config.ts exists");
fileExists("tsconfig.json", "AC-1d/tsconfig.json exists");
fileExists("src", "AC-1e/src/ exists");
fileExists("src/main.tsx", "AC-1f/src/main.tsx exists");
fileExists("src/App.tsx", "AC-1g/src/App.tsx exists");
fileExists("src-tauri", "AC-1h/src-tauri/ exists");
fileExists("src-tauri/Cargo.toml", "AC-1i/Cargo.toml exists");
fileExists("src-tauri/build.rs", "AC-1j/build.rs exists");
fileExists("src-tauri/tauri.conf.json", "AC-1k/tauri.conf.json exists");
fileExists("src-tauri/src/main.rs", "AC-1l/src-tauri/src/main.rs exists");
fileExists("src-tauri/src/lib.rs", "AC-1m/src-tauri/src/lib.rs exists");
fileExists("src-tauri/capabilities/default.json", "AC-1n/capabilities/default.json exists");
fileExists("src-tauri/icons/icon.png", "AC-1o/icons/icon.png exists");

// AC-2: package.json declares the right deps
const pkg = jsonParses("package.json", "AC-2a/package.json valid JSON") as
  | Record<string, Record<string, string>>
  | null;
if (pkg) {
  const has = (kind: "dependencies" | "devDependencies", key: string) =>
    pkg[kind] && Object.prototype.hasOwnProperty.call(pkg[kind], key);
  record("AC-2b/dep @tauri-apps/api", has("dependencies", "@tauri-apps/api"), "");
  record("AC-2c/dep react", has("dependencies", "react"), "");
  record("AC-2d/dep react-dom", has("dependencies", "react-dom"), "");
  record(
    "AC-2e/devDep @tauri-apps/cli",
    has("devDependencies", "@tauri-apps/cli"),
    "",
  );
  record("AC-2f/devDep vite", has("devDependencies", "vite"), "");
  record(
    "AC-2g/devDep @vitejs/plugin-react",
    has("devDependencies", "@vitejs/plugin-react"),
    "",
  );
  record(
    "AC-2h/script tauri",
    typeof pkg.scripts?.tauri === "string",
    "",
  );
}

// AC-3: Cargo.toml declares Tauri 2 deps (TOML parser not on host — grep gate)
fileContains("src-tauri/Cargo.toml", /^\s*tauri\s*=\s*\{[^}]*version\s*=\s*"2"/m, "AC-3a/Cargo.toml tauri@2");
fileContains("src-tauri/Cargo.toml", /^\s*tauri-build\s*=\s*\{[^}]*version\s*=\s*"2"/m, "AC-3b/Cargo.toml tauri-build@2");
fileContains("src-tauri/Cargo.toml", /^\s*serde\s*=/m, "AC-3c/Cargo.toml serde dep");
fileContains("src-tauri/Cargo.toml", /crate-type\s*=\s*\[[^\]]*"cdylib"/m, "AC-3d/Cargo.toml lib.crate-type contains cdylib");

// AC-4: tauri.conf.json valid JSON + has window + dev URL + identifier
const conf = jsonParses("src-tauri/tauri.conf.json", "AC-4a/tauri.conf.json valid JSON") as
  | {
      identifier?: string;
      build?: { devUrl?: string; beforeDevCommand?: string; frontendDist?: string };
      app?: { windows?: Array<{ label?: string; title?: string }> };
    }
  | null;
if (conf) {
  record("AC-4b/identifier set", !!conf.identifier && conf.identifier.length > 0, conf.identifier ?? "");
  record(
    "AC-4c/build.devUrl points at vite",
    conf.build?.devUrl === "http://localhost:1420",
    conf.build?.devUrl ?? "",
  );
  record(
    "AC-4d/build.beforeDevCommand uses bun",
    !!conf.build?.beforeDevCommand?.includes("bun run dev"),
    conf.build?.beforeDevCommand ?? "",
  );
  record(
    "AC-4e/build.frontendDist = ../dist",
    conf.build?.frontendDist === "../dist",
    conf.build?.frontendDist ?? "",
  );
  const windows = conf.app?.windows ?? [];
  const main = windows.find((w) => w.label === "main");
  record("AC-4f/window 'main' declared", !!main, JSON.stringify(main ?? null));
}

// AC-5: IPC smoke test wired both sides
fileContains("src-tauri/src/lib.rs", /#\[tauri::command\]\s*\nfn\s+greet\s*\(/m, "AC-5a/lib.rs greet command");
fileContains(
  "src-tauri/src/lib.rs",
  /generate_handler!\[\s*greet\s*\]/,
  "AC-5b/lib.rs greet registered in invoke_handler",
);
fileContains("src/App.tsx", /import\s*\{\s*invoke\s*\}\s*from\s*["']@tauri-apps\/api\/core["']/, "AC-5c/App.tsx imports invoke");
fileContains("src/App.tsx", /invoke<string>\s*\(\s*["']greet["']\s*,\s*\{\s*name\s*\}/, "AC-5d/App.tsx calls invoke('greet', { name })");

// AC-5 bonus: capability file references main window + core:default
const cap = jsonParses("src-tauri/capabilities/default.json", "AC-5e/capability JSON valid") as
  | { windows?: string[]; permissions?: string[] }
  | null;
if (cap) {
  record(
    "AC-5f/capability windows includes 'main'",
    Array.isArray(cap.windows) && cap.windows.includes("main"),
    JSON.stringify(cap.windows ?? null),
  );
  record(
    "AC-5g/capability permission core:default",
    Array.isArray(cap.permissions) && cap.permissions.includes("core:default"),
    JSON.stringify(cap.permissions ?? null),
  );
}

// Summary
const failed = checks.filter((c) => !c.ok);
const fmt = (c: Check) => `  [${c.ok ? "ok " : "FAIL"}] ${c.name}${c.detail ? "  // " + c.detail : ""}`;
console.log(checks.map(fmt).join("\n"));
console.log("");
console.log(
  failed.length === 0
    ? `[verify] ${checks.length}/${checks.length} structural checks passed.`
    : `[verify] ${checks.length - failed.length}/${checks.length} passed; ${failed.length} FAILED`,
);

if (failed.length > 0) process.exit(1);
process.exit(0);
