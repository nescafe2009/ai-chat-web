/**
 * Redis Chat - Serina <-> Cortana 通信模块
 * 使用 Redis Streams 实现持久化消息队列
 * 通过 SSH 隧道连接
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
  defaultTo: 'boss',  // 默认回复给赵博
  logFile: path.join(process.env.HOME, '.openclaw/workspace/memory/chat-with-cortana.md'),
  tunnelPidFile: '/tmp/redis-tunnel-serina.pid'
};

// SSH 隧道管理
function startTunnel() {
  try {
    if (fs.existsSync(CONFIG.tunnelPidFile)) {
      const pid = fs.readFileSync(CONFIG.tunnelPidFile, 'utf8').trim();
      try {
        process.kill(parseInt(pid), 0);
        console.log(`隧道已运行 (PID: ${pid})`);
        return true;
      } catch (e) {
        // 进程不存在，继续创建
      }
    }
    
    const tunnel = spawn('ssh', [
      '-f', '-N', '-o', 'StrictHostKeyChecking=no',
      '-L', `${CONFIG.localPort}:127.0.0.1:${CONFIG.redisPort}`,
      `root@${CONFIG.redisHost}`
    ], { detached: true, stdio: 'ignore' });
    
    tunnel.unref();
    
    // 等待隧道建立
    execSync('sleep 2');
    
    // 找到 SSH 进程 PID
    const pid = execSync(`pgrep -f "ssh.*${CONFIG.localPort}:127.0.0.1:${CONFIG.redisPort}"`)
      .toString().trim().split('\n')[0];
    
    fs.writeFileSync(CONFIG.tunnelPidFile, pid);
    console.log(`SSH 隧道已启动 (PID: ${pid})`);
    return true;
  } catch (e) {
    console.error('启动隧道失败:', e.message);
    return false;
  }
}

function stopTunnel() {
  try {
    if (fs.existsSync(CONFIG.tunnelPidFile)) {
      const pid = fs.readFileSync(CONFIG.tunnelPidFile, 'utf8').trim();
      process.kill(parseInt(pid));
      fs.unlinkSync(CONFIG.tunnelPidFile);
      console.log('SSH 隧道已停止');
    }
  } catch (e) {
    console.error('停止隧道失败:', e.message);
  }
}

// Redis 客户端
async function getClient() {
  const client = createClient({
    socket: { host: '127.0.0.1', port: CONFIG.localPort },
    password: CONFIG.redisPass
  });
  
  client.on('error', err => console.error('Redis 错误:', err.message));
  await client.connect();
  return client;
}

// 记录日志
function logMessage(direction, peer, content, msgId) {
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const entry = `
### ${timestamp} [${direction}]
**${direction === '发送' ? 'To' : 'From'}:** ${peer}
**Content:** ${content}
**MsgID:** ${msgId}
`;
  fs.appendFileSync(CONFIG.logFile, entry);
}

// 发送消息（必须显式指定收件人）
async function sendMessage(content, to, type = 'text', streamOverride) {
  if (!to) {
    console.error('错误：必须指定收件人！');
    console.error('用法：send <收件人> <消息>');
    console.error('例如：send boss 你好');
    console.error('      send cortana 你好');
    console.error('      send boss,cortana 你好（多人）');
    process.exit(1);
  }
  
  startTunnel();
  const client = await getClient();
  
  try {
    // 解析收件人列表
    const recipients = to.split(',').map(t => t.trim().toLowerCase());
    const toField = recipients.join(', ');
    
    let lastMsgId;
    for (const recipient of recipients) {
      const stream = streamOverride || `${recipient}:messages`;
      lastMsgId = await client.xAdd(stream, '*', {
        from: CONFIG.myName,
        to: toField,
        content: content,
        timestamp: Date.now().toString(),
        type: type
      });
    }
    
    logMessage('发送', toField, content, lastMsgId);
    console.log(`消息已发送到 ${toField}: ${lastMsgId}`);
    return lastMsgId;
  } finally {
    await client.quit();
  }
}

// 读取新消息
async function readMessages(lastId = '0') {
  startTunnel();
  const client = await getClient();
  
  try {
    const stream = `${CONFIG.myName}:messages`;
    const messages = await client.xRead(
      { key: stream, id: lastId },
      { COUNT: 100 }
    );
    
    if (messages && messages.length > 0) {
      for (const msg of messages[0].messages) {
        const { from, content, type } = msg.message;
        logMessage('接收', from, content, msg.id);
        console.log(`[${msg.id}] ${from}: ${content}`);
      }
      return messages[0].messages;
    }
    return [];
  } finally {
    await client.quit();
  }
}

// 检查对方在线状态
async function checkPeerOnline() {
  startTunnel();
  const client = await getClient();
  
  try {
    const heartbeat = await client.get(`${CONFIG.peerName}:heartbeat`);
    if (heartbeat) {
      const diff = Math.floor((Date.now() - parseInt(heartbeat)) / 1000);
      if (diff < 120) {
        console.log(`${CONFIG.peerName} 在线 (${diff}秒前活跃)`);
        return true;
      }
    }
    console.log(`${CONFIG.peerName} 离线`);
    return false;
  } finally {
    await client.quit();
  }
}

// 更新心跳
async function updateHeartbeat() {
  startTunnel();
  const client = await getClient();
  
  try {
    await client.set(`${CONFIG.myName}:heartbeat`, Date.now().toString(), { EX: 60 });
    console.log('心跳已更新');
  } finally {
    await client.quit();
  }
}

// 查看历史
async function getHistory(count = 10) {
  startTunnel();
  const client = await getClient();
  
  try {
    const myStream = `${CONFIG.myName}:messages`;
    const peerStream = `${CONFIG.peerName}:messages`;
    
    console.log(`=== 收到的消息 (${myStream}) ===`);
    const received = await client.xRevRange(myStream, '+', '-', { COUNT: count });
    for (const msg of received) {
      console.log(`[${msg.id}] ${msg.message.from}: ${msg.message.content}`);
    }
    
    console.log(`\n=== 发送的消息 (${peerStream}) ===`);
    const sent = await client.xRevRange(peerStream, '+', '-', { COUNT: count });
    for (const msg of sent) {
      if (msg.message.from === CONFIG.myName) {
        console.log(`[${msg.id}] -> ${msg.message.to}: ${msg.message.content}`);
      }
    }
  } finally {
    await client.quit();
  }
}

// 测试连接
async function testConnection() {
  startTunnel();
  const client = await getClient();
  
  try {
    const pong = await client.ping();
    console.log(`Redis 连接: ${pong}`);
    return true;
  } finally {
    await client.quit();
  }
}

// CLI
const [,, cmd, ...args] = process.argv;

(async () => {
  switch (cmd) {
    case 'tunnel-start':
      startTunnel();
      break;
    case 'tunnel-stop':
      stopTunnel();
      break;
    case 'send':
      // send <to> <message> - 必须指定收件人
      if (args.length < 2) {
        console.error('错误：必须指定收件人和消息！');
        console.error('用法：send <收件人> <消息>');
        console.error('例如：send boss 你好');
        process.exit(1);
      }
      await sendMessage(args.slice(1).join(' '), args[0]);
      break;
    case 'sendto':
      // sendto <to> <message> - 和 send 一样，兼容 Cortana 版本
      if (args.length < 2) {
        console.error('错误：必须指定收件人和消息！');
        console.error('用法：sendto <收件人> <消息>');
        console.error('例如：sendto boss 你好');
        process.exit(1);
      }
      await sendMessage(args.slice(1).join(' '), args[0]);
      break;
    case 'read':
      await readMessages(args[0] || '0');
      break;
    case 'check':
      await checkPeerOnline();
      break;
    case 'heartbeat':
      await updateHeartbeat();
      break;
    case 'history':
      await getHistory(parseInt(args[0]) || 10);
      break;
    case 'test':
      await testConnection();
      break;
    default:
      console.log('用法: node redis-chat.js {tunnel-start|tunnel-stop|send [to] <msg>|read [lastId]|check|heartbeat|history [n]|test}');
      console.log('  send boss 消息内容 - 发给赵博');
      console.log('  send cortana,roland 消息内容 - 发给多人');
  }
})().catch(console.error);

module.exports = { sendMessage, readMessages, checkPeerOnline, updateHeartbeat, getHistory, startTunnel, stopTunnel };
