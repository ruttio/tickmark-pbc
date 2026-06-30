# Wiring the prototype to the data layer

The data layer is three files:

| file | what it is |
|------|------------|
| `lib/supabaseClient.js` | the shared `supabase` browser client + the Edge Function URL |
| `lib/portalApi.js` | `firmApi` (authenticated staff) and `clientApi` (code + token) |
| `.env.example` | copy to `.env.local`, fill URL + anon key |

Prereqs (the prototype currently has no build): a Vite + React app so
`import.meta.env`, JSX, and npm imports work. Then:

```bash
npm i @supabase/supabase-js xlsx
cp .env.example .env.local   # fill in the two values
```

## The core mental shift

`pbc-portal.jsx` today keeps **all** state in `engagements[]` and mutates it
synchronously, then mirrors it to `window.storage`. With a real backend:

- **The server is the source of truth.** UI actions become `await firmApi.x()`
  / `await clientApi.x()`, then you **re-fetch** (or optimistically patch local
  state and reconcile). Drop the `window.storage` load/persist effects entirely.
- **Firm and Client become two code paths**, not a role toggle on shared state.
  Firm reads tables (RLS-scoped); Client only ever sees what the Edge Function
  returns for its one unlocked portal.

The `map*` helpers already return the camelCase shape the components expect
(`periodEnd`, `dueDate`, `files[]`, `history[]`), so the render tree barely
changes — only where the data *comes from* changes.

## Firm side — action → API

| prototype action | replace with |
|---|---|
| load/seed `useEffect` + `window.storage.get` | `const engagements = await firmApi.listEngagements()` |
| selecting a portal (`currentId`) | `const eng = await firmApi.getEngagement(id)` (items+files+history) |
| `generateEngagement(...)` | `await firmApi.createEngagement(meta, buildItems(tpl, baseDue))` → re-list |
| `importEngagement(...)` | same: `createEngagement(meta, mappedItems)` |
| `addItem(...)` | `await firmApi.addItem(eng.id, item, sort)` |
| `deleteItem(id)` | `await firmApi.deleteItem(id)` |
| `setEngPasscode(id, code)` | `await firmApi.setPortalCode(id, code)` |
| `setEngRetention(id, days, auto)` | `await firmApi.setRetention(id, { expiresAt, autoDelete })` |
| `extendEng(id, days)` | `setRetention` with the new `expiresAt` |
| `deleteEng(id)` | `await firmApi.deleteEngagement(id)` |
| review buttons (drawer) | `firmApi.startReview / acceptItem / returnItem(id,note) / reopenItem` |
| download a client file | `window.open(await firmApi.signedDownloadUrl(f.storagePath))` |

`buildItems(template, baseDue)` already produces rows close to what
`createEngagement`'s second arg wants — pass `{ category, description, required,
dueDate, ref, sort }`.

The lock screen / `hashCode` flow on the firm side goes away: firm access is
Supabase Auth (email + password), not the 16-digit code. Add a sign-in screen
that calls `firmApi.signIn(...)` and gate the app on `firmApi.getSession()`.

## Client side — IMPLEMENTED

The client portal is built and wired to `clientApi`:

- Entry: **`client.html`** → `src/client.jsx` → `src/ClientPortal.jsx`
  (a separate Vite bundle — it never includes the firm app's code or data).
- Per-client link: **`/client.html?e=<engagement_uuid>`**. Each client gets
  their own `engagement_id` in the URL; the 16-digit code is shared out of band.
- Flow: lock screen → `clientApi.unlock` → `clientApi.fetchData` → per-item
  `clientApi.uploadDocument`. The session token is bound server-side to one
  engagement, so the URL's `engagement_id` is used **only** for `unlock`; every
  later call sends the token alone. Tampering with the URL just lands on another
  portal's lock screen, which still needs that portal's code.

To test once Supabase is live: create a portal on the firm side, copy its
engagement id, open `http://localhost:5173/client.html?e=<that-id>`, and enter
the 16-digit code. Without a deployed backend the lock screen renders but
`unlock` will fail (no Edge Function to call).

The lower-level client calls, if you ever need them à la carte (this is exactly
what `ClientPortal.jsx` does internally, keyed off `engagement_id` from the
portal link, e.g. `?e=<uuid>`):

```js
// 1) unlock with the 16-digit code (replaces LockScreen's hashCode compare)
const { token, expiresAt } = await clientApi.unlock(engagementId, code);
// keep `token` in memory (sessionStorage at most); it expires in 8h

// 2) load the request list (replaces reading from window.storage)
const { engagement, items } = await clientApi.fetchData(token);

// 3) upload a document (replaces uploadFiles' metadata-only push)
await clientApi.uploadDocument(token, itemId, file); // real bytes now
const fresh = await clientApi.fetchData(token);       // re-fetch to reflect "submitted"
```

`unlock` throws with `err.status` — handle `401` (wrong code) and `429`
(throttled: 5 wrong tries → 15-min lock) for the same UX the prototype's
`LockScreen` shows manually.

## Things the backend does NOT cover yet (decide before going live)

- **Manual `deleteEngagement` leaves storage objects behind** — firm staff have
  `SELECT` but not `DELETE` on `storage.objects`. Only the nightly cron purges
  files, and only for `auto_delete` + expired portals. If "delete now" must wipe
  files immediately, add a service-role RPC or Edge action to do it.
- **No `request_items` template logic server-side** — `createEngagement` relies
  on the UI passing the built items. That's intentional (templates live in
  `TEMPLATES`), just don't expect the DB to fill them in.
- **Client `data` returns no history** — by design (history is firm-internal).
  Keep the client timeline UI off, or expose a curated subset via the function.
