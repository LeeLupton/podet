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
  created_at   text not null default (datetime('now'))
);

create table if not exists reviews (
  id         text primary key,
  gig_id     text not null references gigs(id),
  worker_id  text not null references users(id),
  hirer_id   text not null references users(id),
  stars      integer not null check (stars between 1 and 5),
  body       text,
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
create index if not exists idx_posts_time    on posts(created_at);
create index if not exists idx_comments_post on post_comments(post_id);
