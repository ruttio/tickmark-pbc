import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const failures = [];
const expectFile = (path) => {
  if (!existsSync(join(root, path))) failures.push(`missing ${path}`);
};

const migrationDir = join(root, "supabase", "migrations");
const expectedMigrations = [
  "20260629000100_initial_schema.sql",
  "20260705000100_portal_sharing.sql",
  "20260705000200_line.sql",
  "20260712000100_client_groups.sql",
  "20260712000200_history_actor.sql",
  "20260713000100_item_comments.sql",
  "20260713000200_item_reads.sql",
  "20260713000300_analytics.sql",
  "20260713000400_disable_legacy_pg_cron_purge.sql",
  "20260715000100_analytics_evidence.sql",
];

if (!existsSync(migrationDir)) failures.push("missing supabase/migrations");
else {
  const actual = readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort();
  for (const name of expectedMigrations) {
    if (!actual.includes(name)) failures.push(`missing migration ${name}`);
  }
  for (const name of actual) {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(name)) failures.push(`invalid migration filename ${name}`);
  }
}

const functions = ["portal", "firmfiles", "notify", "purge", "line-webhook"];
for (const name of functions) expectFile(`supabase/functions/${name}/index.ts`);
expectFile("supabase/config.toml");
expectFile(".env.example");
expectFile(".github/workflows/ci.yml");
expectFile(".github/workflows/deploy-backend.yml");

if (existsSync(join(root, "supabase", "config.toml"))) {
  const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
  const expectedJwt = { portal: false, "line-webhook": false, purge: false, firmfiles: true, notify: true };
  for (const [name, value] of Object.entries(expectedJwt)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = new RegExp(`\\[functions\\.${escaped}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(config)?.[1] || "";
    if (!new RegExp(`verify_jwt\\s*=\\s*${value}`).test(section)) failures.push(`wrong verify_jwt for ${name}`);
  }
}

const legacySql = existsSync(join(root, "supabase"))
  ? readdirSync(join(root, "supabase")).filter((name) => name.endsWith(".sql"))
  : [];
if (legacySql.length) failures.push(`SQL must live in supabase/migrations: ${legacySql.join(", ")}`);

if (failures.length) {
  console.error("Deployment structure check failed:\n- " + failures.join("\n- "));
  process.exit(1);
}

console.log(`Deployment structure OK: ${expectedMigrations.length} migrations, ${functions.length} Edge Functions.`);
