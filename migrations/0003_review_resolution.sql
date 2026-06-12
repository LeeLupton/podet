-- Migration 0003 — two-sided, restorative reviews.
-- Adds review direction (author/subject), a held RESOLVING state for low scores,
-- an auto-publish deadline, and a "subject engaged" flag. Idempotent: re-running
-- errors on "duplicate column", which setup.mjs treats as already-applied.

alter table reviews add column author_id text;
alter table reviews add column subject_id text;
alter table reviews add column status text not null default 'PUBLISHED'
  check (status in ('PUBLISHED','RESOLVING'));
alter table reviews add column resolve_deadline text;
alter table reviews add column responded integer not null default 0;

-- Existing rows are all hirer -> worker reviews; map them into the new columns.
update reviews set author_id = hirer_id where author_id is null;
update reviews set subject_id = worker_id where subject_id is null;

create index if not exists idx_reviews_subject   on reviews(subject_id, status);
create index if not exists idx_reviews_resolving on reviews(status, resolve_deadline);
