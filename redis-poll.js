/**
 * Redis 消息轮询 - 检查 Cortana 的新消息
 * 由 cron 定期调用
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
  peerName: 'cortana',
  logFile: path.join(process.env.HOME, '.openclaw/workspace/memory/chat-with-cortana.md'),
  stateFile: path.join(process.env.HOME, '.openclaw/workspace/memory/redis-chat-state.json'),
  tunnelPidFile: '/tmp/redis-tunnel-serina.pid'
};

function startTunnel() {
  try {
    if (fs.existsSync(CONFIG.tunnelPidFile)) {
      const pid = fs.readFileSync(CONFIG.tunnelPidFile, 'utf8').trim();
      try { process.kill(parseInt(pid), 0); return true; } catch (e) {}
    }
    spawn('ssh', ['-f', '-N', '-o', 'StrictHostKeyChecking=no', '-L', `${CONFIG.localPort}:127.0.0.1:${CONFIG.redisPort}`, `root@${CONFIG.redisHost}`], { detached: true, stdio: 'ignore' }).unref();
    execSync('sleep 2');
    const pid = execSync(`pgrep -f "ssh.*${CONFIG.localPort}:127.0.0.1:${CONFIG.redisPort}"`).toString().trim().split('\n')[0];
    fs.writeFileSync(CONFIG.tunnelPidFile, pid);
    return true;
  } catch (e) { return false; }
}

async function getClient() {
  const client = createClient({ socket: { host: '127.0.0.1', port: CONFIG.localPort }, password: CONFIG.redisPass });
  client.on('error', () => {});
  await client.connect();
  return client;
}

function getLastId() {
  try {
    const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
    return state.lastId || '0';
  } catch (e) { return '0'; }
}

function saveLastId(lastId) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify({ lastId, updatedAt: Date.now() }));
}

function logMessage(from, content, msgId) {
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const entry = `\n### ${timestamp} [接收]\n**From:** ${from}\n**Content:** ${content}\n**MsgID:** ${msgId}\n`;
  fs.appendFileSync(CONFIG.logFile, entry);
}

async function checkMessages() {
  if (!startTunnel()) {
    console.log('TUNNEL_FAILED');
    return;
  }
  
  const client = await getClient();
  try {
    // 更新心跳
    await client.set(`${CONFIG.myName}:heartbeat`, Date.now().toString(), { EX: 120 });
    
    // 检查新消息
    const lastId = getLastId();
    const messages = await client.xRead({ key: `${CONFIG.myName}:messages`, id: lastId }, { COUNT: 50 });
    
    if (messages && messages.length > 0 && messages[0].messages.length > 0) {
      const newMsgs = messages[0].messages;
      let output = [];
      
      for (const msg of newMsgs) {
        const { from, content } = msg.message;
        logMessage(from, content, msg.id);
        output.push(`[${from}] ${content}`);
      }
      
      // 保存最后一条消息的 ID
      saveLastId(newMsgs[newMsgs.length - 1].id);
      
      // 输出新消息供 OpenClaw 处理
      console.log('NEW_MESSAGES:' + output.join(' | '));
    } else {
      console.log('NO_NEW_MESSAGES');
    }
  } finally {
    await client.quit();
  }
}

checkMessages().catch(e => console.log('ERROR:' + e.message));
