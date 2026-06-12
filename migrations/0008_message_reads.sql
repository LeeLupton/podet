-- Migration 0008 — per-user, per-thread read markers for the unread badge.
-- Idempotent: re-running errors on "table already exists", which setup.mjs
-- treats as already-applied.

create table if not exists message_reads (
  user_id      text not null references users(id) on delete cascade,
  scope        text not null check (scope in ('dm','gig','review')),
  scope_id     text not null,
  last_read_at text not null default (datetime('now')),
  primary key (user_id, scope, scope_id)
);
