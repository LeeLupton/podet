-- Migration 0005 — properties a user manages, powering the derived "neighbor"
-- tag on gigs and profiles. Coordinates are private (server-side only).
-- Idempotent: re-running errors on "table already exists", which setup.mjs
-- treats as already-applied.

create table if not exists properties (
  id         text primary key,
  owner_id   text not null references users(id) on delete cascade,
  label      text not null,
  lat        real not null,
  lng        real not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_properties_owner on properties(owner_id);
