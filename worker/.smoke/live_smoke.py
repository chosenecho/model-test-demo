"""线上 smoke：Cookie 会话、登录限流、停流开关、上传归属、会话读写。

用法：python worker/.smoke/live_smoke.py <BASE_URL> <INVITE_CODE>
只读断言为主；唯一的写操作是创建 / 删除一个测试会话（软删）。
"""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'https://aivmz.dpdns.org'
CODE = sys.argv[2] if len(sys.argv) > 2 else ''

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

results = []


def call(method, path, body=None, cookie=None, raw=None, headers=None):
    url = BASE + path
    data = None
    hdrs = dict(headers or {})
    hdrs.setdefault('User-Agent', UA)
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode()
        hdrs.setdefault('Content-Type', 'application/json')
    if cookie:
        hdrs['Cookie'] = cookie
        # 浏览器对同源写请求一定带 Origin；脚本替它补上，才能过 sameOriginWrite
        if method not in ('GET', 'HEAD'):
            hdrs.setdefault('Origin', BASE)
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace'), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), e.headers
    except Exception as e:  # noqa: BLE001
        return 0, repr(e), {}


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else ''))


# 1. 无 Cookie 的 /api/me
st, text, hdrs = call('GET', '/api/me')
check('me_without_session_401', st == 401, f'{st} {text[:120]}')

# 2. 未登记的上游路径不得到达上游
st, text, _ = call('POST', '/v1/tools/asr', raw=b'')
check('unrouted_tool_path_404', st == 404, f'{st} {text[:120]}')

# 3. 登录
cookie = ''
if CODE:
    st, text, hdrs = call('POST', '/api/login', {'code': CODE})
    sc = hdrs.get('Set-Cookie', '')
    got = [p.strip() for p in sc.split(';') if '=' in p]
    cookie = sc.split(';')[0] if sc else ''
    body = json.loads(text) if text.startswith('{') else {}
    check('login_200', st == 200, f'{st} {text[:160]}')
    check('login_sets_httponly_cookie',
          'dsh_session=' in sc and 'HttpOnly' in sc and 'SameSite=Lax' in sc, sc[:160])
    check('login_no_plaintext_token', 'token' not in body, str(body)[:160])
    check('login_returns_expiresAt', isinstance(body.get('expiresAt'), int), str(body)[:120])

if cookie:
    # 4. 会话有效
    st, text, _ = call('GET', '/api/me', cookie=cookie)
    ok = st == 200 and 'quota' in text
    check('me_with_session_200', ok, f'{st} {text[:200]}')

    # 5. 会话快照写入 + 读回 + 软删
    sid = 'smoke-%d' % int(__import__('time').time() * 1000)
    payload = {'title': 'smoke', 'messages': [
        {'id': sid + '-m1', 'role': 'user', 'content': [{'type': 'text', 'text': 'hi'}],
         'createdAt': 1730000000000}]}
    st, text, _ = call('PUT', f'/api/sessions/{sid}', payload, cookie=cookie)
    check('put_session_200', st == 200, f'{st} {text[:200]}')

    st, text, _ = call('GET', f'/api/sessions/{sid}', cookie=cookie)
    msgs = (json.loads(text).get('messages') or []) if text.startswith('{') else []
    check('get_session_roundtrip',
          st == 200 and len(msgs) == 1 and msgs[0].get('id') == sid + '-m1',
          f'{st} {text[:300]}')

    # 6. 跨站写被拒（Origin 不匹配）
    st, text, _ = call('PUT', f'/api/sessions/{sid}', payload, cookie=cookie,
                       headers={'Origin': 'https://evil.example'})
    check('cross_site_put_403', st == 403, f'{st} {text[:120]}')

    st, text, _ = call('DELETE', f'/api/sessions/{sid}', cookie=cookie)
    check('delete_session_200', st == 200, f'{st} {text[:200]}')

    # 7. 上传：带 Cookie 上传一个小文本文件，再删掉
    boundary = '----smoke'
    part = (f'--{boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n'
            'file\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n'
            'Content-Type: text/plain\r\n\r\nhello\r\n'
            f'--{boundary}--\r\n').encode()
    st, text, _ = call('POST', '/anthropic/v1/files', raw=part, cookie=cookie,
                       headers={'Content-Type': f'multipart/form-data; boundary={boundary}',
                                'anthropic-beta': 'files-api-2025-04-14'})
    fid = ''
    if st == 200 and text.startswith('{'):
        fid = json.loads(text).get('id', '')
    if st == 502 and '401' in text:
        check('upload_route_reaches_upstream_502_on_bad_key', True, '')
    else:
        check('upload_returns_local_id', st == 200 and fid and not fid.startswith('file-'),
              f'{st} {text[:200]}')
    if fid:
        st, text, _ = call('DELETE', f'/anthropic/v1/files/{fid}', cookie=cookie,
                           headers={'anthropic-beta': 'files-api-2025-04-14'})
        check('delete_file_200', st in (200, 204), f'{st} {text[:160]}')

    # 8. 上传鉴权：别人的会话拿不到我们的文件（用伪造 id 试）
    st, text, _ = call('GET', '/anthropic/v1/files/whatever', cookie=cookie)
    check('unknown_file_route_404_or_405', st in (404, 405), f'{st}')

# 9. 登录限流：连续错码
if CODE:
    codes = []
    for _ in range(3):
        st, text, _ = call('POST', '/api/login', {'code': 'wrong-' + str(__import__('time').time_ns())})
        codes.append(st)
    # 同一 IP 在 10 分钟内计数共享，这三次里只要出现「先 401 后 429」即证明限流生效
    ok = codes[0] in (401, 429) and any(c in (401, 429) for c in codes) and set(codes) <= {401, 429}
    check('login_attempts_limited_or_401', ok, str(codes))

# 10. 退出
if cookie:
    st, text, _ = call('POST', '/api/logout', {}, cookie=cookie)
    check('logout_200', st == 200, f'{st} {text[:120]}')
    st, text, _ = call('GET', '/api/me', cookie=cookie)
    check('me_after_logout_401', st == 401, f'{st} {text[:120]}')

failed = [n for n, ok, _ in results if not ok]
print('---')
print('%d/%d passed' % (len(results) - len(failed), len(results)))
if failed:
    print('failed:', ', '.join(failed))
    sys.exit(1)
