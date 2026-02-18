#!/usr/bin/env node
/**
 * Redis 监听 + 自动回复 Worker (Serina 版)
 *
 * 功能：
 * 1) 通过 SSH 隧道连接 Redis
 * 2) 断点续读 serina:messages
 * 3) 对指定来源的消息：调用本机 OpenClaw 生成回复
 * 4) 把回复写回 serina:messages (遵循 Redis-native reply-to-origin)
 *
 * 配置文件：
 * - ~/.openclaw/credentials/redis-daemon-serina.env (chmod 600)
 *   REDIS_PASS=...
 *   OPENCLAW_HOOKS_TOKEN=...   # 可选；为空则不 wake
 */

const { createClient } = require('redis');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// 引入 `redis-chat.js` 的 `sendMessage` (为了复用其 Redis 隧道和发送逻辑)
// 注意：这里需要确保 `redis-chat.js` 的路径正确，且它是可导入的模块
const redisChat = require('./redis-chat.js'); // 假设它在同一目录下

function loadEnvFile(envPath) {
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
    return true;
  } catch {
    return false;
  }
}

const defaultEnvFile = path.join(process.env.HOME || '/root', '.openclaw/credentials/redis-daemon-serina.env');
loadEnvFile(process.env.OPENCLAW_DAEMON_ENV_FILE || defaultEnvFile);

const CONFIG = {
  // Redis (通过 SSH 隧道)
  redisHost: '127.0.0.1',
  redisPort: 16379,
  redisPass: process.env.REDIS_PASS || '',

  // SSH 隧道配置 (Serina -> 42.192.211.138:6379)
  sshHost: '42.192.211.138',
  sshPort: 22,
  sshUser: 'root',
  localPort: 16379, // Serina 使用的本地端口
  remotePort: 6379,

  // Optional: explicitly choose SSH private key via env (e.g. ~/.ssh/id_serina_redis)
  sshKeyPath: process.env.REDIS_TUNNEL_SSH_KEY,

  // AI 助手的名字
  myName: 'serina', // <--- 添加这一行

  // OpenClaw Gateway (Serina 本机)
  gatewayPort: 18789,
  hooksToken: process.env.OPENCLAW_HOOKS_TOKEN || '', // Serina 自己的 hooks token

  // 监听/写回的 Redis Streams
  inChannel: 'serina:messages',    // Serina 的收件箱
  outChannel: 'serina:messages',   // 写回 Serina 自己的 stream

  // 只对这些 from 触发"智能自动回复"
  llmAllowFrom: ['boss', 'cortana', 'roland'], // 修正：回复所有协作 AI

  // 轮询间隔
  pollIntervalMs: 2000,

  // Tunnel health check
  tunnelCheckIntervalMs: 10000,
  tunnelConnectTimeoutMs: 1500,

  // 状态文件
  stateFile: path.join(process.env.HOME || '/root', '.openclaw/workspace/memory/redis-chat-state-serina.json'),
  logFile: path.join(process.env.HOME || '/root', '.openclaw/workspace/memory/serina-daemon.log'),
  tunnelPidFile: '/tmp/redis-tunnel-serina.pid',

  // OpenClaw 生成回复 (CLI)
  openclawBin: process.env.OPENCLAW_BIN || '/Users/serina/.nvm/versions/node/v24.13.0/bin/openclaw',
  openclawSessionId: 'serina-daemon-session', // 使用独立的 session ID
  openclawTimeoutMs: 60000
};

function nowTs() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function log(msg) {
  const line = `[${nowTs()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(CONFIG.logFile, line + '\n');
  } catch {}
}

function killTunnelIfAny() {
  try {
    if (!fs.existsSync(CONFIG.tunnelPidFile)) return;
    const pid = fs.readFileSync(CONFIG.tunnelPidFile, 'utf8').trim();
    if (!pid) return;
    try { process.kill(parseInt(pid, 10)); } catch {}
    try { fs.unlinkSync(CONFIG.tunnelPidFile); } catch {}
  } catch {}
}

function isTunnelPidAlive() {
  try {
    if (!fs.existsSync(CONFIG.tunnelPidFile)) return false;
    const pid = fs.readFileSync(CONFIG.tunnelPidFile, 'utf8').trim();
    if (!pid) return false;
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

function checkLocalPortOpen(timeoutMs) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = new net.Socket();
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };

    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(CONFIG.localPort, '127.0.0.1');
  });
}

async function ensureTunnel(forceRestart = false) {
  try {
    if (!forceRestart && isTunnelPidAlive()) {
      const ok = await checkLocalPortOpen(CONFIG.tunnelConnectTimeoutMs);
      if (ok) return true;
      // pid 活着但端口不通: 当作隧道坏了
      log('SSH 隧道疑似失效: pid 存活但本地端口不可连接, 将重建');
    }

    killTunnelIfAny();

    // -f 后台；-N 不执行命令；-L 本地端口转发
    const args = [
      '-f', '-N',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'TCPKeepAlive=yes'
    ];

    if (CONFIG.sshKeyPath) {
      args.push('-i', CONFIG.sshKeyPath);
    }

    args.push(
      '-p', String(CONFIG.sshPort),
      '-L', `${CONFIG.localPort}:127.0.0.1:${CONFIG.remotePort}`,
      `${CONFIG.sshUser}@${CONFIG.sshHost}`
    );

    const child = require('child_process').spawn('ssh', args, { detached: true, stdio: 'ignore' });
    child.unref();

    // 等待隧道建立
    require('child_process').execFileSync('sh', ['-lc', 'sleep 2']);

    const pid = require('child_process')
      .execFileSync('sh', ['-lc', `pgrep -f "ssh.*${CONFIG.localPort}:127.0.0.1:${CONFIG.remotePort}" | head -n 1`])
      .toString('utf8')
      .trim();

    if (pid) {
      fs.writeFileSync(CONFIG.tunnelPidFile, pid);
      const ok = await checkLocalPortOpen(CONFIG.tunnelConnectTimeoutMs);
      if (ok) {
        log('SSH 隧道已建立');
        return true;
      }

      log('SSH 隧道建立后端口不可连接: 将清理并失败返回');
      killTunnelIfAny();
      return false;
    }

    log('SSH 隧道建立失败: 未找到 ssh 进程');
    return false;
  } catch (e) {
    log('SSH 隧道失败: ' + e.message);
    return false;
  }
}

function getLastId() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')).lastId || '0';
  } catch {
    return '0';
  }
}

function saveLastId(lastId) {
  try {
    fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true });
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify({ lastId, updatedAt: Date.now() }));
  } catch (e) {
    log('保存状态失败: ' + e.message);
  }
}

function callWakeAPI(text) {
  return new Promise((resolve) => {
    if (!CONFIG.hooksToken) return resolve(false);

    const data = JSON.stringify({ text, mode: 'now' });

    const req = http.request({
      hostname: '127.0.0.1',
      port: CONFIG.gatewayPort,
      path: '/hooks/wake',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.hooksToken}`
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        const shortToken = CONFIG.hooksToken ? CONFIG.hooksToken.slice(0, 6) + '…' : 'missing';
        log(`Wake API 响应: ${res.statusCode} (token=${shortToken}) ${body ? 'body=' + body : ''}`);
        resolve(res.statusCode === 200);
      });
    });

    req.on('error', (e) => {
      log('Wake API 错误: ' + e.message);
      resolve(false);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve(false);
    });

    req.write(data);
    req.end();
  });
}

function execOpenclawAgent(promptText) {
  return new Promise((resolve, reject) => {
    const args = [
      'agent',
      '--session-id', CONFIG.openclawSessionId,
      '--message', promptText,
      '--json'
    ];

    const child = execFile(CONFIG.openclawBin, args, { timeout: CONFIG.openclawTimeoutMs, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `openclaw agent failed: ${err.message}${stderr ? ' stderr=' + String(stderr).slice(0, 400) : ''}`;
        return reject(new Error(msg));
      }

      const out = String(stdout || '').trim();
      if (!out) return resolve('');

      // 尝试解析 JSON
      try {
        const obj = JSON.parse(out);
        const content =
          (obj && obj.result && obj.result.payloads && obj.result.payloads[0] && obj.result.payloads[0].text) ||
          (obj && typeof obj.content === 'string' && obj.content) ||
          (obj && obj.message && typeof obj.message.content === 'string' && obj.message.content) ||
          (obj && obj.output && typeof obj.output === 'string' && obj.output) ||
          '';
        return resolve(String(content || '').trim());
      } catch {
        return resolve(out);
      }
    });

    // stdin 不需要
    if (child.stdin) child.stdin.end();
  });
}

function buildPrompt(from, content) {
  const rules = [
    '你是 Serina。你在 Redis 上用纯文本回复提问者。',
    '只输出一段可复制的中文纯文本；不要使用 Markdown 表格/卡片。',
    '不要执行任何命令，不要提出要我运行 shell 来完成回复。',
    '涉及密钥/账号/权限/配置变更：先要求老板确认再给步骤。',
    '不确定的事实要明确说不确定，不要编造。'
  ].join('\n');

  const userMsg = `来自 ${from} 的消息：\n${content}`;
  return `${rules}\n\n${userMsg}`;
}

async function handleOneMessage(client, msg) {
  const fields = msg.message || {};
  const from = String(fields.from || '').trim().toLowerCase(); // 提问者
  const to = String(fields.to || '').trim().toLowerCase(); // 收件人
  const content = String(fields.content || '').trim();

  if (!from || !content) return;

  // 规则 1: 只消费自己的 inbox (serina:messages)
  // 跳过自己发出的消息，避免回复自己
  if (from === CONFIG.myName) {
    return;
  }

  // 规则 3: 判断"这是给我的"
  // 既然已经在 serina:messages 里了，默认就是给我的
  // 只有 to 明确指向别人（且不包含 serina）时才跳过
  if (to && !to.includes(CONFIG.myName) && to !== '') {
    log(`消息 to=${to} 不包含 ${CONFIG.myName}，跳过 from=${from}`);
    return;
  }

  // 只对指定来源的消息做智能回复 (llmAllowFrom)
  if (!CONFIG.llmAllowFrom.includes(from)) {
    log(`消息 from=${from} 不在 llmAllowFrom 列表中，跳过`);
    return;
  }

  // 3. 处理 Fastpath: PING-<id> (规则 4)
  const pingMatch = content.match(/^PING-(\S+)$/i);
  if (pingMatch) {
    const pingId = pingMatch[1];
    try {
      // 写回 serina:messages，to=<from> (规则 7)
      await redisChat.sendMessage(`PONG-${pingId}`, from, 'text');
      log(`Fastpath PING 回复给 ${from}: PONG-${pingId}`);
    } catch (e) {
      log('Fastpath PING 回复失败: ' + e.message);
    }
    return; // Fastpath 消息处理完毕
  }

  // Slowpath: 调用 OpenClaw 生成回复，然后回写 Redis
  log(`Slowpath: 生成回复 from=${from} content=${content.substring(0, 80)}`);

  try {
    const prompt = buildPrompt(from, content);
    const reply = await execOpenclawAgent(prompt);
    if (reply && reply.trim()) {
      await redisChat.sendMessage(reply.trim(), from, 'text');
      log(`已回写 ${CONFIG.outChannel} 给 ${from} replyTo=${msg.id}`);
      // 同时 wake 主会话（可选，让主会话知道有新消息）
      if (CONFIG.hooksToken) {
        await callWakeAPI(`[hub-reply-sent] 已在枢纽回复 ${from}: ${reply.trim().substring(0, 100)}`);
      }
    } else {
      log(`OpenClaw 返回空回复，跳过回写`);
      // fallback: wake 主会话处理
      if (CONFIG.hooksToken) {
        const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
        const wakeText = `Redis serina:messages 有新消息（daemon 无法生成回复，请手动处理）：\n${from}: ${preview}\n\n请运行: node /Users/serina/.openclaw/workspace/projects/redis-chat-web/redis-reply.js ${from} "<你的回复>"`;
        await callWakeAPI(wakeText);
      }
    }
  } catch (e) {
    log(`Slowpath 回复失败: ${e.message}`);
    // fallback: wake 主会话
    if (CONFIG.hooksToken) {
      const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
      const wakeText = `Redis serina:messages 有新消息（daemon 回复出错: ${e.message.substring(0, 100)}）：\n${from}: ${preview}\n\n请运行: node /Users/serina/.openclaw/workspace/projects/redis-chat-web/redis-reply.js ${from} "<你的回复>"`;
      await callWakeAPI(wakeText);
    }
  }
}

async function checkMessages() {
  if (!(await ensureTunnel(false))) return;

  let client;
  try {
    client = createClient({
      socket: { host: CONFIG.redisHost, port: CONFIG.redisPort, connectTimeout: 5000 },
      username: 'default', // Redis 6 默认用户
      password: CONFIG.redisPass
    });

    client.on('error', () => {});
    await client.connect();

    // 心跳键：供外部快速判断守护进程是否仍在轮询（EX 120s）
    try {
      await client.set(`${CONFIG.myName}:heartbeat`, Date.now().toString(), { EX: 120 });
    } catch (e) {}

    const lastId = getLastId();
    const res = await client.xRead({ key: CONFIG.inChannel, id: lastId }, { COUNT: 20 });

    if (res && res.length > 0 && res[0].messages.length > 0) {
      const newMsgs = res[0].messages;
      log(`收到 ${newMsgs.length} 条新消息 (${CONFIG.inChannel})`);

      // 顺序处理，避免并发风暴
      for (const m of newMsgs) {
        await handleOneMessage(client, m);
        saveLastId(m.id); // 每处理一条就保存 ID，确保断点续读
      }
    }

    await client.quit();
  } catch (e) {
    log('Redis 检查失败: ' + e.message);
    if (client) try { await client.quit(); } catch {}
  }
}

async function main() {
  log('=== Serina Redis 自动回复 Worker 启动 ===');
  log(`Config: redisPass=${CONFIG.redisPass ? 'set' : 'missing'} hooksToken=${CONFIG.hooksToken ? 'set' : 'missing'} openclawBin=${CONFIG.openclawBin}`);

  if (!CONFIG.redisPass) {
    log('FATAL: missing REDIS_PASS (set in ~/.openclaw/credentials/redis-daemon-serina.env)');
    process.exit(2);
  }

  // hooksToken 可选，但建议设置以便主会话能收到通知

  // 确保状态目录存在
  try {
    fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true });
  } catch (e) {}

  while (true) {
    try {
      await checkMessages();
    } catch (e) {
      log('主循环错误: ' + e.message);
    }

    await new Promise((r) => setTimeout(r, CONFIG.pollIntervalMs));
  }
}

// 启动
main().catch((e) => {
  log('致命错误: ' + e.message);
  process.exit(1);
});
