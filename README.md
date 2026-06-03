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
4. applies `schema.sql` to the remote database,
5. creates the Pages project `podnet`,
6. generates `SESSION_SECRET` and stores it as a Pages secret (only if not already set),
7. deploys the site and prints the live `*.pages.dev` URL.

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
- **Web push notifications** — opt-in from the Me tab; the hirer is notified when their gig is
  claimed and the worker when their work is rated. Sends are best-effort (a failed push never
  affects the gig flow). Requires the `VAPID_*` secrets (created by `npm run setup`).
  Note: end-to-end delivery to a device wasn't verified in CI — the crypto/builders are unit-tested.
- The Tailwind v3 Play CDN compiles in-browser and so requires `'unsafe-eval'`/`'unsafe-inline'`
  in the CSP. Precompiling Tailwind to a static stylesheet (a small build step) would let you
  drop both — a worthwhile follow-up for stricter CSP.

