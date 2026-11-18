-- One row per reserved or dispatched search, scoped to the requesting user.
-- The Worker inserts conditionally in one write and deletes only its own unsent reservation.
-- 每日上限按用户计算：同一 user_id + hk_day 只放行前 N 次。
CREATE TABLE IF NOT EXISTS firecrawl_search_attempts (
  user_id TEXT NOT NULL DEFAULT '',
  hk_day TEXT NOT NULL CHECK (hk_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  attempt_id TEXT NOT NULL,
  PRIMARY KEY (hk_day, attempt_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_firecrawl_attempts_user_day
  ON firecrawl_search_attempts(user_id, hk_day);
