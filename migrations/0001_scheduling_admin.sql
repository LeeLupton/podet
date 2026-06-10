-- Upgrade existing databases created before scheduling/admin/messaging landed.
-- New tables/indexes live in schema.sql (create if not exists — safe to re-run);
-- this file holds only the ALTERs, which SQLite can't make idempotent. setup.mjs
-- applies it and treats "duplicate column name" as already-migrated.
alter table users add column is_admin integer not null default 0;
alter table users add column business_name text;
alter table users add column verified integer not null default 0;
alter table gigs add column window_start text;
alter table gigs add column window_end text;
alter table gigs add column notice_hours integer not null default 0;
alter table gigs add column scheduled_at text;
