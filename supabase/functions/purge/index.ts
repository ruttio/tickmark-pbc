// =====================================================================
//  Edge Function: `purge` — cleanup jobs. Guarded by PURGE_SECRET,
//  deployed with --no-verify-jwt. Triggered daily (GitHub Actions).
//
//  POST { secret }                          -> expire auto-delete portals
//  POST { secret, action: "orphans" }       -> DRY RUN: report orphaned objects
//  POST { secret, action: "orphans", apply: true } -> delete those orphans
//
//  Both jobs delete the R2 objects FIRST, then the DB rows (which cascade
//  items/files/history/members/sessions). If R2 deletion fails the DB rows are
//  left alone, so the object is still reachable and the next run retries it —
//  never the other way round, which would orphan the object forever.
//
//  EVERY table that stores a storage_path must be listed in PATH_TABLES below.
//  The orphan sweep deletes any object it cannot match to a row, so a table
//  omitted there is not a missed cleanup — it is data destruction.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteObjects, listObjects } from "../_shared/r2.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Every table that owns R2 objects. MISSING ONE HERE IS DESTRUCTIVE: the
// orphan sweep deletes whatever it cannot find a row for, so a table left off
// this list has all of its files classified as garbage and erased, leaving DB
// rows pointing at nothing. `deliverable_files` was added after this function
// was written and was exactly that bug — the firm's filed tax returns were one
// `orphans-apply` away from deletion.
const PATH_TABLES = ["item_files", "deliverable_files"] as const;

// Every storage_path the DB knows about, across ALL firms (service role, no RLS).
// Anything in the bucket that is not in this set is unreferenced.
async function knownPaths(): Promise<Set<string>> {
  const known = new Set<string>();
  const PAGE = 1000;
  for (const table of PATH_TABLES) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from(table).select("storage_path").range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      for (const r of data || []) if (r.storage_path) known.add(r.storage_path);
      if (!data || data.length < PAGE) break;
    }
  }
  return known;
}

// Every R2 object belonging to one engagement, from every owning table. Used
// when deleting a portal: objects go before the rows, and a table missed here
// leaks its objects into the bucket forever once the rows cascade away.
async function engagementPaths(engagementId: string): Promise<string[]> {
  const paths: string[] = [];
  for (const table of PATH_TABLES) {
    const { data, error } = await admin
      .from(table).select("storage_path").eq("engagement_id", engagementId);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data || []) if (r.storage_path) paths.push(r.storage_path);
  }
  return paths;
}

// Objects in the bucket that no item_files row points at. Only objects older
// than `minAgeMs` count: a file is PUT to R2 before its DB row is inserted, so a
// freshly-uploaded object legitimately looks unreferenced for a few seconds.
async function findOrphans(minAgeMs: number) {
  const [objects, known] = await Promise.all([listObjects(), knownPaths()]);
  const cutoff = Date.now() - minAgeMs;
  const orphans = objects.filter((o) => !known.has(o.key) && o.lastModified > 0 && o.lastModified < cutoff);
  const tooNew = objects.filter((o) => !known.has(o.key) && !(o.lastModified > 0 && o.lastModified < cutoff));
  return {
    bucketObjects: objects.length,
    bucketBytes: objects.reduce((n, o) => n + o.size, 0),
    dbPaths: known.size,
    orphans,
    orphanBytes: orphans.reduce((n, o) => n + o.size, 0),
    skippedTooNew: tooNew.length,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const body = await req.json().catch(() => ({}));
  if (body?.secret !== Deno.env.get("PURGE_SECRET")) return json({ error: "forbidden" }, 403);

  try {
    /* ---- reconcile the bucket against the DB ---------------------------- */
    if (body?.action === "orphans") {
      const minAgeMs = Number(body?.min_age_hours ?? 24) * 3600_000;
      const report = await findOrphans(minAgeMs);
      const keys = report.orphans.map((o) => o.key);

      if (!body?.apply) {
        return json({
          dry_run: true, ...report,
          orphans: report.orphans.map((o) => ({ key: o.key, size: o.size, last_modified: new Date(o.lastModified).toISOString() })),
        });
      }
      if (keys.length) await deleteObjects(keys); // throws → nothing is reported as deleted
      return json({ dry_run: false, deleted: keys.length, deleted_bytes: report.orphanBytes, skipped_too_new: report.skippedTooNew });
    }

    /* ---- expire auto-delete portals ------------------------------------- */
    const { data: expired, error } = await admin.from("engagements")
      .select("id").eq("auto_delete", true).not("expires_at", "is", null).lt("expires_at", new Date().toISOString());
    if (error) return json({ error: error.message }, 500);
    const ids = (expired || []).map((e) => e.id);

    let portals = 0, files = 0;
    const failed: { id: string; error: string }[] = [];

    // One portal at a time: a portal whose R2 objects refuse to delete must not
    // block the others, and must keep its DB rows so the next run can retry.
    for (const id of ids) {
      let paths: string[];
      try {
        paths = await engagementPaths(id);
      } catch (e) { failed.push({ id, error: String((e as Error)?.message || e) }); continue; }
      try {
        if (paths.length) await deleteObjects(paths);
      } catch (e) {
        failed.push({ id, error: String((e as Error)?.message || e) });
        continue;
      }
      const { error: de } = await admin.from("engagements").delete().eq("id", id);
      if (de) { failed.push({ id, error: de.message }); continue; }
      portals++; files += paths.length;
    }

    return json({ portals, files, expired: ids.length, failed }, failed.length ? 207 : 200);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
