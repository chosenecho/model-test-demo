-- 把搜索计数从「全站共享」改为「按用户每日 200 次」。
-- 已建表的库执行一次；全新库直接跑 db/firecrawl.sql 即可，不需要本文件。
--
-- 迁移前已存在的行 user_id 为空字符串，不再计入任何用户的当日额度。
-- 影响仅限当日计数，历史用量在 usage_requests / quota_ledger 里。
ALTER TABLE firecrawl_search_attempts ADD COLUMN user_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_firecrawl_attempts_user_day
  ON firecrawl_search_attempts(user_id, hk_day);
