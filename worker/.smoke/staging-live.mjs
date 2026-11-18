// 测试站真实验收：登录、发起一次带搜索的对话、登出。凭证只写在临时文件里。
import { readFileSync, writeFileSync } from 'node:fs';

const base = process.env.STAGE_BASE ?? 'https://model-test-demo-test.jiqimao123456.workers.dev';
const cookieFile = process.env.STAGE_COOKIE;

const saveCookie = (response) => {
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '';
  const cookie = raw.split(';')[0];
  if (!cookie) throw new Error('missing session cookie');
  writeFileSync(cookieFile, cookie);
  return cookie;
};

const command = process.argv[2];

if (command === 'login') {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: process.env.STAGE_INVITE }),
  });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`login ${response.status} ${text.slice(0, 160)}`);
  saveCookie(response);
  const body = JSON.parse(text);
  const me = await fetch(`${base}/api/me`, { headers: { Cookie: readFileSync(cookieFile, 'utf8') } });
  console.log(JSON.stringify({ userId: body.user?.id ?? null, renewed: body.renewed === true, me: me.status }));
} else if (command === 'chat') {
  const requestId = process.env.STAGE_REQUEST_ID;
  const prompt = process.env.STAGE_PROMPT;
  const flags = JSON.parse(process.env.STAGE_FLAGS ?? '{}');
  const started = Date.now();
  const response = await fetch(`${base}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      Cookie: readFileSync(cookieFile, 'utf8'),
      'x-request-id': requestId,
    },
    body: JSON.stringify({
      max_tokens: 700,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
      ...flags,
    }),
  });
  const text = await response.text();
  const urls = [...text.matchAll(/"url":"(https:\/\/[^"]+)"/g)].map((match) => match[1]);
  const report = {
    status: response.status,
    skillVersion: response.headers.get('x-skill-version'),
    ms: Date.now() - started,
    hasMessageStop: /event: message_stop/.test(text),
    hasToolUse: text.includes('server_tool_use'),
    hasToolResult: text.includes('web_search_tool_result'),
    toolError: /"error_code":"([a-z_]+)"/.exec(text)?.[1] ?? null,
    resultUrls: urls.slice(0, 4),
    textChars: [...text.matchAll(/"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g)]
      .map((match) => match[1]).join('').length,
    leak: process.env.STAGE_KEY ? text.includes(process.env.STAGE_KEY) : null,
    body: text.length > 40000 ? `${text.slice(0, 40000)}\n[truncated]` : text,
  };
  writeFileSync(`${cookieFile}.stream.txt`, text);
  console.log(JSON.stringify({ ...report, body: undefined }, null, 2));
} else if (command === 'logout') {
  const response = await fetch(`${base}/api/logout`, {
    method: 'POST',
    headers: { Origin: base, Cookie: readFileSync(cookieFile, 'utf8') },
  });
  const after = await fetch(`${base}/api/me`, { headers: { Cookie: readFileSync(cookieFile, 'utf8') } });
  console.log(JSON.stringify({ logout: response.status, meAfter: after.status }));
} else {
  throw new Error(`unknown command ${command}`);
}
