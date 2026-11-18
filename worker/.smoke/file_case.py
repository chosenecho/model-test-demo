"""文件归属回归：复刻 resolveFileRefs / deleteFile 的 SQL 语义（sqlite3，不是 Worker 运行时）。"""
import sqlite3

SCHEMA = """
CREATE TABLE file_objects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  upstream_id TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
"""

RESOLVE = (
    "SELECT id, upstream_id FROM file_objects "
    "WHERE user_id = ? AND deleted_at IS NULL AND id IN (%s)"
)
SOFT_DELETE = "UPDATE file_objects SET deleted_at = ? WHERE id = ? AND user_id = ?"

NOW = 1_700_000_000_000


def fresh():
    con = sqlite3.connect(':memory:')
    con.executescript(SCHEMA)
    con.executemany(
        "INSERT INTO file_objects (id, user_id, upstream_id, size_bytes, created_at) VALUES (?,?,?,?,?)",
        [
            ('f-alice', 'alice', 'up-a1', 1024, NOW),
            ('f-bob', 'bob', 'up-b1', 2048, NOW),
            ('f-gone', 'alice', 'up-a2', 10, NOW),
        ],
    )
    con.execute("UPDATE file_objects SET deleted_at = ? WHERE id = 'f-gone'", (NOW + 1,))
    con.commit()
    return con


def resolve(con, user_id, ids):
    if not ids:
        return True
    sql = RESOLVE % ','.join('?' * len(ids))
    rows = con.execute(sql, (user_id, *ids)).fetchall()
    return len(rows) == len(ids), dict(rows)


def case_own_file():
    con = fresh()
    ok, m = resolve(con, 'alice', ['f-alice'])
    assert ok and m == {'f-alice': 'up-a1'}, (ok, m)


def case_other_users_file():
    con = fresh()
    ok, _ = resolve(con, 'alice', ['f-bob'])
    assert not ok


def case_mixed_smuggle():
    con = fresh()
    ok, _ = resolve(con, 'alice', ['f-alice', 'f-bob'])
    assert not ok


def case_soft_deleted():
    con = fresh()
    ok, _ = resolve(con, 'alice', ['f-gone'])
    assert not ok


def case_unknown_id():
    con = fresh()
    ok, _ = resolve(con, 'alice', ['f-nope'])
    assert not ok


def case_delete_own_and_reuse_blocked():
    con = fresh()
    con.execute(SOFT_DELETE, (NOW + 5, 'f-alice', 'alice'))
    con.commit()
    ok, _ = resolve(con, 'alice', ['f-alice'])
    assert not ok, 'soft-deleted file must not resolve'
    row = con.execute("SELECT deleted_at FROM file_objects WHERE id='f-alice'").fetchone()
    assert row[0] == NOW + 5


def case_delete_other_user_noop():
    con = fresh()
    cur = con.execute(SOFT_DELETE, (NOW + 5, 'f-bob', 'alice'))
    con.commit()
    assert cur.rowcount == 0, 'cross-user delete must affect no rows'
    ok, m = resolve(con, 'bob', ['f-bob'])
    assert ok and m == {'f-bob': 'up-b1'}


CASES = [
    ('own_file_resolves', case_own_file),
    ('other_users_file_rejected', case_other_users_file),
    ('mixed_smuggle_rejected', case_mixed_smuggle),
    ('soft_deleted_rejected', case_soft_deleted),
    ('unknown_id_rejected', case_unknown_id),
    ('delete_then_unresolvable', case_delete_own_and_reuse_blocked),
    ('cross_user_delete_noop', case_delete_other_user_noop),
]

if __name__ == '__main__':
    passed = 0
    for name, fn in CASES:
        try:
            fn()
            print('PASS', name)
            passed += 1
        except AssertionError as e:
            print('FAIL', name, e)
    print('%d/%d cases passed' % (passed, len(CASES)))
