-- Upgrade existing databases: session revocation, worker "mark done", account close.
-- (blocks table is in schema.sql via create-if-not-exists). setup.mjs treats
-- "duplicate column name" as already-applied.
alter table users add column session_epoch integer not null default 0;
alter table users add column deleted integer not null default 0;
alter table gigs add column done_at text;
