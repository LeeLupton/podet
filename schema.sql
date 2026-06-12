-- PodNet schema — Cloudflare D1 (SQLite)
-- Applied with: wrangler d1 execute podnet --file schema.sql
--
-- No RLS, no stored procedures. IDs are generated in the API with crypto.randomUUID().
-- Timestamps are ISO text via datetime('now'). The browser never sees D1 — only the API does.

-- USERS (auth + public reputation in one table; the API decides which columns it returns)
create table if not exists users (
  id            text primary key,
  email         text unique not null,
  password_hash text not null,                 -- PBKDF2-HMAC-SHA256, salt+iterations encoded (see API)
  display_name  text,
  total_gigs    integer not null default 0,
  rating_sum    integer not null default 0,    -- average is derived, never stored
  rating_count  integer not null default 0,
  is_admin      integer not null default 0,    -- moderation role (set by the operator via SQL)
  business_name text,                          -- self-asserted (badge only when verified)
  verified      integer not null default 0,    -- admin-approved business badge
  session_epoch integer not null default 0,      -- bump to invalidate all existing sessions
  deleted       integer not null default 0,      -- anonymized/closed account
  created_at    text not null default (datetime('now'))
);

create table if not exists posts (
  id         text primary key,
  author_id  text not null references users(id),
  body       text not null,
  area_label text,        -- "Arendell St — Beaufort bridge to Kmart"
  lat        real,        -- optional center for a map pin
  lng        real,
  created_at text not null default (datetime('now'))
);

create table if not exists gigs (
  id           text primary key,
  status       text not null default 'AVAILABLE'
               check (status in ('AVAILABLE','CLAIMED','COMPLETED')),
  task_type    text not null,
  neighborhood text not null,
  cash_payout  integer not null,
  est_hours    real not null,
  lat          real not null,
  lng          real not null,
  description  text not null,
  posted_by    text not null references users(id),    -- the hirer
  claimed_by   text references users(id),             -- the worker
  from_post_id text references posts(id),
  window_start text,                                  -- optional: hours that work for the hirer
  window_end   text,
  notice_hours integer not null default 0,            -- minimum lead time before the slot
  scheduled_at text,                                  -- slot the worker picked when claiming
  done_at      text,                                  -- worker marked the work finished
  created_at   text not null default (datetime('now'))
);

-- REVIEWS — two-sided and restorative. Both gig parties may review each other
-- (worker_id/hirer_id are always the two parties; author_id/subject_id say who
-- rated whom). 4-5 stars publish immediately; a 1-2 star review is HELD as
-- RESOLVING — a private improvement conversation opens and the score stays
-- unpublished until the author revises it up, withdraws it, or the 7-day
-- deadline passes (auto-publish, so a held review can never be a silent veto).
-- Reputation accrues only when a review reaches PUBLISHED.
create table if not exists reviews (
  id         text primary key,
  gig_id     text not null references gigs(id),
  worker_id  text not null references users(id),    -- the gig's worker
  hirer_id   text not null references users(id),     -- the gig's hirer
  author_id  text references users(id),              -- who wrote the review
  subject_id text references users(id),              -- who it is about
  stars      integer not null check (stars between 1 and 5),
  body       text,
  status     text not null default 'PUBLISHED' check (status in ('PUBLISHED','RESOLVING')),
  resolve_deadline text,                             -- when a held review auto-publishes
  responded  integer not null default 0,             -- subject engaged in resolution?
  created_at text not null default (datetime('now'))
);

create table if not exists post_comments (
  id         text primary key,
  post_id    text not null references posts(id) on delete cascade,
  author_id  text not null references users(id),
  body       text not null,
  created_at text not null default (datetime('now'))
);

create table if not exists post_interest (
  post_id text references posts(id) on delete cascade,
  user_id text references users(id),
  primary key (post_id, user_id)
);

-- GIG PHOTOS — images of completed work, attached to a gig by the hirer at
-- review time. Shown on BOTH the worker's portfolio and the hirer's profile.
-- The bytes live in R2 (env.PHOTOS); only the key is stored here.
create table if not exists gig_photos (
  id          text primary key,
  gig_id      text not null references gigs(id) on delete cascade,
  uploader_id text not null references users(id),
  r2_key      text not null,
  created_at  text not null default (datetime('now'))
);

-- WEB PUSH — a user's browser push subscriptions (endpoint + keys). The server
-- sends best-effort notifications (gig claimed → poster; gig completed → worker).
create table if not exists push_subscriptions (
  endpoint   text primary key,
  user_id    text not null references users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_push_user on push_subscriptions(user_id);

-- RATE LIMITING — fixed-window counters for auth endpoints (D1-backed so it works
-- everywhere on the free tier, no extra binding). key = '<route>:<ip>'.
create table if not exists rate_limits (
  key          text primary key,
  count        integer not null,
  window_start integer not null            -- unix seconds of the current window
);

create index if not exists idx_gigs_status   on gigs(status);
create index if not exists idx_gigs_bbox     on gigs(lat, lng);
create index if not exists idx_reviews_wkr   on reviews(worker_id);
create index if not exists idx_reviews_subject   on reviews(subject_id, status);
create index if not exists idx_reviews_resolving on reviews(status, resolve_deadline);
create index if not exists idx_posts_time    on posts(created_at);
create index if not exists idx_comments_post on post_comments(post_id);

-- GIG MESSAGES — private thread between the hirer and the worker of one gig.
create table if not exists gig_messages (
  id         text primary key,
  gig_id     text not null references gigs(id) on delete cascade,
  sender_id  text not null references users(id),
  body       text not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_gig_messages_gig on gig_messages(gig_id);

-- REVIEW MESSAGES — the private resolution thread for a held (RESOLVING) review,
-- between its author and subject. Separate from gig_messages so the improvement
-- conversation is tied to the review itself, not buried in gig coordination.
create table if not exists review_messages (
  id         text primary key,
  review_id  text not null references reviews(id) on delete cascade,
  sender_id  text not null references users(id),
  body       text not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_review_messages_review on review_messages(review_id);

-- REPORTS — content/user reports, verification requests, and support tickets.
create table if not exists reports (
  id          text primary key,
  reporter_id text not null references users(id),
  kind        text not null check (kind in ('post','comment','gig','user','support')),
  subject_id  text,                              -- id of the reported thing (null for support)
  reason      text not null,
  status      text not null default 'OPEN' check (status in ('OPEN','RESOLVED')),
  created_at  text not null default (datetime('now'))
);

create index if not exists idx_reports_status on reports(status);

-- BLOCKS — one-directional mute/exclude between users.
create table if not exists blocks (
  blocker_id text not null references users(id) on delete cascade,
  blocked_id text not null references users(id) on delete cascade,
  created_at text not null default (datetime('now')),
  primary key (blocker_id, blocked_id)
);

create index if not exists idx_blocks_blocker on blocks(blocker_id);
