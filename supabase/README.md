# Tickmark PBC portal — Supabase backend

A deployable starting point that moves the prototype off browser storage and onto a
real multi-tenant backend, with the 16-digit code checked **server-side** and per-portal
isolation enforced by the database.

## What's here

```
supabase/
  schema.sql                 ← tables, RLS, passcode RPCs, storage bucket, 90-day auto-delete cron
  functions/portal/index.ts  ← the client gateway (unlock / data / upload / confirm)
```

## How access works

- **Firm staff** sign in with Supabase Auth (email + password). Row Level Security
  limits them to engagements belonging to **their own firm** — they use the normal
  `supabase-js` client and never see another firm's data.
- **Clients** are *not* Supabase users. They open a portal link, type the 16-digit code,
  and the `portal` Edge Function verifies it (bcrypt, in the database) and returns a
  short-lived **session token** (8h). Every client read/upload goes through that function,
  which runs with the service role. Because RLS denies the anon key, a client can only ever
  reach the one portal whose code they hold.

## Setup (about 15 minutes)

1. **Create a project** at supabase.com and grab the Project URL + anon key
   (Settings → API). The service-role key is set automatically for Edge Functions.
2. **Run the schema.** Open the SQL editor, paste `schema.sql`, run it. This also
   creates the private `pbc` storage bucket and schedules the nightly purge.
   - If `pg_cron`/`cron.schedule` errors, enable it under Database → Extensions first.
3. **Deploy the function:**
   ```bash
   supabase link --project-ref <your-ref>
   supabase functions deploy portal --no-verify-jwt
   ```
   `--no-verify-jwt` is required: clients have no Supabase JWT — we authenticate them
   with the code instead.
4. **Sign up a firm user.** In your app's sign-up call, pass firm/full name as metadata
   so the trigger provisions a firm + profile:
   ```js
   await supabase.auth.signUp({
     email, password,
     options: { data: { firm_name: "Your Firm Co.", full_name: "Jane CPA" } },
   });
   ```

## Wiring the React prototype to it

Replace the `window.storage` calls. Add a client:

```js
// supabaseClient.js
import { createClient } from "@supabase/supabase-js";
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
```

**Firm side** (authenticated — RLS does the scoping):

```js
// create a portal (hashing happens in the DB)
const { data: engagementId } = await supabase.rpc("create_engagement", {
  p_client: "Northwind Trading Co.", p_template: "Annual Financial Statement Audit",
  p_period_end: "2025-12-31", p_code: "1234123412341234",
  p_retention_days: 90, p_auto_delete: true,
});

// list your firm's portals
const { data: engagements } = await supabase.from("engagements").select("*");

// change a code later
await supabase.rpc("set_portal_code", { p_engagement: engagementId, p_code: "9999..." });

// download a client's file (private bucket -> signed URL)
const { data } = await supabase.storage.from("pbc").createSignedUrl(file.storage_path, 60);
window.open(data.signedUrl);
```

**Client side** (no login — code + session token, all via the function):

```js
const call = (action, payload) =>
  fetch(`${SUPABASE_URL}/functions/v1/portal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ action, ...payload }),
  }).then((r) => r.json());

// 1) unlock with the 16-digit code
const { token } = await call("unlock", { engagement_id, code });

// 2) load the request list
const { engagement, items } = await call("data", { token });

// 3) upload a document
const { path, signed } = await call("upload_url", { token, item_id, filename: file.name, type: file.type });
await supabase.storage.from("pbc").uploadToSignedUrl(path, signed.token, file);
await call("confirm", { token, item_id, name: file.name, size: file.size, type: file.type, storage_path: path });
```

## Cost expectations on Supabase

With 90-day retention and downloading files off afterward, your live footprint stays
small. The Pro plan ($25/mo) includes 100 GB file storage and 250 GB egress — at
~0.4 GB per client that's headroom for hundreds of active portals before any overage.
The free tier works for development but **pauses after 7 days of inactivity**, so run
production on Pro.

## Security notes / things to harden before going live

- **Rate limiting** on `unlock` is included (5 wrong tries → 15-minute lock per portal).
  Consider also limiting by IP at the edge/CDN.
- **Share the code out of band** — phone/SMS, not the same email as the portal link.
- **Session length** is 8h (`SESSION_HOURS`); shorten if you want tighter control.
- **Audit retention**: the cron hard-deletes expired auto-delete portals. If professional
  rules require keeping working papers for years, set `auto_delete = false` on those and
  archive the downloaded files yourself (your stated plan), or point the purge at cold
  storage instead of deletion.
- **Backups**: Pro includes daily backups (7 days). Enable point-in-time recovery if you
  need finer-grained restore.
