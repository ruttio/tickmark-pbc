import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Vite loads these files itself, but this preflight runs before Vite. Load only
// missing values and keep process-level/CI variables at the highest priority.
for (const file of [".env.local", ".env"]) {
  const path = join(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const missing = required.filter((key) => !String(process.env[key] || "").trim());

if (missing.length) {
  console.error(`Missing required build environment: ${missing.join(", ")}`);
  process.exit(1);
}

const url = String(process.env.VITE_SUPABASE_URL).trim();
if (!/^https:\/\/[^\s]+\.supabase\.co\/?$/i.test(url)) {
  console.error("VITE_SUPABASE_URL must be a hosted Supabase project URL.");
  process.exit(1);
}

if (String(process.env.VITE_SUPABASE_ANON_KEY).trim().length <= 20) {
  console.error("VITE_SUPABASE_ANON_KEY does not look valid.");
  process.exit(1);
}

console.log(`Build environment OK (${new URL(url).hostname}).`);
