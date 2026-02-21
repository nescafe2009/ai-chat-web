/**
 * Redis Reply - Serina 枢纽回复模块
 * 遵循 Hub 扇出规则：消息写入目标 agent 的收件箱 stream
 * 
 * 路由规则：
 * - to=boss → boss:messages
 * - to=cortana → cortana:messages
 * - to=roland → roland:messages
 * - 其他/未知 → serina:messages（兜底）
 * 
 * Hub UI 从所有 stream 聚合显示，所以无论写哪个 stream 都能在枢纽看到。
 * 写入目标收件箱的好处：对方 daemon 能直接轮询到，无需额外监听。
 */

const { createClient } = require('redis');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  redisHost: '42.192.211.138',
  redisPort: 6379,
  redisPass: 'SerinaCortana2026!',
  localPort: 16379,
  myName: 'serina',
  myStream: 'serina:messages',
  tunnelPidFile: '/tmp/redis-tunnel-serina.pid'
};

function startTunnel() {
  try {
    if (fs.existsSync(CONFIG.tunnelPidFile)) {
      const pid = fs.readFileSync(CONFIG.tunnelPidFile, 'utf8').trim();
      try { process.kill(parseInt(pid), 0); return true; } catch (e) {}
    }
    spawn('ssh', ['-f', '-N', '-o', 'StrictHostKeyChecking=no', '-L',
      `${CONFIG.localPort}:127.0.0.1:${CONFIG.redisPort}`,
      `root@${CONFIG.redisHost}`
    ], { detached: true, stdio: 'ignore' }).unref();
    execSync('sleep 2');
    const pid = execSync(`pgrep -f "ssh.*${CONFIG.localPort}:127.0.0.1:${CONFIG.redisPort}"`)
      .toString().trim().split('\n')[0];
    fs.writeFileSync(CONFIG.tunnelPidFile, pid);
    return true;
  } catch (e) { return false; }
}

async function getClient() {
  const client = createClient({
    socket: { host: '127.0.0.1', port: CONFIG.localPort },
    password: CONFIG.redisPass
  });
  client.on('error', () => {});
  await client.connect();
  return client;
}

/**
 * 回复消息 - 写入目标 agent 的收件箱 stream
 * @param {string} to - 收件人（例如 "boss", "cortana", "roland"）
 * @param {string} content - 回复内容（纯业务文本）
 * @param {string} [streamOverride] - 可选：强制指定目标 stream（覆盖路由）
 */
async function reply(to, content, streamOverride) {
  if (!to || !content) {
    console.error('用法: node redis-reply.js <to> <content>');
    process.exit(1);
  }

  // 路由：写入目标 agent 的收件箱 stream（不可变约束）
  const targetStream = streamOverride || `${to}:messages`;

  // 防回归断言：禁止写入发送者自己的 stream（除非 to==me）
  if (targetStream === CONFIG.myStream && to !== CONFIG.myName) {
    console.error(`ROUTE_ERROR: 禁止写入自己的 stream（${CONFIG.myStream}）给收件人 ${to}。应写入 ${to}:messages`);
    process.exit(1);
  }

  if (!startTunnel()) {
    console.error('TUNNEL_FAILED');
    process.exit(1);
  }

  const client = await getClient();
  try {
    const msgId = await client.xAdd(targetStream, '*', {
      from: CONFIG.myName,
      to: to,
      content: content,
      timestamp: Date.now().toString(),
      type: 'text'
    });
    console.log(`OK:${msgId}`);
    return msgId;
  } finally {
    await client.quit();
  }
}

// CLI
const [,, to, ...contentParts] = process.argv;
const content = contentParts.join(' ');

reply(to, content).catch(e => {
  console.error('ERROR:' + e.message);
  process.exit(1);
});

module.exports = { reply };
