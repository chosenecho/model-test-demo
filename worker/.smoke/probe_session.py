"""定位 putSession 403：单独复现一种「同一邀请码换新会话」的场景，并打印每次响应。"""
import json
import sys
import urllib.error
import urllib.request

BASE = 'https://aivmz.dpdns.org'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'


def call(method, path, body=None, cookie=None):
    h = {'User-Agent': UA}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h['Content-Type'] = 'application/json'
    if cookie:
        h['Cookie'] = cookie
        h['Origin'] = BASE
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode('utf-8', 'replace'), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), e.headers


code = open(sys.argv[1]).read().split()[int(sys.argv[2]) if len(sys.argv) > 2 else 0]

st, text, hdrs = call('POST', '/api/login', {'code': code})
cookie = (hdrs.get('Set-Cookie') or '').split(';')[0]
print('login', st, cookie[:24], text[:120])

sid = 'probe-%d' % __import__('time').time_ns()
payload = {'title': 'probe', 'messages': [
    {'id': sid + '-m1', 'role': 'user', 'content': [{'type': 'text', 'text': 'hi'}],
     'createdAt': 1730000000000}]}

st, text, hdrs = call('PUT', '/api/sessions/' + sid, payload, cookie)
print('PUT#1', st, text[:160])
print('  resp headers:', dict(hdrs).get('Server'), dict(hdrs).get('CF-Ray'))
st, text, _ = call('PUT', '/api/sessions/' + sid, payload, cookie)
print('PUT#2', st, text[:160])
st, text, _ = call('GET', '/api/sessions/' + sid, None, cookie)
print('GET', st, text[:120])
st, text, _ = call('DELETE', '/api/sessions/' + sid, None, cookie)
print('DEL', st, text[:120])
