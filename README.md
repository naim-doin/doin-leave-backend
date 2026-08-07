# Doin Leave Portal — Backend API

A real backend for the Doin Tech leave portal: SQLite-compatible database
(via libSQL — works with a local file for development and with **Turso**
for a genuinely free, persistent production database), bcrypt-hashed
passwords, JWT-based login sessions, and server-enforced role permissions.
This replaces the "pick your name" demo sign-in with actual authentication —
nobody can act as someone else without their password.

## Why libSQL instead of plain SQLite

Most free hosting (Render, Railway free tiers) doesn't give you a
persistent disk — your SQLite file gets wiped every time the service
restarts or redeploys. Turso is a free, hosted, SQLite-compatible database
that lives independently of your app server, so your data survives
restarts, redeploys, and free-tier sleep cycles. Locally, this same code
just writes to a file — no Turso account needed for development.

## Quick start (local demo/testing)

```bash
npm install
cp .env.example .env
# open .env and set JWT_SECRET to a long random string, e.g.:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# leave DB_URL unset for local dev — it defaults to a local file

npm run seed    # creates data.sqlite with 60 DEMO employees
npm start       # starts the API on http://localhost:4000
```

Every seeded employee's password is `Doin@2026`, and every account is
flagged `mustResetPassword: true` — the frontend should force a password
change on first login before letting anyone into the app. The seed script
prints the HR admin's login email when it runs.

**This demo data is for local testing only** — don't use it for a real
launch. It generates 60 fake people with placeholder names and emails.

## Real launch: creating your actual HR account

There's deliberately no public "sign up" page — anyone on the internet
being able to create an HR account for your company's leave portal would
be a serious security hole. Instead, the first real account is created
by running a script directly wherever the backend lives:

```bash
npm run create-admin -- --name "Your Name" --email you@doin.tech --password "SomeStrongPassword123" --gender male
```

Leave the flags off and it'll prompt you interactively instead. This
creates exactly one real HR account — no demo employees, no placeholder
data — and you can log in immediately with the password you chose (no
forced reset, since you picked it yourself). From there, use "Add
employee" in the app to bring on your real team, or "Set opening
balances" to bulk-import leave people already took earlier this year.

If you're deploying to Render, run this once against your production
database the same way you'd run the seed script — see "Deploying for
free" below for how to point it at Turso.

## Data model

- `employees` — name, email, password hash, department, gender, role
  (`employee` / `manager` / `hr`), and `manager_id` (who approves their
  leave first). One manager per department, seeded automatically; the HR
  admin has no manager and isn't anyone's line manager.
- `leave_types` — Annual (14), Sick (14), Casual (7), Maternity (120,
  female only), Paternity (2, male only), Special (3), and Unpaid
  (effectively uncapped, for once paid balances run out).
- `leave_balances` — per-employee total/used per leave type. Values are
  decimal (`REAL`) to support half-day leave (0.5).
- `requests` — the actual leave applications, with a status of
  `pending_manager` → `pending_hr` → `approved` (or `rejected` at either
  stage). If an employee has no line manager (managers/HR themselves),
  their own requests skip straight to `pending_hr`. A request can be a
  half day (`days: 0.5`) — only allowed when start and end are the same
  date. Rejecting a request at either stage requires a reason.
- `request_log` — an audit trail: who applied/approved/rejected/cancelled
  each request and when.
- `holidays` — company holidays, excluded from leave-day counts along with
  Saturday/Sunday weekends. Fixed-date Bangladesh national holidays are
  pre-seeded; HR can add lunar/religious holidays (Eid, Puja, etc.) once
  dates are confirmed each year.

## API reference

All endpoints except `/api/health` and `/api/auth/login` require
`Authorization: Bearer <token>`.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/auth/login` | anyone | `{email, password}` → `{token, mustResetPassword, user}` |
| POST | `/api/auth/change-password` | signed in | `{currentPassword?, newPassword}` — `currentPassword` only required if not a forced reset |
| GET | `/api/auth/me` | signed in | current user's profile |
| GET | `/api/employees` | signed in | directory; only HR sees everyone's balances |
| POST | `/api/employees` | HR only | create an employee, returns a one-time `tempPassword` |
| GET | `/api/employees/me/balances` | signed in | your own leave balances |
| GET | `/api/requests` | signed in | scoped: employee sees own, manager sees their reports, HR sees all |
| POST | `/api/requests` | signed in | `{type, start, end, reason}` — creates a request |
| POST | `/api/requests/:id/approve` | manager or HR | advances the request one stage |
| POST | `/api/requests/:id/reject` | manager or HR | `{reason}` — reason is required, ends the request |
| POST | `/api/requests/:id/cancel` | the applicant | withdraws their own pending request |
| POST | `/api/requests/preview-days` | signed in | `{start, end}` → business-day count + any holidays hit, for the apply form |
| GET | `/api/holidays` | signed in | list |
| POST | `/api/holidays` | HR only | `{date, label}` |
| DELETE | `/api/holidays/:date` | HR only | remove a holiday |
| GET | `/api/leave-types` | signed in | catalog of leave types and totals |
| GET | `/api/export/requests.csv` | HR only | download all requests |
| GET | `/api/export/employees.csv` | HR only | download the directory with balances |

Every write endpoint checks the requester's actual role and relationship
(e.g. a manager can only approve requests from people whose `manager_id`
is really them) — this is enforced server-side, not just hidden in the UI.

## Deploying for free: Render (API) + Turso (database)

This combination costs $0 and your data genuinely persists — no credit
card required on either side.

### Step 1 — create your Turso database

1. Go to [turso.tech](https://turso.tech) and sign up (free, no card).
2. Install the CLI and log in:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   ```
3. Create the database:
   ```bash
   turso db create doin-leave
   ```
4. Get your connection URL and an auth token:
   ```bash
   turso db show doin-leave --url
   turso db tokens create doin-leave
   ```
   Save both — you'll paste them into Render as environment variables.

   (No CLI access? Turso's web dashboard lets you create a database and
   generate a token through the UI too.)

### Step 2 — push this code to GitHub

Create a repo (private is fine) and push this folder to it.

### Step 3 — deploy to Render

1. Go to [render.com](https://render.com), sign up (free, no card for
   the free web service tier).
2. **New → Web Service**, connect your GitHub repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Add environment variables:
   - `JWT_SECRET` — generate a fresh one (see the command above), don't
     reuse your local dev one
   - `DB_URL` — the `libsql://...` URL from `turso db show`
   - `DB_AUTH_TOKEN` — the token from `turso db tokens create`
   - `CORS_ORIGIN` — leave blank for now; fill in once the frontend has
     a URL
5. Deploy. Render gives you a public HTTPS URL.
6. **Create your real HR account on the production database.** Temporarily
   set `DB_URL`/`DB_AUTH_TOKEN` in your local `.env` to the Turso values,
   then run `npm run create-admin -- --name "..." --email "..." --password
   "..." --gender male` (see "Real launch" above). Use `npm run seed`
   instead only if you specifically want the 60-person demo data for
   testing — not for a real company's data.
7. Confirm it's alive:
   ```bash
   curl https://your-service.onrender.com/api/health
   ```

### The honest trade-off of the free Render tier

The free web service **spins down after 15 minutes of inactivity** and
takes up to ~50 seconds to wake back up on the next request. For a
60-person internal tool that isn't used constantly, that's a real but
livable trade-off — the first request of the morning is slow, the rest
are fine. Your data is completely unaffected by this since it now lives
in Turso, not on Render's disk. If the cold start becomes annoying,
Render's cheapest paid tier ($7/mo) removes it — but you don't need that
to launch.

## Profile photos

Employees can upload their own photo (sidebar → "Change photo"); HR can
set one for anyone via the Team directory's edit panel. Images are
resized client-side to a small thumbnail before upload and stored as a
base64 data URL directly in the database — no external storage service
needed. There's a server-side size cap (~180KB decoded) and format check
(PNG/JPEG/WEBP/GIF) regardless of what the client sends. Photos are
visible to everyone in the directory (unlike balances/email, which are
private) — treat this the same as you would any normal company directory
photo.

## Discord notifications (optional, off by default)

The app can post to a Discord channel whenever someone applies, a manager
or HR approves/rejects, or an employee cancels a request. It ships
**disabled** — if `DISCORD_WEBHOOK_URL` isn't set, every notification call
is a silent no-op and nothing else is affected.

To turn it on:
1. In your Discord server, go to a channel's **Settings → Integrations →
   Webhooks → New Webhook**, and copy its URL.
2. Set `DISCORD_WEBHOOK_URL` to that URL in your environment (Render's
   dashboard, or your local `.env`).
3. That's it — no redeploy of anything else needed, no code changes.

What it sends: 🟡 new application, 🟢 manager approval (forwarded to HR),
✅ final HR approval, ❌ rejection (with the reason), ⚪ cancellation. All
messages go to the one channel — it's one-way (informational only, you
can't approve/reject from Discord itself).

## Security notes — read before real launch

- **Change `JWT_SECRET`.** Never reuse the example/dev value in production.
- **Force the password reset flow.** Every seeded account starts on a
  shared default password. The frontend must call
  `/api/auth/change-password` before granting access when
  `mustResetPassword` is true.
- **Set `CORS_ORIGIN`** to your actual frontend URL in production, not
  left blank (which allows any origin).
- There's a basic login rate limit (10 attempts/minute/IP) — fine for a
  60-person company, but not a substitute for a real WAF if this ever
  needs to withstand serious abuse.
- There's no email-based "forgot password" flow yet — HR would currently
  need to reset an account by re-running part of the seed logic or a
  small admin script. Worth adding before full rollout if self-serve
  reset matters to you.

## Next step: connecting the frontend

The HTML portal built earlier currently talks to browser-local storage,
not this API. Wiring it up means replacing its data layer with `fetch()`
calls to these endpoints, adding a real login screen (email + password)
in place of the name-picker, and handling the forced password-reset flow.
That's a distinct, sizeable piece of work — say the word and I'll do that
next once this backend is deployed and you have a real URL.

