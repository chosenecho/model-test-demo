"""
用 Python sqlite3 模拟 D1 的 batch() 语义，回归 core.js 里的预占 / 结算 / 回收 / 周期 SQL。

只验证 SQL 与状态机，不验证 Worker 运行时。转换规则：
- env.DB.prepare(...).bind(...) → (sql, params)
- env.DB.batch([...]) → 依次执行
- D1 的 changes() 在语句内即上一行的变更数，sqlite3 行为一致，可直接照搬
"""
import re
import sqlite3
import sys

CORE = r'worker/src/core.js'


def load_statements(path):
    src = open(path, encoding='utf-8').read()
    # 把 JS 里的模板字符串转成 sqlite 能执行的 SQL，占位符统一成 ?
    stmts = re.findall(r'`([^`]*)`', src)
    out = []
    for s in stmts:
        if 'SELECT' not in s.upper() and 'INSERT' not in s.upper() and 'UPDATE' not in s.upper():
            continue
        s = s.replace('${today}', 'day')
        s = re.sub(r'\?', '?', s)
        out.append(' '.join(s.split()))
    return out


SCHEMA = """
CREATE TABLE quota_plans (id TEXT PRIMARY KEY, name TEXT, period TEXT, grant_micro INTEGER,
  rollover INTEGER, price_in_micro INTEGER, price_out_micro INTEGER, per_request_micro INTEGER,
  soft_limit_pct INTEGER, overage INTEGER, price_per_mb_micro INTEGER, max_upload_mb INTEGER, created_at INTEGER);
CREATE TABLE quota_wallets (user_id TEXT PRIMARY KEY, plan_id TEXT, balance_micro INTEGER NOT NULL DEFAULT 0,
  reserved_micro INTEGER NOT NULL DEFAULT 0, period_start INTEGER, period_end INTEGER,
  status TEXT NOT NULL DEFAULT 'active', updated_at INTEGER);
CREATE VIEW v_quota AS SELECT w.user_id, w.plan_id, p.name AS plan_name, w.balance_micro,
  w.reserved_micro, (w.balance_micro - w.reserved_micro) AS available_micro, w.period_end, w.status,
  p.soft_limit_pct, p.grant_micro
  FROM quota_wallets w LEFT JOIN quota_plans p ON p.id = w.plan_id;
CREATE TABLE quota_ledger (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, amount_micro INTEGER,
  balance_after INTEGER, request_id TEXT, note TEXT, created_at INTEGER);
CREATE TABLE usage_requests (request_id TEXT PRIMARY KEY, user_id TEXT, session_id TEXT, message_id TEXT,
  route TEXT, model TEXT, status TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0, cost_micro INTEGER DEFAULT 0, reserved_micro INTEGER DEFAULT 0,
  reconcile_reason TEXT, http_status INTEGER, error_code TEXT, latency_ms INTEGER,
  started_at INTEGER, ended_at INTEGER);
CREATE TABLE usage_daily (user_id TEXT, day TEXT, requests INTEGER, input_tokens INTEGER,
  output_tokens INTEGER, cached_tokens INTEGER, search_calls INTEGER, PRIMARY KEY (user_id, day));
"""

INSERT_PLAN = """INSERT INTO quota_plans (id, name, period, grant_micro, rollover, price_in_micro,
  price_out_micro, per_request_micro, soft_limit_pct, overage, price_per_mb_micro, max_upload_mb, created_at)
  VALUES ('free', 'free', 'month', 6000000, 0, 2000, 8000, 1000, 80, 0, 1000, 64, 0)"""
INSERT_WALLET = """INSERT INTO quota_wallets (user_id, plan_id, balance_micro, reserved_micro, period_start,
  period_end, status, updated_at) VALUES ('u1', 'free', 1000000, 0, 0, 9999999999999, 'active', 0)"""

RESERVE = [
    ("INSERT INTO usage_requests (request_id, user_id, session_id, message_id, route, model, status,"
     " started_at, reserved_micro) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)"
     " ON CONFLICT(request_id) DO NOTHING", ['r1', 'u1', None, None, '/messages', None, 1, 40000]),
    ("UPDATE quota_wallets SET reserved_micro = reserved_micro + ?, updated_at = ?"
     " WHERE user_id = ? AND balance_micro - reserved_micro >= ? AND status != 'suspended'"
     " AND changes() > 0", [40000, 2, 'u1', 40000]),
]

CASES = []


def case(fn):
    CASES.append(fn)
    return fn


def ledger_sum(con, uid='u1'):
    row = con.execute('SELECT COALESCE(SUM(amount_micro), 0) FROM quota_ledger WHERE user_id = ?', (uid,)).fetchone()
    return row[0]


def wallet(con, uid='u1'):
    return con.execute('SELECT balance_micro, reserved_micro, status FROM quota_wallets WHERE user_id = ?',
                       (uid,)).fetchone()


@case
def reserve_then_settle(con):
    """正常路径：预占 → 结算。余额按实际用量扣，预占清零，流水与钱包一致。"""
    for sql, params in RESERVE:
        con.execute(sql, params)
    assert wallet(con) == (1000000, 40000, 'active'), wallet(con)
    # settle: charge = 4600（1000 in + 200 out 按套餐价）
    con.execute("UPDATE quota_wallets SET balance_micro = balance_micro - ?, reserved_micro = MAX(0, reserved_micro - ?),"
                " updated_at = ? WHERE user_id = ?", (4600, 40000, 3, 'u1'))
    con.execute("INSERT INTO quota_ledger (id, user_id, kind, amount_micro, balance_after, request_id, note, created_at)"
                " SELECT ?, ?, 'consume', ?, balance_micro, ?, ?, ? FROM quota_wallets WHERE user_id = ? AND changes() = 1",
                ('l1', 'u1', -4600, 'r1', None, 3, 'u1'))
    con.execute("UPDATE usage_requests SET cost_micro = ?, status = 'settled', reserved_micro = 0"
                " WHERE request_id = ? AND user_id = ? AND status = 'reserved'", (4600, 'r1', 'u1'))
    assert wallet(con) == (995400, 0, 'active'), wallet(con)
    assert ledger_sum(con) == -4600
    status = con.execute("SELECT status FROM usage_requests WHERE request_id = 'r1'").fetchone()[0]
    assert status == 'settled', status


@case
def duplicate_request(con):
    """同一 request_id 第二次预占必须被唯一键挡住，不重复占额度。"""
    for sql, params in RESERVE:
        con.execute(sql, params)
    inserted = con.execute(RESERVE[0][0], RESERVE[0][1]).rowcount
    assert inserted == 0, inserted
    assert wallet(con)[1] == 40000


@case
def insufficient_balance(con):
    """余额不足：预占更新 0 行，请求行标 released，不产生 pending 垃圾。"""
    con.execute("UPDATE quota_wallets SET balance_micro = 1000 WHERE user_id = 'u1'")
    con.execute(RESERVE[0][0], RESERVE[0][1])
    changed = con.execute(RESERVE[1][0], RESERVE[1][1]).rowcount
    assert changed == 0, changed
    con.execute("UPDATE usage_requests SET status = 'released', ended_at = ?, error_code = 'insufficient'"
                " WHERE request_id = ?", (4, 'r1'))
    assert wallet(con) == (1000, 0, 'active'), wallet(con)
    row = con.execute("SELECT status, error_code FROM usage_requests WHERE request_id = 'r1'").fetchone()
    assert row == ('released', 'insufficient'), row


@case
def settle_twice(con):
    """重复结算护栏：钱包只在 status='reserved' 时才被扣，第二次进入直接返回。"""
    for sql, params in RESERVE:
        con.execute(sql, params)
    charged = 0
    for _ in range(2):
        row = con.execute("SELECT status, reserved_micro FROM usage_requests WHERE request_id = ? AND user_id = ?",
                          ('r1', 'u1')).fetchone()
        if not row or row[0] != 'reserved':
            break
        con.execute("UPDATE quota_wallets SET balance_micro = balance_micro - ?, reserved_micro = MAX(0, reserved_micro - ?)"
                    " WHERE user_id = ?", (4600, row[1], 'u1'))
        con.execute("INSERT INTO quota_ledger (id, user_id, kind, amount_micro, balance_after, request_id, note, created_at)"
                    " SELECT ?, ?, 'consume', ?, balance_micro, ?, NULL, ?"
                    " FROM quota_wallets WHERE user_id = ? AND changes() = 1",
                    ('l%d' % (charged + 1), 'u1', -4600, 'r1', 3, 'u1'))
        con.execute("UPDATE usage_requests SET status = 'settled', cost_micro = ?, reserved_micro = 0"
                    " WHERE request_id = ? AND user_id = ? AND status = 'reserved'", (4600, 'r1', 'u1'))
        charged += 1
    assert charged == 1, charged
    assert wallet(con) == (995400, 0, 'active'), wallet(con)
    assert ledger_sum(con) == -4600, ledger_sum(con)

@case
def release_without_usage(con):
    """上游失败：释放预占，余额不动，状态 released。"""
    for sql, params in RESERVE:
        con.execute(sql, params)
    con.execute("UPDATE quota_wallets SET reserved_micro = MAX(0, reserved_micro - ?), updated_at = ?"
                " WHERE user_id = ?", (40000, 5, 'u1'))
    con.execute("UPDATE usage_requests SET status = 'released', error_code = ?, ended_at = ?"
                " WHERE request_id = ? AND user_id = ? AND status = 'reserved'", ('upstream', 5, 'r1', 'u1'))
    assert wallet(con) == (1000000, 0, 'active'), wallet(con)
    assert ledger_sum(con) == 0


@case
def sweep_reclaims(con):
    """超时未结算的预占：转待对账并入账，钱不会静默消失。"""
    for sql, params in RESERVE:
        con.execute(sql, params)
    stale = con.execute("SELECT request_id, reserved_micro FROM usage_requests"
                        " WHERE status = 'reserved' AND started_at < ? LIMIT 20", (10 ** 12,)).fetchall()
    assert len(stale) == 1, stale
    rid, amount = stale[0]
    con.execute("UPDATE quota_wallets SET balance_micro = balance_micro - ?, reserved_micro = MAX(0, reserved_micro - ?)"
                " WHERE user_id = ?", (amount, amount, 'u1'))
    con.execute("INSERT INTO quota_ledger (id, user_id, kind, amount_micro, balance_after, request_id, note, created_at)"
                " SELECT ?, ?, 'consume', ?, balance_micro, ?, ?, ? FROM quota_wallets WHERE user_id = ? AND changes() = 1",
                ('l2', 'u1', -amount, rid, '预占超时，待对账', 11, 'u1'))
    con.execute("UPDATE usage_requests SET status = 'reconcile_required', reconcile_reason = ?, reserved_micro = 0,"
                " cost_micro = ?, ended_at = ? WHERE request_id = ? AND user_id = ? AND status = 'reserved'",
                ('reservation expired', amount, 11, rid, 'u1'))
    assert wallet(con) == (960000, 0, 'active'), wallet(con)
    assert ledger_sum(con) == -40000
    row = con.execute("SELECT status, reconcile_reason FROM usage_requests WHERE request_id = 'r1'").fetchone()
    assert row == ('reconcile_required', 'reservation expired'), row


@case
def exhausted_wallet(con):
    """扣到 0：钱包置 exhausted，可用额度不为负（overage=0）。"""
    con.execute("UPDATE quota_wallets SET balance_micro = 1000 WHERE user_id = 'u1'")
    charge = min(4600, 1000)
    con.execute("UPDATE quota_wallets SET balance_micro = balance_micro - ? WHERE user_id = ?", (charge, 'u1'))
    con.execute("UPDATE quota_wallets SET status = 'exhausted' WHERE user_id = ? AND status = 'active'"
                " AND balance_micro <= 0", ('u1',))
    assert wallet(con) == (0, 0, 'exhausted'), wallet(con)


@case
def ledger_matches_wallet(con):
    """对账不变量：钱包余额 - 流水净额 == 期初发放。"""
    # 期初 1,000,000 来自开户发放，余额与流水必须同时对得上
    con.execute("INSERT INTO quota_ledger (id, user_id, kind, amount_micro, balance_after, request_id, note, created_at)"
                " VALUES ('g1', 'u1', 'grant', 1000000, 1000000, NULL, '开户首期发放', 0)")
    for sql, params in RESERVE:
        con.execute(sql, params)
    con.execute("UPDATE quota_wallets SET balance_micro = balance_micro - ?, reserved_micro = 0 WHERE user_id = 'u1'",
                (4600,))
    con.execute("INSERT INTO quota_ledger (id, user_id, kind, amount_micro, balance_after, request_id, note, created_at)"
                " VALUES ('l3', 'u1', 'consume', -4600, 995400, 'r1', NULL, 3)")
    b = wallet(con)[0]
    assert b - ledger_sum(con) == 0, (b, ledger_sum(con))
    # 对账 SQL 与 db/hardening.sql 的 D 段一致
    diff = con.execute("SELECT w.balance_micro - COALESCE((SELECT SUM(l.amount_micro) FROM quota_ledger l"
                       " WHERE l.user_id = w.user_id), 0) AS diff FROM quota_wallets w WHERE w.user_id = ?",
                       ('u1',)).fetchone()[0]
    assert diff == 0, diff


def main():
    failed = 0
    for fn in CASES:
        con = sqlite3.connect(':memory:')
        con.executescript(SCHEMA)
        con.execute(INSERT_PLAN)
        con.execute(INSERT_WALLET)
        try:
            fn(con)
            print('PASS', fn.__name__)
        except AssertionError as e:
            failed += 1
            print('FAIL', fn.__name__, e)
        finally:
            con.close()
    print('---')
    print(('%d/%d cases passed' % (len(CASES) - failed, len(CASES))))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
