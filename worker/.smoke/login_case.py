"""校验 invite/login 兑换与续期在 D1 语义下的行为（只验 SQL 与状态机，不验 Worker 运行时）。

对应 worker/src/index.js login() 的 batch：
  1) UPDATE invite_codes ... WHERE code_hash = ? AND used_by IS NULL AND (expires_at IS NULL OR expires_at > ?)
  2) INSERT INTO users ... SELECT ? WHERE changes() > 0
"""
import sqlite3
import sys

NOW = 1_700_000_000_000

SCHEMA = """
CREATE TABLE users (token_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active',
                    created_at INTEGER, last_seen_at INTEGER);
CREATE TABLE invite_codes (code_hash TEXT PRIMARY KEY, used_by TEXT, used_at INTEGER,
                           expires_at INTEGER, created_at INTEGER);
CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT, secret_hash TEXT,
                            created_at INTEGER, expires_at INTEGER, last_used_at INTEGER,
                            revoked_at INTEGER, user_agent TEXT);
"""

REDEEM = """
UPDATE invite_codes SET used_by = ?, used_at = ?
 WHERE code_hash = ? AND used_by IS NULL
   AND (expires_at IS NULL OR expires_at > ?)
"""
CREATE_USER = "INSERT INTO users (token_id, created_at, last_seen_at) SELECT ?, ?, ? WHERE changes() > 0"


def fresh():
    con = sqlite3.connect(':memory:')
    con.executescript(SCHEMA)
    con.execute("INSERT INTO invite_codes VALUES ('h1', NULL, NULL, NULL, 0)")          # 有效未用
    con.execute("INSERT INTO invite_codes VALUES ('h2', 'u-old', 1, NULL, 0)")          # 已用
    con.execute("INSERT INTO invite_codes VALUES ('h3', NULL, NULL, %d, 0)" % (NOW - 1))  # 已过期
    con.commit()
    return con


def redeem(con, code_hash, user='u-new'):
    """D1 batch：两条语句在同一批次里按顺序执行，changes() 取上一条的变更行数。"""
    cur = con.cursor()
    cur.execute(REDEEM, (user, NOW, code_hash, NOW))
    changed = cur.rowcount
    cur.execute(CREATE_USER, (user, NOW, NOW))
    created = cur.rowcount
    con.commit()
    return changed, created


def renewed(con, code_hash):
    """续期路径：码已用 → 取 used_by，命中就为原账号签发新会话。"""
    row = con.execute("SELECT used_by FROM invite_codes WHERE code_hash = ?", (code_hash,)).fetchone()
    return row[0] if row and row[0] else None


_seq = [0]


def issue(con, user_id):
    _seq[0] += 1
    con.execute("INSERT INTO auth_sessions VALUES (?,?,?,?,?,?,?,?)",
                ('s%d' % _seq[0], user_id, 'sh', NOW, NOW + 1000, NOW, None, 'ua'))
    con.commit()


def session_alive(con, user_id):
    row = con.execute(
        "SELECT revoked_at FROM auth_sessions WHERE user_id = ?", (user_id,)).fetchone()
    return bool(row) and row[0] is None


cases = []


def case(name):
    def deco(fn):
        cases.append((name, fn))
        return fn
    return deco


@case('redeem_fresh_code')
def _(con):
    changed, created = redeem(con, 'h1')
    assert changed == 1 and created == 1, (changed, created)
    owner = renewed(con, 'h1')
    assert owner == 'u-new', owner
    return 'created u-new'


@case('redeem_same_code_twice_second_is_renewal')
def _(con):
    redeem(con, 'h1', 'u-a')
    changed, created = redeem(con, 'h1', 'u-b')
    assert changed == 0 and created == 0, (changed, created)
    owner = renewed(con, 'h1')
    assert owner == 'u-a', owner
    return 'renewal -> u-a'


@case('redeem_expired_code_rejected')
def _(con):
    changed, created = redeem(con, 'h3')
    assert changed == 0 and created == 0, (changed, created)
    assert renewed(con, 'h3') is None
    n = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    assert n == 0, n
    return 'no user, no owner'


@case('redeem_unknown_code_rejected')
def _(con):
    changed, created = redeem(con, 'nope')
    assert changed == 0 and created == 0
    return 'rejected'


@case('renewal_keeps_original_account')
def _(con):
    redeem(con, 'h1', 'u-a')
    owner = renewed(con, 'h1')
    issue(con, owner)
    issue(con, owner)  # 二次续期
    n = con.execute("SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?", (owner,)).fetchone()[0]
    assert n == 2, n
    assert session_alive(con, owner)
    users = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    assert users == 1, users
    return 'two sessions, one user'


@case('no_user_created_without_claim')
def _(con):
    # 关键不变量：码没抢到就绝不能凭空建账号
    redeem(con, 'h2', 'u-intruder')
    users = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    assert users == 0, users
    return 'users=0'


failed = 0
for name, fn in cases:
    con = fresh()
    try:
        print('PASS %-42s %s' % (name, fn(con)))
    except AssertionError as e:
        failed += 1
        print('FAIL %-42s %s' % (name, e))

print('%d/%d cases passed' % (len(cases) - failed, len(cases)))
sys.exit(1 if failed else 0)
