// 真实 Firecrawl MCP 探测：只在本地临时运行，密钥从 FC_KEY 环境变量读取，不写入仓库。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { searchFirecrawl } from '../src/firecrawl.js';

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../../db/firecrawl.sql', import.meta.url), 'utf8'));
const DB = {
  prepare(sql) {
    return {
      bind: (...params) => {
        const statement = sqlite.prepare(sql);
        return {
          first: async () => statement.get(...params) ?? null,
          all: async () => ({ results: statement.all(...params) }),
          run: async () => {
            const results = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
            return { success: true, results, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n } };
          },
        };
      },
    };
  },
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  },
};

const env = { DB, FIRECRAWL_API_KEY: process.env.FC_KEY };
const outcome = await searchFirecrawl(env, 'Cloudflare Workers fetch redirect manual', AbortSignal.timeout(45_000));
const summary = {
  status: outcome.status,
  code: outcome.code ?? null,
  count: outcome.results?.length ?? 0,
  hosts: [...new Set((outcome.results ?? []).map((item) => new URL(item.url).host))].slice(0, 5),
  sample: (outcome.results ?? []).slice(0, 2).map((item) => ({ title: item.title?.slice(0, 60), hasSnippet: Boolean(item.snippet) })),
  attempts: sqlite.prepare('SELECT COUNT(*) AS n FROM firecrawl_search_attempts').get().n,
};
console.log(JSON.stringify(summary, null, 2));
sqlite.close();
process.exit(outcome.status === 'ok' && summary.count > 0 ? 0 : 1);
