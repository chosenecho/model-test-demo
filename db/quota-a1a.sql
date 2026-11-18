-- A1a：上传计费与大小上限（一次性增量迁移）
-- 执行：npx wrangler d1 execute model-test-demo-db --remote --file ../db/quota-a1a.sql
-- 前置：npx wrangler d1 export model-test-demo-db --remote --output ../db/backup-a1a.sql
-- 说明：ALTER ADD COLUMN 不能重复执行；本文件只跑一次。

-- 每 MB 上传的单价（micro）。设 0 即关闭上传计费。
ALTER TABLE quota_plans ADD COLUMN price_per_mb_micro INTEGER NOT NULL DEFAULT 1000;

-- 单文件大小上限（MB），Worker 端据此在转发前拦 413
ALTER TABLE quota_plans ADD COLUMN max_upload_mb INTEGER NOT NULL DEFAULT 64;

-- free / vip 都按 1 MB = 1000 micro（0.001 额度）；internal 不计费
UPDATE quota_plans SET price_per_mb_micro = 0 WHERE id = 'internal';
UPDATE quota_plans SET max_upload_mb = 128 WHERE id = 'vip';
