"""用真实 key 直连 DeepSeek Files API，确认 401 到底来自哪一端。

用法：python worker/.smoke/probe_upstream.py            # 读环境变量 DEEPSEEK_API_KEY
绝不打印 key 本身，只打印前缀长度与响应。
"""
import json
import os
import sys
import urllib.error
import urllib.request

KEY = os.environ.get('DEEPSEEK_API_KEY', '').strip()
if not KEY:
    # 退化：从 worker/.dev.vars 读
    for cand in ('.dev.vars', 'worker/.dev.vars', '../.dev.vars'):
        if os.path.exists(cand):
            for line in open(cand, encoding='utf-8'):
                if line.startswith('DEEPSEEK_API_KEY'):
                    KEY = line.split('=', 1)[1].strip().strip('"').strip("'")
                    break
        if KEY:
            break

if not KEY:
    print('no key found (set DEEPSEEK_API_KEY)')
    sys.exit(2)

print('key length=%d prefix=%s... suffix=...%s' % (len(KEY), KEY[:4], KEY[-4:]))

BOUND = '----probe'
body = (f'--{BOUND}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nfile\r\n'
        f'--{BOUND}\r\nContent-Disposition: form-data; name="file"; filename="p.txt"\r\n'
        f'Content-Type: text/plain\r\n\r\nhello\r\n--{BOUND}--\r\n').encode()

for name, url, data, ctype in [
    ('files', 'https://api.deepseek.com/anthropic/v1/files', body,
     f'multipart/form-data; boundary={BOUND}'),
    ('models', 'https://api.deepseek.com/models', None, None),
]:
    req = urllib.request.Request(url, data=data, method='POST' if data else 'GET')
    req.add_header('Authorization', 'Bearer ' + KEY)
    if ctype:
        req.add_header('Content-Type', ctype)
        req.add_header('anthropic-beta', 'files-api-2025-04-14')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(name, resp.status, resp.read().decode('utf-8', 'replace')[:300])
    except urllib.error.HTTPError as e:
        print(name, e.code, e.read().decode('utf-8', 'replace')[:300])
    except Exception as e:  # noqa: BLE001
        print(name, 'ERR', repr(e))
