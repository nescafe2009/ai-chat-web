/**
 * Redis Reply - Serina 枢纽回复模块
 * 遵循 Redis-native reply-to-origin 10 行规则
 * 
 * 规则核心：
 * - 写回同一条 stream（serina:messages），用 to=<from> 标识收件人
 * - 不依赖 OpenClaw webchat deliver
 * - 回包只放业务文本，不放调试信息
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
 * 回复消息 - 写回 serina:messages
 * @param {string} to - 收件人（例如 "boss", "cortana"）
 * @param {string} content - 回复内容（纯业务文本）
 */
async function reply(to, content) {
  if (!to || !content) {
    console.error('用法: node redis-reply.js <to> <content>');
    process.exit(1);
  }

  if (!startTunnel()) {
    console.error('TUNNEL_FAILED');
    process.exit(1);
  }

  const client = await getClient();
  try {
    const msgId = await client.xAdd(CONFIG.myStream, '*', {
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
