# PodNet — Neighborhood Gig & Improvement Board

A mobile-first web app for a local community, built entirely on Cloudflare:

- **Post a gig** (a fixed-cash task) and, as the hirer, inspect and rate the worker who does it.
- **Claim a gig** posted by someone else and build a reviewed portfolio.
- **Post to the board** — observations and "wouldn't it look better if…" suggestions that aren't
  paid tasks but can graduate into one (**Turn into a gig**).

There is no privileged "crew leader" role: the person who posts and pays for a gig is the one who
rates it. Authority is per-gig ownership, not an account type.

## Trust model

The security boundary is the **API**, not the database. D1 is never exposed to the browser — only
the Pages Functions API touches it.

- The browser holds no privileged key — at most an **HttpOnly + Secure + SameSite** session cookie
  it can't read. The API also accepts the token as an `Authorization: Bearer` header.
- Every authorization check is code, run in shared middleware on each protected route
  (`functions/api/[[path]].ts`).
- The API shapes every response; it never returns `password_hash` or another user's email.
- Reputation columns (`total_gigs`, `rating_sum`, `rating_count`) are written only by the
  complete-gig handler, never by clients.
- **No secrets in the repo.** `SESSION_SECRET` is read from the environment only and lives in
  Cloudflare Pages settings (or `.dev.vars` locally, which is git-ignored).

## Stack

- **Frontend:** HTML5 + vanilla JS (ES modules) + Tailwind v3 Play CDN. No build step.
- **API:** Cloudflare Pages Functions (Workers runtime) with [Hono](https://hono.dev). D1 via `env.DB`.
- **DB:** Cloudflare D1 (SQLite).
- **Auth:** email/password handled in the API — PBKDF2-HMAC-SHA256 via Web Crypto, JWT sessions.

## Project layout

```
public/index.html          view containers, theme tokens, CDN imports
public/_headers            security headers for static assets (CSP, HSTS, …)
public/js/api.js           data layer — the only module aware of the API shape
public/js/auth.js          register/login/logout + current-user state
public/js/feed.js          geolocation, nearby gigs, claim, re-query on focus
public/js/post.js          create/edit a gig + inline inspect/rate panel
public/js/board.js         posts: list, create, comment, interest, "turn into a gig"
public/js/profile.js       portfolio + any user's public profile sheet
public/js/ui.js,main.js    shared DOM helpers + bootstrap/tab navigation
functions/api/[[path]].ts  the Hono API (auth, gigs, board, profiles); binds env.DB + env.SESSION_SECRET
schema.sql                 D1 schema
wrangler.toml              Pages + D1 config (NO secrets; pages_build_output_dir = public)
scripts/setup.mjs          one-command provision + deploy
test/api.test.ts           integration tests (Vitest + workers pool)
```

## Local development

```bash
npm install

# Create a throwaway secret for local dev (git-ignored):
cp .dev.vars.example .dev.vars      # then edit SESSION_SECRET to a long random string

# Initialize the local D1 database:
npm run db:init:local               # wrangler d1 execute podnet --local --file schema.sql

# Run the static site + Functions together (reads bindings from wrangler.toml):
npm run dev                         # wrangler pages dev
```

Other scripts: `npm test` (integration tests), `npm run typecheck`, `npm run lint`,
`npm run format`.

Then open the printed local URL. Register two accounts to exercise the full flow:
user A posts a gig → user B claims it → A completes and rates it → B's profile shows the review.

## Deploy in one command (all Cloudflare, $0 tier)

```bash
git clone <this-repo> && cd podet
npm run setup
```

`npm run setup` provisions and deploys everything, and is safe to re-run:

1. installs dependencies,
2. authenticates with Cloudflare,
3. creates the D1 database `podnet` and writes its id into `wrangler.toml`,
4. applies `schema.sql` and then every file in `migrations/` to the remote database
   (both are idempotent, so re-running is always safe),
5. creates the R2 bucket `podnet-photos` and the Pages project `podnet`,
6. generates `SESSION_SECRET` and the web-push (VAPID) keys and stores them as
   Pages secrets (only if not already set),
7. deploys the site and prints the live `*.pages.dev` URL.

After the first deploy, register your account in the app, then grant yourself
admin (the reports queue, business verification, and stats live behind it):

```bash
npx wrangler d1 execute podnet --remote --command "update users set is_admin=1 where email='you@example.com'"
```

### Authentication

Cloudflare's CLI does **not** use an email + password. Choose one:

- **API token (recommended, fully scriptable):**
  ```bash
  export CLOUDFLARE_API_TOKEN=...   # and CLOUDFLARE_ACCOUNT_ID if you have several accounts
  npm run setup
  ```
  Create the token at *My Profile → API Tokens → Create Token* with these **account** permissions:
  **D1:Edit**, **Cloudflare Pages:Edit**, **Workers Scripts:Edit**, **Account Settings:Read**.
- **Interactive:** just run `npm run setup` with no token — it falls back to `wrangler login`
  (opens your browser).

Re-running `npm run setup` redeploys using the same database and secret (it won't rotate
`SESSION_SECRET`, so existing sessions keep working).

## Manual deploy (if you prefer the individual steps)

```bash
wrangler d1 create podnet                         # copy database_id into wrangler.toml
npm run db:init                                    # apply schema.sql to the remote DB
wrangler r2 bucket create podnet-photos            # photos bucket (env.PHOTOS)
wrangler pages project create podnet --production-branch main
wrangler pages secret put SESSION_SECRET           # paste a long random string
# Web push (optional): generate a VAPID keypair and store both halves:
wrangler pages secret put VAPID_PUBLIC_KEY         # base64url raw P-256 public key
wrangler pages secret put VAPID_PRIVATE_KEY        # the matching private key as JWK JSON
npm run deploy                                      # wrangler pages deploy
```

`npm run setup` does all of the above automatically (including generating the VAPID keys).
The `DB` and `PHOTOS` bindings come from `wrangler.toml`, so there's no manual dashboard step.
If `VAPID_*` is unset, notifications are simply disabled (everything else still works).
The API lives at `/api/*` on the same origin, so cookies are first-party and there is no CORS.
D1 does not pause, so there is no keep-alive to run.

> If any secret ever leaks into git history, **rotate it** — history keeps the old value.

## Hardening notes

- Static assets live in `public/`; `pages_build_output_dir = "public"` keeps source/config
  files (`schema.sql`, `wrangler.toml`, …) from ever being served.
- Security headers: `public/_headers` (CSP, HSTS, X-Frame-Options, …) for static assets;
  Hono `secureHeaders()` for API responses.
- Auth endpoints are rate-limited (D1-backed fixed window); login runs constant-work PBKDF2
  even for unknown emails to avoid account enumeration.
- Tests (`npm test`) run the API against a real local D1/R2 in the Workers runtime; CI runs
  typecheck + lint + tests on every push.

## Capabilities

- **Work photos** — at review time the hirer attaches photos of the finished job (stored in
  R2). They appear on both the worker's portfolio and the hirer's profile.
- **Pagination** — the board and reviews use keyset paging with a "Load more" button.
- **Near-realtime feed** — Nearby auto-refreshes (~20s) while it's the active, visible tab,
  in addition to refreshing on focus. (A push-based Durable Object feed would need a separate
  Worker deploy, so this stays within the single Pages project.)
- **Web push notifications (all device platforms)** — opt-in from the Me tab. One server-side
  implementation (the standard Web Push protocol: VAPID/RFC 8292 + aes128gcm/RFC 8291) covers
  every platform through its own push service:
  - **Android** — Chrome/Edge/Firefox/Samsung Internet (delivered via FCM's web-push endpoints);
  - **iOS / iPadOS 16.4+** — Safari web push, after the user **adds PodNet to the Home Screen**
    (an Apple requirement for web apps);
  - **Desktop** — Chrome, Edge, Firefox, Safari on macOS/Windows/Linux.

  Events: gig claimed → poster; work rated → worker; claim released → poster; new comment →
  post author; your post turned into a gig → post author. Messages carry `Urgency` and a
  per-entity `Topic` collapse key (bursts replace queued duplicates instead of stacking).
  Sends are best-effort (a failed push never affects the gig flow); dead subscriptions are
  pruned on 404/410. Requires the `VAPID_*` secrets (created by `npm run setup`).
  The encryption is verified byte-for-byte against the **official RFC 8291 test vector** in CI,
  which is what guarantees interop with Apple/FCM/Mozilla push services.
- **Installable PWA** — manifest + icons; "Add to Home Screen" works on mobile. No third-party
  scripts or styles at all (strict CSP: `script-src 'self'; style-src 'self'`).
- **Board → gig linkage** — a post that has been turned into a gig shows "now a gig ✓".
- **Change password** — from the Me tab (requires the current password; rate-limited).
- **Scheduling** — a hirer can post the hours that work for them plus the notice they need;
  the worker claims by picking a slot inside that window, at least `notice` hours out. The
  slot shows on both sides and clears if the claim is released.
- **Gig messaging** — a private thread between the hirer and worker of a claimed gig
  (directions, gate codes, timing), with a push notification to the other party. Not open
  DMs by design — no spam surface.
- **Reports & support** — report any gig/post/comment (with a reason) or file a support
  ticket from the Me tab; you can see your ticket status there too.
- **Admin & moderation** — a `users.is_admin` flag adds an Admin panel to the Me tab:
  triage reports, remove content, resolve tickets, and verify businesses. Admin status
  confers no gig authority — rating stays per-gig ownership, per the original trust model.
  Grant the first admin (yourself) with:
  ```bash
  npx wrangler d1 execute podnet --remote --command "update users set is_admin=1 where email='you@example.com'"
  ```
- **Verified business ✔** — set a business name in the Me tab; that files a verification
  request; an admin approves it and a ✔ badge appears next to your name everywhere.
  Changing the name clears the badge until re-verified.

- **Session revocation** — changing your password (or closing your account) invalidates every
  existing session token everywhere via a per-user `session_epoch` in the JWT.
- **Gig lifecycle completeness** — the hirer can remove a no-show worker (reopens the gig); the
  worker can mark a job "done" (the hirer is notified to review & pay); both clear on release.
- **Scheduling, finished** — the gig window is editable, the claim form enforces it, and gigs
  whose window has passed drop out of Nearby (they're unclaimable).
- **Blocking** — block a user from any profile; their gigs/posts disappear from your feeds and
  neither of you can claim the other's gigs. Manage the list in the Me tab.
- **Account deletion** — close your account (password-confirmed); your profile is anonymized and
  you're logged out everywhere, while reviews/gigs stay on the ledger for integrity.
- **Money & ops** — the Me tab shows earned vs paid-out totals; admins get a stats card;
  `npm run db:backup` exports the remote D1 to a SQL file (D1 Time Travel also restores ~30 days).

### Deferred by design
- **Email password-reset / verification** — there is currently no free all-Cloudflare way to
  send email (MailChannels' free Workers route was discontinued). Adding it means a
  third-party provider behind a secret; until then, keep your password safe — there is no
  recovery path.
- **Push-based realtime (Durable Objects)** — would require deploying a second Worker
  alongside the Pages project, breaking the one-command single-deployment setup.

