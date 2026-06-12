-- Migration 0007 — landscaper-to-landscaper networking: mutual-consent
-- connections (discovered via the neighbor list) and direct messages between
-- connected users. Idempotent: re-running errors on "table already exists",
-- which setup.mjs treats as already-applied.

create table if not exists connections (
  requester_id text not null references users(id) on delete cascade,
  addressee_id text not null references users(id) on delete cascade,
  status       text not null default 'PENDING' check (status in ('PENDING','ACCEPTED')),
  created_at   text not null default (datetime('now')),
  primary key (requester_id, addressee_id)
);

create index if not exists idx_connections_addressee on connections(addressee_id, status);
create index if not exists idx_connections_requester on connections(requester_id, status);

create table if not exists direct_messages (
  id         text primary key,
  user_lo    text not null references users(id),
  user_hi    text not null references users(id),
  sender_id  text not null references users(id),
  body       text not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_dm_pair on direct_messages(user_lo, user_hi, created_at);
