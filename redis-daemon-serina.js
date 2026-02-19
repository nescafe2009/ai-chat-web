#!/usr/bin/env node
/**
 * Redis 监听 Worker (Serina 版 - Option B: 纯 wake，不跑 LLM)
 *
 * 功能：
 * 1) 通过 SSH 隧道连接 Redis
 * 2) 断点续读 serina:messages
 * 3) 收到消息后构造 envelope，wake 主会话处理
 * 4) 不生成业务回复，不起独立 LLM session（避免 session split）
 *
 * 配置文件：
 * - ~/.openclaw/credentials/redis-daemon-serina.env (chmod 600)
 *   REDIS_PASS=...
 *   OPENCLAW_HOOKS_TOKEN=...
 */

const { createClient } = require('redis');
const fs = require('fs');
const http = require('http');
const path = require('path');

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
  redisHost: '127.0.0.1',
  redisPort: 16379,
  redisPass: process.env.REDIS_PASS || '',

  sshHost: '42.192.211.138',
  sshPort: 22,
  sshUser: 'root',
  localPort: 16379,
  remotePort: 6379,
  sshKeyPath: process.env.REDIS_TUNNEL_SSH_KEY,

  myName: 'serina',

  gatewayPort: 18789,
  hooksToken: process.env.OPENCLAW_HOOKS_TOKEN || '',

  inChannel: 'serina:messages',

  llmAllowFrom: ['boss', 'cortana', 'roland'],

  pollIntervalMs: 2000,
  tunnelCheckIntervalMs: 10000,
  tunnelConnectTimeoutMs: 1500,

  stateFile: path.join(process.env.HOME || '/root', '.openclaw/workspace/memory/redis-chat-state-serina.json'),
  logFile: path.join(process.env.HOME || '/root', '.openclaw/workspace/memory/serina-daemon.log'),
  tunnelPidFile: '/tmp/redis-tunnel-serina.pid',
};

function nowTs() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function log(msg) {
  const line = `[${nowTs()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch {}
}

// ── SSH 隧道管理 ──

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
  } catch { return false; }
}

function checkLocalPortOpen(timeoutMs) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
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
      log('SSH 隧道疑似失效: pid 存活但端口不通, 将重建');
    }
    killTunnelIfAny();
    const args = [
      '-f', '-N', '-o', 'StrictHostKeyChecking=no',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3', '-o', 'TCPKeepAlive=yes'
    ];
    if (CONFIG.sshKeyPath) args.push('-i', CONFIG.sshKeyPath);
    args.push('-p', String(CONFIG.sshPort), '-L',
      `${CONFIG.localPort}:127.0.0.1:${CONFIG.remotePort}`,
      `${CONFIG.sshUser}@${CONFIG.sshHost}`);
    require('child_process').spawn('ssh', args, { detached: true, stdio: 'ignore' }).unref();
    require('child_process').execFileSync('sh', ['-lc', 'sleep 2']);
    const pid = require('child_process')
      .execFileSync('sh', ['-lc', `pgrep -f "ssh.*${CONFIG.localPort}:127.0.0.1:${CONFIG.remotePort}" | head -n 1`])
      .toString('utf8').trim();
    if (pid) {
      fs.writeFileSync(CONFIG.tunnelPidFile, pid);
      const ok = await checkLocalPortOpen(CONFIG.tunnelConnectTimeoutMs);
      if (ok) { log('SSH 隧道已建立'); return true; }
      log('SSH 隧道建立后端口不通'); killTunnelIfAny(); return false;
    }
    log('SSH 隧道建立失败: 未找到 ssh 进程'); return false;
  } catch (e) { log('SSH 隧道失败: ' + e.message); return false; }
}

// ── 状态管理 ──

function getLastId() {
  try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')).lastId || '0'; }
  catch { return '0'; }
}

function saveLastId(lastId) {
  try {
    fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true });
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify({ lastId, updatedAt: Date.now() }));
  } catch (e) { log('保存状态失败: ' + e.message); }
}

// ── Wake API (Option B: 只唤醒主会话，不跑 LLM) ──

function callWakeAPI(text) {
  return new Promise((resolve) => {
    if (!CONFIG.hooksToken) { log('Wake 跳过: 无 hooksToken'); return resolve(false); }
    const data = JSON.stringify({ text, mode: 'now' });
    const req = http.request({
      hostname: '127.0.0.1', port: CONFIG.gatewayPort,
      path: '/hooks/wake', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.hooksToken}` }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString('utf8'); });
      res.on('end', () => {
        log(`Wake API 响应: ${res.statusCode} body=${body}`);
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', (e) => { log('Wake API 错误: ' + e.message); resolve(false); });
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(data); req.end();
  });
}

// ── 构造 envelope 并 wake 主会话 ──

function buildEnvelope(msg) {
  const fields = msg.message || {};
  const from = String(fields.from || '').trim().toLowerCase();
  const content = String(fields.content || '').trim();
  const replyStream = `${from}:messages`;

  return [
    `EGRESS_LOCK=redis`,
    `REPLY_STREAM=${replyStream}`,
    `REPLY_TO=${from}`,
    `REQ_ID=${msg.id}`,
    `ORIG_FROM=${from}`,
    `ORIG_CONTENT=${content}`,
  ].join('\n');
}

async function handleOneMessage(client, msg) {
  const fields = msg.message || {};
  const from = String(fields.from || '').trim().toLowerCase();
  const to = String(fields.to || '').trim().toLowerCase();
  const content = String(fields.content || '').trim();

  if (!from || !content) return;
  if (from === CONFIG.myName) return;
  if (to && !to.includes(CONFIG.myName) && to !== '') return;
  if (!CONFIG.llmAllowFrom.includes(from)) {
    log(`跳过 from=${from} (不在允许列表)`);
    return;
  }

  // Fastpath: PING
  const pingMatch = content.match(/^PING-(\S+)$/i);
  if (pingMatch) {
    try {
      await client.xAdd(`${from}:messages`, '*', {
        from: CONFIG.myName, to: from,
        content: `PONG-${pingMatch[1]}`,
        timestamp: Date.now().toString(), type: 'text'
      });
      log(`Fastpath PONG-${pingMatch[1]} → ${from}`);
    } catch (e) { log('PING 回复失败: ' + e.message); }
    return;
  }

  // Option B: 构造 envelope + 上下文窗口，wake 主会话
  const envelope = buildEnvelope(msg);

  // 拉取最近 N 条消息作为 ORIG_CONTEXT（窗口化）
  let contextBlock = '';
  try {
    const CONTEXT_COUNT = 20;
    const CONTEXT_MAX_CHARS = 6000;
    const recent = await client.xRevRange(CONFIG.inChannel, '+', '-', { COUNT: CONTEXT_COUNT });
    if (recent && recent.length > 1) {
      // 跳过当前消息（第一条），取之前的消息
      const contextMsgs = recent.slice(1).reverse();
      let contextText = '';
      let truncated = false;
      const PER_MSG_MAX_CHARS = 500;
      for (const m of contextMsgs) {
        const f = m.message || {};
        const rawContent = (f.content || '');
        let msgContent;
        if (rawContent.length > PER_MSG_MAX_CHARS) {
          const head = rawContent.substring(0, 200);
          const tail = rawContent.substring(rawContent.length - 200);
          msgContent = `${head}...[TRUNCATED_PER_MSG origChars=${rawContent.length} msgId=${m.id}]...${tail}`;
        } else {
          msgContent = rawContent;
        }
        const line = `[${f.from || '?'}] ${msgContent}`;
        if (contextText.length + line.length > CONTEXT_MAX_CHARS) {
          truncated = true;
          break;
        }
        contextText += line + '\n';
      }
      if (contextText) {
        contextBlock = `\nORIG_CONTEXT=${truncated ? '[TRUNCATED] ' : ''}${contextText.trim()}`;
      }
    }
  } catch (e) {
    log('拉取上下文失败(非致命): ' + e.message);
  }

  const wakeText = `[HUB-MESSAGE] 枢纽收到新消息，请处理并写回 Redis。\n\n${envelope}${contextBlock}`;

  log(`Wake main: from=${from} req_id=${msg.id} content=${content.substring(0, 80)}`);
  await callWakeAPI(wakeText);
}

// ── 主循环 ──

async function checkMessages() {
  if (!(await ensureTunnel(false))) return;
  let client;
  try {
    client = createClient({
      socket: { host: CONFIG.redisHost, port: CONFIG.redisPort, connectTimeout: 5000 },
      username: 'default', password: CONFIG.redisPass
    });
    client.on('error', () => {});
    await client.connect();

    try { await client.set(`${CONFIG.myName}:heartbeat`, Date.now().toString(), { EX: 120 }); } catch {}

    const lastId = getLastId();
    const res = await client.xRead({ key: CONFIG.inChannel, id: lastId }, { COUNT: 20 });

    if (res && res.length > 0 && res[0].messages.length > 0) {
      const newMsgs = res[0].messages;
      log(`收到 ${newMsgs.length} 条新消息 (${CONFIG.inChannel})`);
      for (const m of newMsgs) {
        await handleOneMessage(client, m);
        saveLastId(m.id);
      }
    }
    await client.quit();
  } catch (e) {
    log('Redis 检查失败: ' + e.message);
    if (client) try { await client.quit(); } catch {}
  }
}

async function main() {
  log('=== Serina Redis Daemon 启动 (Option B: 纯 wake) ===');
  log(`Config: redisPass=${CONFIG.redisPass ? 'set' : 'missing'} hooksToken=${CONFIG.hooksToken ? 'set' : 'missing'}`);

  if (!CONFIG.redisPass) {
    log('FATAL: missing REDIS_PASS');
    process.exit(2);
  }
  if (!CONFIG.hooksToken) {
    log('WARNING: missing OPENCLAW_HOOKS_TOKEN, wake 将无法工作');
  }

  try { fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true }); } catch {}

  while (true) {
    try { await checkMessages(); }
    catch (e) { log('主循环错误: ' + e.message); }
    await new Promise((r) => setTimeout(r, CONFIG.pollIntervalMs));
  }
}

main().catch((e) => { log('致命错误: ' + e.message); process.exit(1); });
