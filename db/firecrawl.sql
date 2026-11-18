-- One row per reserved or dispatched search, shared across all users.
-- The Worker inserts conditionally in one write and deletes only its own unsent reservation.
CREATE TABLE IF NOT EXISTS firecrawl_search_attempts (
  hk_day TEXT NOT NULL CHECK (hk_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  attempt_id TEXT NOT NULL,
  PRIMARY KEY (hk_day, attempt_id)
) WITHOUT ROWID;
