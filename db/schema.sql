-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT UNIQUE NOT NULL,          -- 随机生成的用户标识（Token 中携带）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 邀请码表（管理员手动插入）
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  used_by TEXT,                           -- 使用者的 token_id，NULL 表示未用
  used_at TEXT
);

-- 每日配额（user × 日期 计数）
CREATE TABLE IF NOT EXISTS quota (
  token_id TEXT NOT NULL,
  day TEXT NOT NULL,                      -- 'YYYY-MM-DD'
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, day)
);

-- Skill：预设系统提示词 + 工具白名单
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]'       -- JSON 数组，如 ["web_search"]
);

INSERT OR IGNORE INTO skills (id, name, description, system_prompt, tools) VALUES
  (1, '通用对话', '默认模式，直接对话', '你是一个乐于助人的中文助手。', '[]'),
  (2, '行业分析师', '先列分析框架，再逐点论证，最后给结论', '你是一位严谨的行业分析师。回答时：先给出分析框架，再逐点论证，每个关键论断标注信息来源类型，最后给出明确结论与不确定性说明。', '[]'),
  (3, '深度调研', '联网搜集资料后输出带引用的调研纪要', '你是一位研究助理。先规划检索步骤，再逐步搜集信息，输出结构化调研纪要，所有事实性内容附来源。', '["web_search"]');
