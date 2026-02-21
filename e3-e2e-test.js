#!/usr/bin/env node
/**
 * E3 端到端压测：发 10 条消息到 serina:messages (from=boss)
 * daemon 会拾取 → wake → main session 处理 → redis-chat.js 写回
 */
const { createClient } = require('redis');
const fs = require('fs');
const path = require('path');

const envPath = path.join(process.env.HOME, '.openclaw/credentials/redis-daemon-serina.env');
const text = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of text.split('\n')) {
  const l = line.trim();
  if (!l || l.startsWith('#')) continue;
  const idx = l.indexOf('=');
  if (idx > 0) env[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
}

const LONG_TEXT_EN = 'The quick brown fox jumps over the lazy dog. '.repeat(130); // ~6000 chars

const cases = [
  { id: 'E2E-01', content: '[E3-E2E-01] ping' },
  { id: 'E2E-02', content: '[E3-E2E-02] 这是一条中文短句测试' },
  { id: 'E2E-03', content: '[E3-E2E-03] Hello, this is an English test' },
  { id: 'E2E-04', content: '[E3-E2E-04] 🎉🔥💠🚀✅❌🤖📝🎯💡' },
  { id: 'E2E-05', content: '[E3-E2E-05] <script>alert("xss")</script> "quotes" & backslash\\' },
  { id: 'E2E-06', content: '[E3-E2E-06] {"key":"value","nested":{"arr":[1,2,3]}}' },
  { id: 'E2E-07', content: '[E3-E2E-07] # Heading\n- bullet\n**bold** `code`' },
  { id: 'E2E-08', content: "[E3-E2E-08] <img src=x onerror=alert(1)> '; DROP TABLE users;--" },
  { id: 'E2E-09', content: '[E3-E2E-09] ../../../etc/passwd %00 \x00' },
  { id: 'E2E-10', content: '[E3-E2E-10-LONG] ' + LONG_TEXT_EN },
];

(async () => {
  const client = createClient({
    socket: { host: '127.0.0.1', port: 16379, connectTimeout: 5000 },
    username: 'default', password: env.REDIS_PASS
  });
  client.on('error', () => {});
  await client.connect();

  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const ts = Date.now();
    const msgId = await client.xAdd('serina:messages', '*', {
      from: 'boss', to: 'serina',
      content: c.content,
      timestamp: String(ts), type: 'text'
    });
    results.push({ ...c, msgId, sentAt: new Date(ts).toISOString() });
    console.log(`[${c.id}] sent msgId=${msgId} len=${c.content.length}`);
    // 1.5s interval
    if (i < cases.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  await client.quit();

  // write results
  const out = results.map(r => `| ${r.id} | ${r.msgId} | ${r.content.length} | SENT |`).join('\n');
  console.log('\n=== SENT SUMMARY ===');
  console.log('| Case | trigger req_id | len | status |');
  console.log('|------|---------------|-----|--------|');
  console.log(out);
  console.log(`\nTotal: ${results.length} sent. First: ${results[0].msgId} Last: ${results[results.length-1].msgId}`);
})();
