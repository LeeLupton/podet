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
index.html                 view containers, theme tokens, CDN imports
functions/api/[[path]].ts  the Hono API (auth, gigs, board, profiles); binds env.DB + env.SESSION_SECRET
js/api.js                  data layer — the only module aware of the API shape
js/auth.js                 register/login/logout + current-user state
js/feed.js                 geolocation, nearby gigs, claim, re-query on focus
js/post.js                 create a gig + inline inspect/rate panel
js/board.js                posts: list, create, comment, interest, "turn into a gig"
js/profile.js              portfolio: gig count, average, reviews
js/ui.js / js/main.js      shared DOM helpers + bootstrap/tab navigation
schema.sql                 D1 schema
wrangler.toml              Pages + D1 config (NO secrets)
```

## Local development

```bash
npm install

# Create a throwaway secret for local dev (git-ignored):
cp .dev.vars.example .dev.vars      # then edit SESSION_SECRET to a long random string

# Initialize the local D1 database:
npm run db:init:local               # wrangler d1 execute podnet --local --file schema.sql

# Run the static site + Functions together:
npm run dev                         # wrangler pages dev . --d1 DB=podnet
```

Then open the printed local URL. Register two accounts to exercise the full flow:
user A posts a gig → user B claims it → A completes and rates it → B's profile shows the review.

## Deploy (all Cloudflare, $0 tier)

```bash
# 1. Create the D1 database and copy its id into wrangler.toml
wrangler d1 create podnet

# 2. Apply the schema to the remote database
npm run db:init                     # wrangler d1 execute podnet --file schema.sql

# 3. Set the server secret (never in code/repo/wrangler.toml)
wrangler pages secret put SESSION_SECRET

# 4. Deploy the Pages project (static files + functions/)
npm run deploy                      # wrangler pages deploy .
```

Bind the D1 database to the Pages project as `DB` in the dashboard (or via `wrangler.toml`).
The API lives at `/api/*` on the same origin, so cookies are first-party and there is no CORS.
D1 does not pause, so there is no keep-alive to run.

> If any secret ever leaks into git history, **rotate it** — history keeps the old value.
