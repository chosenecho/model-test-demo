"""生成邀请码并写入远端 D1 的 invite_codes_new。

用法：python worker/.smoke/mint_invites.py [数量] [备注]
输出：明文码写入 db/invite-codes-<时间戳>.txt（只此一份，勿提交仓库），同时打印到终端。
哈希前缀必须与 worker/src/core.js INVITE_HASH_PREFIX 一致。
"""
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time

PREFIX = 'dsh-invite-v1:'


def hash_code(code: str) -> str:
    return hashlib.sha256((PREFIX + code).encode('utf-8')).hexdigest()


def main() -> int:
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    note = sys.argv[2] if len(sys.argv) > 2 else 'batch-2026-11'
    now_ms = int(time.time() * 1000)

    codes, rows = [], []
    for _ in range(count):
        code = secrets.token_urlsafe(9)  # 12 chars
        codes.append(code)
        rows.append((secrets.token_hex(16), hash_code(code), note, now_ms))

    values = ', '.join(
        "('%s', '%s', '%s', NULL, %d)" % (i, h, n, t) for i, h, n, t in rows
    )
    sql = (
        'INSERT INTO invite_codes_new (id, code_hash, note, expires_at, created_at) '
        'VALUES ' + values + ';'
    )

    workdir = os.path.join(os.path.dirname(__file__), '..')
    out = os.path.join(workdir, '..', 'db', 'invite-codes-%d.txt' % now_ms)
    with open(out, 'w', encoding='utf-8') as f:
        for code in codes:
            f.write(code + '\n')

    cmd = [
        'npx', 'wrangler', 'd1', 'execute', 'model-test-demo-db',
        '--remote', '--command', sql, '--json',
    ]
    proc = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, shell=True)
    if proc.returncode != 0:
        print('FAIL', proc.returncode)
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
        return 1
    try:
        payload = json.loads(proc.stdout)
        meta = payload[0]['meta']
        print('inserted=%d changes=%d' % (count, meta.get('changes')))
    except Exception:
        print('insert ok (unparsed output)')

    print('codes ->', os.path.abspath(out))
    for code in codes:
        print(' ', code)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
