-- Migration 0004 — dedicated resolution thread for held reviews.
-- The private back-and-forth that resolves a 1-2 star review lives with the
-- review itself, not in the gig's coordination thread. Idempotent: re-running
-- errors on "table already exists", which setup.mjs treats as already-applied.

create table if not exists review_messages (
  id         text primary key,
  review_id  text not null references reviews(id) on delete cascade,
  sender_id  text not null references users(id),
  body       text not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_review_messages_review on review_messages(review_id);
