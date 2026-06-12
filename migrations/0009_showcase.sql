-- Migration 0009 — the weekly Showcase: entries (completed gigs with photos),
-- one-vote-per-user-per-week, and lazily finalized weekly winners.
-- Idempotent: re-running errors on "table already exists", which setup.mjs
-- treats as already-applied.

create table if not exists showcase_entries (
  id           text primary key,
  gig_id       text not null unique references gigs(id) on delete cascade,
  week         text not null,
  submitted_by text not null references users(id),
  created_at   text not null default (datetime('now'))
);

create index if not exists idx_showcase_week on showcase_entries(week);

create table if not exists showcase_votes (
  week       text not null,
  voter_id   text not null references users(id) on delete cascade,
  entry_id   text not null references showcase_entries(id) on delete cascade,
  created_at text not null default (datetime('now')),
  primary key (week, voter_id)
);

create table if not exists showcase_winners (
  week         text primary key,
  entry_id     text not null references showcase_entries(id),
  votes        integer not null,
  finalized_at text not null default (datetime('now'))
);
