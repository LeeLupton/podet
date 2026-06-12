-- Migration 0006 — spatial (bounding-box) index for the neighbor-count query,
-- which joins properties against each other by lat/lng. Idempotent.

create index if not exists idx_properties_bbox on properties(lat, lng);
