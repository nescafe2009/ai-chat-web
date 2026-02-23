/**
 * 枢纽平台 (Stellaris Hub) v6
 * 功能：聊天记录 + 档案馆
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

// 配置（支持环境变量）
const PORT = process.env.PORT || 8888;
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASS = process.env.REDIS_PASS || 'SerinaCortana2026!';
const SESSION_TTL = 24 * 60 * 60;
const MSG_LIMIT = 200; // 每个 stream 最多拉取条数
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, 'docs');
const JOURNALS_DIR = path.join(__dirname, 'journals');
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'stellaris-archive');
const STELLARIS_DOCS_DIR = process.env.STELLARIS_DOCS_DIR || path.join(__dirname, '..', 'stellaris-docs');
const DOCS_SINGLE_SOURCE = process.env.DOCS_SINGLE_SOURCE === 'true'; // feature flag: true = 旧单源模式

// Registry 加载（doc code -> doc_id 映射）
function loadRegistry() {
  const reg = {};
  const files = [
    { source: 'archive', path: path.join(ARCHIVE_DIR, 'registry', 'archive.json') },
    { source: 'docs', path: path.join(STELLARIS_DOCS_DIR, 'registry', 'docs.json') }
  ];
  for (const f of files) {
    try {
      if (fs.existsSync(f.path)) {
        const data = JSON.parse(fs.readFileSync(f.path, 'utf-8'));
        for (const [code, entry] of Object.entries(data)) {
          reg[code] = { ...entry, code, source: f.source };
        }
      }
    } catch (e) { console.error(`[Registry] 加载失败 ${f.path}:`, e.message); }
  }
  return reg;
}
let docRegistry = loadRegistry();
// 每 60 秒刷新 registry
setInterval(() => { docRegistry = loadRegistry(); }, 60000);

function resolveByCode(code, lang) {
  const entry = docRegistry[code];
  if (!entry) return null;
  const preferLang = lang || 'zh';
  const filePath = entry.translations[preferLang] || entry.translations['zh'] || Object.values(entry.translations)[0];
  if (!filePath) return null;
  const baseDir = entry.source === 'archive' ? ARCHIVE_DIR : STELLARIS_DOCS_DIR;
  const fullPath = path.join(baseDir, filePath);
  const missingTranslation = !entry.translations[preferLang];
  return { entry, filePath, fullPath, lang: missingTranslation ? Object.keys(entry.translations)[0] : preferLang, missingTranslation, baseDir };
}

// 验证码存储
const loginCodes = new Map();

// 消息缓存（防并发重复查询）
let msgCache = { data: null, time: 0 };
const CACHE_TTL = 2000; // 2秒缓存

// 单例 Redis 客户端
let redisClient = null;

async function getRedisClient() {
  if (redisClient && redisClient.isOpen) return redisClient;
  
  // 如果存在但已关闭，先清理
  if (redisClient) {
    try { await redisClient.quit(); } catch (e) {}
    redisClient = null;
  }
  
  redisClient = createClient({
    socket: {
      host: REDIS_HOST,
      port: REDIS_PORT,
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          console.error('[Redis] 重连失败超过10次，放弃');
          return new Error('Max retries reached');
        }
        console.log(`[Redis] 重连中... 第${retries}次`);
        return Math.min(retries * 100, 3000);
      }
    },
    password: REDIS_PASS
  });
  
  redisClient.on('error', (err) => console.error('[Redis] 错误:', err.message));
  redisClient.on('end', () => console.log('[Redis] 连接关闭'));
  redisClient.on('reconnecting', () => console.log('[Redis] 正在重连...'));
  redisClient.on('connect', () => console.log('[Redis] 已连接'));
  
  await redisClient.connect();
  return redisClient;
}

// 生成6位数字验证码
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 生成会话ID
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// 解析 Cookie
function parseCookies(cookieHeader) {
  const cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) cookies[name] = value;
    });
  }
  return cookies;
}

// 检查登录状态（从 Redis 读取）
async function checkAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies.session;
  if (!sessionId) return null;
  
  try {
    const client = await getRedisClient();
    const user = await client.get(`session:${sessionId}`);
    return user;
  } catch (e) {
    return null;
  }
}

// 创建会话（存到 Redis）
async function createSession(user) {
  const sessionId = generateSessionId();
  try {
    const client = await getRedisClient();
    await client.set(`session:${sessionId}`, user, { EX: SESSION_TTL });
    return sessionId;
  } catch (e) {
    return null;
  }
}

// 删除会话
async function deleteSession(sessionId) {
  try {
    const client = await getRedisClient();
    await client.del(`session:${sessionId}`);
  } catch (e) {}
}

// 通过 Redis 通知 Serina
async function notifySerina(message) {
  try {
    const client = await getRedisClient();
    await client.xAdd('serina:messages', '*', {
      from: 'system',
      to: 'serina',
      content: message,
      timestamp: Date.now().toString()
    });
    return true;
  } catch (e) {
    console.error('[notifySerina] 失败:', e.message);
    return false;
  }
}

async function notifyCortana(message) {
  try {
    const client = await getRedisClient();
    await client.xAdd('cortana:messages', '*', {
      from: 'system',
      to: 'cortana',
      content: message,
      timestamp: Date.now().toString()
    });
    return true;
  } catch (e) {
    console.error('[notifyCortana] 失败:', e.message);
    return false;
  }
}

// ========== 档案馆功能 ==========

// 解析 YAML frontmatter
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  
  const meta = {};
  const yamlLines = match[1].split('\n');
  for (const line of yamlLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      // 处理数组 [a, b, c]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim());
      }
      // 去掉 YAML 字符串引号
      if (typeof value === 'string' && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
  }
  return { meta, body: match[2] };
}

// category 别名映射：中文 → 英文 canonical key
const CATEGORY_ALIAS = {
  // 中文别名
  '章程': 'charter', '宪法': 'constitution', '法律': 'laws',
  '愿景': 'vision', '会议纪要': 'minutes', '策略': 'strategy',
  '操作章程': 'ops-charter', '运行手册': 'runbooks', '规格说明': 'specs',
  '模板': 'templates', '项目': 'projects', '日志': 'journals',
  '每日': 'daily', '发布': 'releases', '证据': 'evidence',
  '未分类': 'uncategorized',
  // 英文别名（非 canonical 形式）
  'meeting minutes': 'minutes', 'meeting-minutes': 'minutes',
  'ops charter': 'ops-charter', 'operations charter': 'ops-charter',
  'run book': 'runbooks', 'run books': 'runbooks',
  'template': 'templates', 'project': 'projects', 'journal': 'journals',
  'release': 'releases', 'spec': 'specs', 'specification': 'specs',
};
function normalizeCategory(raw) {
  if (!raw) return 'uncategorized';
  const key = raw.trim().toLowerCase();
  // 已经是英文 canonical key 则直接返回
  const canonicals = new Set(['vision','constitution','laws','charter','ops-charter','minutes','strategy',
    'runbooks','runbook','specs','daily','journals','releases','evidence','templates','projects','uncategorized']);
  if (canonicals.has(key)) return key;
  // 别名映射（先精确匹配，再 lowercase 匹配）
  if (CATEGORY_ALIAS[raw.trim()]) return CATEGORY_ALIAS[raw.trim()];
  if (CATEGORY_ALIAS[key]) return CATEGORY_ALIAS[key];
  return raw.trim();
}

// category canonical key → 中文展示名
const CATEGORY_DISPLAY = {
  'vision': '愿景', 'constitution': '宪法', 'laws': '法律',
  'charter': '章程', 'ops-charter': '操作章程', 'minutes': '会议纪要',
  'strategy': '策略', 'runbooks': '运行手册', 'runbook': '运行手册',
  'specs': '规格说明', 'daily': '每日', 'journals': '日志',
  'releases': '发布', 'evidence': '证据', 'templates': '模板',
  'projects': '项目', 'uncategorized': '未分类',
};

// 获取档案列表（支持多源扫描）
function getDocsList(sourceFilter, preferLang) {
  try {
    const docs = [];
    
    function scanDir(dir, prefix, source) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath, prefix ? prefix + '/' + entry.name : entry.name, source);
        } else if (entry.name.endsWith('.md')) {
          const relPath = prefix ? prefix + '/' + entry.name : entry.name;
          const content = fs.readFileSync(fullPath, 'utf-8');
          const { meta } = parseFrontmatter(content);
          const section = prefix ? prefix.split('/')[0] : '';
          const statusMap = { 'approved': 'approved', 'drafts': 'draft', 'deprecated': 'deprecated' };
          const status = (meta.status || statusMap[section] || 'unreviewed').toLowerCase();
          // doc_id 优先级：frontmatter doc_id > frontmatter id > 文件名（去掉 .zh/.en.md）
          const docId = meta.doc_id || meta.id || entry.name.replace(/\.(zh|en)\.md$/, '').replace('.md', '');
          // 从 registry 反查 code
          const regCode = Object.entries(docRegistry).find(([c, e]) => e.doc_id === docId && e.source === source);
          // 检测语言：从 frontmatter 或文件名
          const fileLang = meta.lang || (entry.name.match(/\.(zh|en)\.md$/) ? entry.name.match(/\.(zh|en)\.md$/)[1] : 'zh');
          docs.push({
            filename: source + ':' + relPath,
            id: docId,
            title: meta.title || entry.name.replace(/\.(zh|en)\.md$/, '').replace('.md', ''),
            category: normalizeCategory(meta.category),
            section: section,
            status: status,
            created_at: meta.created_at || '',
            author: meta.author || '',
            tags: Array.isArray(meta.tags) ? meta.tags : [],
            visibility: meta.visibility || 'internal',
            source: source,
            code: regCode ? regCode[0] : null,
            lang: fileLang
          });
        }
      }
    }

    if (DOCS_SINGLE_SOURCE) {
      // 旧单源模式（feature flag 回退）
      if (!sourceFilter || sourceFilter === 'legacy') {
        if (fs.existsSync(DOCS_DIR)) scanDir(DOCS_DIR, '', 'legacy');
        if (fs.existsSync(JOURNALS_DIR)) scanDir(JOURNALS_DIR, 'journals', 'legacy');
      }
    } else {
      // 新双源模式
      if (!sourceFilter || sourceFilter === 'archive') {
        if (fs.existsSync(ARCHIVE_DIR)) scanDir(ARCHIVE_DIR, '', 'archive');
      }
      if (!sourceFilter || sourceFilter === 'docs') {
        if (fs.existsSync(STELLARIS_DOCS_DIR)) scanDir(STELLARIS_DOCS_DIR, '', 'docs');
      }
      // legacy 仅在显式请求时扫描
      if (sourceFilter === 'legacy') {
        if (fs.existsSync(DOCS_DIR)) scanDir(DOCS_DIR, '', 'legacy');
        if (fs.existsSync(JOURNALS_DIR)) scanDir(JOURNALS_DIR, 'journals', 'legacy');
      }
    }

    // 按 source 权重 + status 权重 + 日期倒序
    const sourceWeight = { 'archive': 0, 'docs': 1, 'legacy': 2 };
    const statusWeight = { 'approved': 0, 'draft': 1, 'unreviewed': 2, 'deprecated': 3 };
    docs.sort((a, b) => {
      const sw = (sourceWeight[a.source] ?? 2) - (sourceWeight[b.source] ?? 2);
      if (sw !== 0) return sw;
      const w = (statusWeight[a.status] ?? 2) - (statusWeight[b.status] ?? 2);
      if (w !== 0) return w;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });

    // 去重：同一个 doc_id+source 只保留一条（优先请求的语言）
    const seen = new Set();
    const deduped = [];
    const pLang = preferLang || 'zh';
    // 先把优先语言排前面
    docs.sort((a, b) => (a.lang === pLang ? -1 : 1) - (b.lang === pLang ? -1 : 1));
    for (const doc of docs) {
      const key = doc.id + '|' + doc.source;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(doc);
      }
    }
    // 重新按原排序
    deduped.sort((a, b) => {
      const sw = (sourceWeight[a.source] ?? 2) - (sourceWeight[b.source] ?? 2);
      if (sw !== 0) return sw;
      const w = (statusWeight[a.status] ?? 2) - (statusWeight[b.status] ?? 2);
      if (w !== 0) return w;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    return deduped;
  } catch (e) {
    console.error('[getDocsList] 失败:', e.message);
    return [];
  }
}

// source:path 解析为实际文件路径
function resolveDocPath(filename) {
  // 安全检查
  if (filename.includes('..')) return { error: 'path_traversal_rejected', code: 403 };
  
  // 新格式: source:path
  const colonIdx = filename.indexOf(':');
  if (colonIdx > 0) {
    const source = filename.slice(0, colonIdx);
    const relPath = path.normalize(filename.slice(colonIdx + 1));
    if (relPath.includes('..')) return { error: 'path_traversal_rejected', code: 403 };
    const dirMap = { 'archive': ARCHIVE_DIR, 'docs': STELLARIS_DOCS_DIR, 'legacy': DOCS_DIR };
    const baseDir = dirMap[source];
    if (!baseDir) return { error: 'unknown_source', code: 400 };
    const filePath = path.join(baseDir, relPath);
    if (!filePath.startsWith(baseDir)) return { error: 'path_outside_allowed_dirs', code: 403 };
    return { filePath, source };
  }
  
  // 兼容旧格式（无 source 前缀）
  const normalized = path.normalize(filename);
  if (normalized.startsWith('journals/') || normalized.startsWith('journals\\')) {
    return { filePath: path.join(__dirname, normalized), source: 'legacy' };
  }
  // 先查新源，再查旧源
  for (const [src, dir] of [['archive', ARCHIVE_DIR], ['docs', STELLARIS_DOCS_DIR], ['legacy', DOCS_DIR]]) {
    const fp = path.join(dir, normalized);
    if (fs.existsSync(fp) && fp.startsWith(dir)) return { filePath: fp, source: src };
  }
  return { filePath: path.join(DOCS_DIR, normalized), source: 'legacy' };
}

// 获取单个档案内容（支持多源）
function getDocContent(filename) {
  try {
    const resolved = resolveDocPath(filename);
    if (resolved.error) return resolved;
    if (!fs.existsSync(resolved.filePath)) return null;
    
    const content = fs.readFileSync(resolved.filePath, 'utf-8');
    const { meta, body } = parseFrontmatter(content);
    return { meta, body };
  } catch (e) {
    console.error('[getDocContent] 失败:', e.message);
    return null;
  }
}

// 登录页面 HTML
const LOGIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - 枢纽</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-box { background: #16213e; padding: 40px; border-radius: 12px; width: 320px; text-align: center; }
    h1 { color: #00d4ff; margin-bottom: 10px; font-size: 24px; }
    .subtitle { color: #888; margin-bottom: 30px; font-size: 14px; }
    .input-group { margin-bottom: 20px; }
    input { width: 100%; padding: 12px 15px; border: 1px solid #333; border-radius: 6px; background: #0f0f23; color: #eee; font-size: 16px; text-align: center; letter-spacing: 8px; }
    input:focus { outline: none; border-color: #00d4ff; }
    input::placeholder { letter-spacing: normal; }
    .btn { width: 100%; padding: 12px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: #00d4ff; color: #000; }
    .btn-primary:hover { background: #00b8e6; }
    .btn-secondary { background: #333; color: #eee; margin-top: 10px; }
    .btn-secondary:hover { background: #444; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .message { margin-top: 15px; font-size: 13px; min-height: 20px; }
    .message.success { color: #4caf50; }
    .message.error { color: #f44336; }
    .countdown { color: #888; font-size: 12px; margin-top: 5px; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>🌟 枢纽</h1>
    <p class="subtitle">Serina · Cortana · Roland</p>
    
    <div class="input-group">
      <input type="text" id="code" placeholder="输入验证码" maxlength="6" autocomplete="off">
    </div>
    
    <button class="btn btn-primary" id="loginBtn" onclick="login()">登录</button>
    <button class="btn btn-secondary" id="getCodeBtn" onclick="getCode()">获取验证码</button>
    
    <div class="message" id="message"></div>
    <div class="countdown" id="countdown"></div>
  </div>
  
  <script>
    let cooldown = 0;
    
    async function getCode() {
      if (cooldown > 0) return;
      
      const btn = document.getElementById('getCodeBtn');
      const msg = document.getElementById('message');
      
      btn.disabled = true;
      msg.textContent = '正在发送...';
      msg.className = 'message';
      
      try {
        const res = await fetch('/api/request-code', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          msg.textContent = '验证码已发送到钉钉，5分钟内有效';
          msg.className = 'message success';
          startCooldown(60);
        } else {
          msg.textContent = data.error || '发送失败';
          msg.className = 'message error';
          btn.disabled = false;
        }
      } catch (e) {
        msg.textContent = '网络错误';
        msg.className = 'message error';
        btn.disabled = false;
      }
    }
    
    function startCooldown(seconds) {
      cooldown = seconds;
      updateCooldown();
    }
    
    function updateCooldown() {
      const btn = document.getElementById('getCodeBtn');
      const cd = document.getElementById('countdown');
      
      if (cooldown > 0) {
        btn.disabled = true;
        cd.textContent = cooldown + ' 秒后可重新获取';
        cooldown--;
        setTimeout(updateCooldown, 1000);
      } else {
        btn.disabled = false;
        cd.textContent = '';
      }
    }
    
    async function login() {
      const code = document.getElementById('code').value.trim();
      const msg = document.getElementById('message');
      
      if (code.length !== 6) {
        msg.textContent = '请输入6位验证码';
        msg.className = 'message error';
        return;
      }
      
      const btn = document.getElementById('loginBtn');
      btn.disabled = true;
      
      try {
        const res = await fetch('/api/verify-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        
        if (data.success) {
          msg.textContent = '登录成功，正在跳转...';
          msg.className = 'message success';
          setTimeout(() => location.reload(), 500);
        } else {
          msg.textContent = data.error || '验证码错误';
          msg.className = 'message error';
          btn.disabled = false;
        }
      } catch (e) {
        msg.textContent = '网络错误';
        msg.className = 'message error';
        btn.disabled = false;
      }
    }
    
    // 回车登录
    document.getElementById('code').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') login();
    });
  </script>
</body>
</html>`;

// 主聊天页面 HTML
const CHAT_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>枢纽 - 星辰 Stellaris</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; height: 100vh; overflow: hidden; }
    
    .container { display: flex; height: 100vh; }
    
    .sidebar { width: 180px; background: #0f0f23; border-right: 1px solid #333; display: flex; flex-direction: column; }
    .sidebar-header { padding: 15px; text-align: center; border-bottom: 1px solid #333; }
    .sidebar-header h2 { font-size: 14px; color: #00d4ff; }
    .date-list { flex: 1; overflow-y: auto; padding: 10px 0; }
    .date-item { padding: 10px 15px; cursor: pointer; border-left: 3px solid transparent; transition: all 0.2s; }
    .date-item:hover { background: #1a1a3e; }
    .date-item.active { background: #1a1a3e; border-left-color: #00d4ff; }
    .date-item .date-label { font-size: 14px; color: #eee; }
    .date-item .msg-count { font-size: 11px; color: #666; margin-top: 2px; }
    .logout-btn { margin: 10px; padding: 8px; background: #333; border: none; border-radius: 6px; color: #888; cursor: pointer; font-size: 12px; }
    .logout-btn:hover { background: #444; color: #eee; }
    
    .main { flex: 1; display: flex; flex-direction: column; }
    .header { padding: 15px 20px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 18px; color: #00d4ff; }
    .header-right { display: flex; align-items: center; gap: 15px; }
    .user-info { font-size: 13px; color: #4caf50; }
    .status { font-size: 13px; color: #888; }
    .status.online { color: #4caf50; }
    
    .chat-box { flex: 1; overflow-y: auto; padding: 20px; background: #16213e; }
    .message { margin-bottom: 15px; padding: 12px 16px; border-radius: 12px; max-width: 85%; }
    .message.serina { background: #0f3460; margin-left: auto; border-bottom-right-radius: 4px; }
    .message.cortana { background: #533483; margin-right: auto; border-bottom-left-radius: 4px; }
    .message.roland { background: #1e5128; margin-right: auto; border-bottom-left-radius: 4px; }
    .message.boss { background: #8b4513; margin-left: auto; border-bottom-right-radius: 4px; }
    .message .from { font-size: 12px; color: #aaa; margin-bottom: 4px; }
    .message .content { line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; }
    .message .time { font-size: 11px; color: #666; margin-top: 6px; text-align: right; }
    
    .input-area { padding: 15px 20px; border-top: 1px solid #333; display: flex; gap: 10px; align-items: flex-end; position: relative; }
    .msg-input { flex: 1; padding: 12px 15px; border: 1px solid #333; border-radius: 6px; background: #0f0f23; color: #eee; font-size: 14px; resize: none; min-height: 50px; }
    .msg-input:focus { outline: none; border-color: #00d4ff; }
    .send-btn { padding: 12px 25px; background: #00d4ff; color: #000; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; height: fit-content; }
    .send-btn:hover { background: #00b8e6; }
    .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    
    .input-hint { padding: 5px 20px 15px; font-size: 12px; color: #666; }
    
    .mention-popup { position: absolute; bottom: 100%; left: 20px; background: #0f0f23; border: 1px solid #333; border-radius: 6px; display: none; min-width: 150px; box-shadow: 0 -4px 12px rgba(0,0,0,0.3); }
    .mention-popup.show { display: block; }
    .mention-item { padding: 10px 15px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
    .mention-item:hover, .mention-item.active { background: #1a1a3e; }
    .mention-item:first-child { border-radius: 6px 6px 0 0; }
    .mention-item:last-child { border-radius: 0 0 6px 6px; }
    
    .empty-state { text-align: center; padding: 50px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <div class="sidebar-header">
        <h2>🌟 枢纽</h2>
      </div>
      <div class="nav-links" style="padding: 10px; border-bottom: 1px solid #333;">
        <a href="/" style="display: block; padding: 8px 12px; color: #00d4ff; text-decoration: none; background: #1a1a3e; border-radius: 6px; margin-bottom: 5px;">💬 聊天记录</a>
        <a href="/archive" style="display: block; padding: 8px 12px; color: #888; text-decoration: none; border-radius: 6px; margin-bottom: 5px;">📜 档案馆</a>
        <a href="/docs" style="display: block; padding: 8px 12px; color: #888; text-decoration: none; border-radius: 6px;">📖 文档库</a>
      </div>
      <div style="padding: 10px 15px; border-bottom: 1px solid #333; font-size: 12px; color: #888;">📅 日期筛选</div>
      <div class="date-list" id="dateList"></div>
      <button class="logout-btn" onclick="logout()">退出登录</button>
    </div>
    <div class="main">
      <div class="header">
        <h1>💠 Serina & 💜 Cortana & 🌿 Roland</h1>
        <div class="header-right">
          <span class="user-info">👤 赵博</span>
          <span class="status" id="status">连接中...</span>
        </div>
      </div>
      <div class="chat-box" id="chat"></div>
      <div class="input-area">
        <div class="mention-popup" id="mentionPopup">
          <div class="mention-item" data-name="serina" onclick="insertMention('serina')">💠 Serina</div>
          <div class="mention-item" data-name="cortana" onclick="insertMention('cortana')">💜 Cortana</div>
          <div class="mention-item" data-name="roland" onclick="insertMention('roland')">🌿 Roland</div>
        </div>
        <textarea class="msg-input" id="msgInput" placeholder="输入消息，@ 可联想，Enter发送，Ctrl+Enter换行" rows="2"></textarea>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()">发送</button>
      </div>
      <div class="input-hint">Enter 发送 | Ctrl+Enter 换行 | @ 自动联想</div>
    </div>
  </div>
  
  <script>
    let allMessages = [];
    let dateGroups = {};
    let selectedDate = null;
    let userScrolling = false;
    
    const chat = document.getElementById('chat');
    
    function isNearBottom() {
      return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100;
    }
    
    chat.addEventListener('scroll', () => {
      userScrolling = !isNearBottom();
    });
    
    function getDateKey(timestamp) {
      const d = new Date(parseInt(timestamp));
      return d.toISOString().split('T')[0];
    }
    
    function formatDateLabel(dateKey) {
      const d = new Date(dateKey + 'T00:00:00');
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      
      const todayKey = today.toISOString().split('T')[0];
      const yesterdayKey = yesterday.toISOString().split('T')[0];
      
      if (dateKey === todayKey) return '今天';
      if (dateKey === yesterdayKey) return '昨天';
      return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' });
    }
    
    function getIcon(from) {
      if (from === 'serina') return '💠 Serina';
      if (from === 'cortana') return '💜 Cortana';
      if (from === 'roland') return '🌿 Roland';
      if (from === 'boss') return '👤 赵博';
      return from;
    }
    
    function renderDateList() {
      const dateList = document.getElementById('dateList');
      const sortedDates = Object.keys(dateGroups).sort().reverse();
      
      dateList.innerHTML = sortedDates.map(dateKey => {
        const count = dateGroups[dateKey].length;
        const isActive = dateKey === selectedDate;
        return '<div class="date-item' + (isActive ? ' active' : '') + '" onclick="selectDate(\\'' + dateKey + '\\')">' +
          '<div class="date-label">' + formatDateLabel(dateKey) + '</div>' +
          '<div class="msg-count">' + count + ' 条消息</div>' +
        '</div>';
      }).join('');
    }
    
    function selectDate(dateKey) {
      selectedDate = dateKey;
      renderDateList();
      renderMessages();
      userScrolling = false;
      chat.scrollTop = chat.scrollHeight;
    }
    
    function formatTo(to) {
      if (!to) return '';
      const names = to.split(',').map(t => {
        t = t.trim().toLowerCase();
        if (t === 'serina') return 'Serina';
        if (t === 'cortana') return 'Cortana';
        if (t === 'roland') return 'Roland';
        if (t === 'boss') return '赵博';
        return t;
      });
      return names.join(', ');
    }
    
    function renderMessages() {
      if (!selectedDate || !dateGroups[selectedDate]) {
        chat.innerHTML = '<div class="empty-state">选择左侧日期查看消息</div>';
        return;
      }
      
      const msgs = dateGroups[selectedDate];
      chat.innerHTML = msgs.map(m => {
        const time = new Date(parseInt(m.timestamp)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const toLabel = m.to ? ' → ' + formatTo(m.to) : '';
        return '<div class="message ' + m.from + '">' +
          '<div class="from">' + getIcon(m.from) + toLabel + '</div>' +
          '<div class="content">' + escapeHtml(m.content) + '</div>' +
          '<div class="time">' + time + '</div>' +
        '</div>';
      }).join('');
    }
    
    async function loadMessages() {
      try {
        const res = await fetch('/api/messages');
        const data = await res.json();
        const status = document.getElementById('status');
        
        if (data.error) {
          status.textContent = '错误: ' + data.error;
          status.className = 'status';
          return;
        }
        
        status.textContent = '在线 - ' + new Date().toLocaleTimeString();
        status.className = 'status online';
        
        allMessages = data.messages;
        
        dateGroups = {};
        for (const m of allMessages) {
          const key = getDateKey(m.timestamp);
          if (!dateGroups[key]) dateGroups[key] = [];
          dateGroups[key].push(m);
        }
        
        if (!selectedDate || !dateGroups[selectedDate]) {
          const sortedDates = Object.keys(dateGroups).sort().reverse();
          selectedDate = sortedDates[0] || null;
        }
        
        renderDateList();
        
        const wasNearBottom = isNearBottom();
        renderMessages();
        
        if (!userScrolling && wasNearBottom) {
          chat.scrollTop = chat.scrollHeight;
        }
        
      } catch (e) {
        document.getElementById('status').textContent = '连接失败';
      }
    }
    
    async function sendMessage() {
      const input = document.getElementById('msgInput');
      const content = input.value.trim();
      
      if (!content) return;
      
      // 解析 @ 目标
      const mentions = content.toLowerCase().match(/@(serina|cortana|roland)/g) || [];
      const targets = [...new Set(mentions.map(m => m.slice(1)))]; // 去重
      const target = targets.length > 0 ? targets.join(',') : 'all';
      
      const btn = document.getElementById('sendBtn');
      btn.disabled = true;
      
      try {
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, target })
        });
        const data = await res.json();
        
        if (data.success) {
          input.value = '';
          loadMessages();
        } else {
          alert(data.error || '发送失败');
        }
      } catch (e) {
        alert('网络错误');
      }
      
      btn.disabled = false;
    }
    
    function logout() {
      fetch('/api/logout', { method: 'POST' }).then(() => location.reload());
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      let html = div.innerHTML;
      // 把字面量 \\n 转成真正的换行
      html = html.replace(/\\\\n/g, '\\n');
      // 移除 ANSI 转义码
      html = html.replace(/\\u001b\[[0-9;]*m/g, '');
      html = html.replace(/\x1b\[[0-9;]*m/g, '');
      return html;
    }
    
    // @ 联想功能
    const mentionPopup = document.getElementById('mentionPopup');
    const msgInput = document.getElementById('msgInput');
    const mentionNames = ['serina', 'cortana', 'roland'];
    let mentionStart = -1;
    let activeIndex = 0;
    
    function showMentionPopup(filter = '') {
      const items = mentionPopup.querySelectorAll('.mention-item');
      let visibleCount = 0;
      items.forEach((item, i) => {
        const name = item.dataset.name;
        const show = !filter || name.startsWith(filter.toLowerCase());
        item.style.display = show ? 'flex' : 'none';
        if (show) visibleCount++;
      });
      if (visibleCount > 0) {
        mentionPopup.classList.add('show');
        activeIndex = 0;
        updateActiveItem();
      } else {
        hideMentionPopup();
      }
    }
    
    function hideMentionPopup() {
      mentionPopup.classList.remove('show');
      mentionStart = -1;
    }
    
    function updateActiveItem() {
      const items = [...mentionPopup.querySelectorAll('.mention-item')].filter(i => i.style.display !== 'none');
      items.forEach((item, i) => item.classList.toggle('active', i === activeIndex));
    }
    
    function insertMention(name) {
      const val = msgInput.value;
      const before = val.substring(0, mentionStart);
      const after = val.substring(msgInput.selectionStart);
      msgInput.value = before + '@' + name + ' ' + after;
      msgInput.focus();
      const newPos = before.length + name.length + 2;
      msgInput.setSelectionRange(newPos, newPos);
      hideMentionPopup();
    }
    
    msgInput.addEventListener('input', (e) => {
      const val = msgInput.value;
      const pos = msgInput.selectionStart;
      
      // 查找最近的 @
      let atPos = -1;
      for (let i = pos - 1; i >= 0; i--) {
        if (val[i] === '@') { atPos = i; break; }
        if (val[i] === ' ' || val[i] === '\\n') break;
      }
      
      if (atPos >= 0) {
        const filter = val.substring(atPos + 1, pos);
        if (filter.length <= 10 && /^[a-z]*$/i.test(filter)) {
          mentionStart = atPos;
          showMentionPopup(filter);
          return;
        }
      }
      hideMentionPopup();
    });
    
    // 键盘事件：Enter发送，Ctrl+Enter换行，上下选择@
    msgInput.addEventListener('keydown', (e) => {
      if (mentionPopup.classList.contains('show')) {
        const items = [...mentionPopup.querySelectorAll('.mention-item')].filter(i => i.style.display !== 'none');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          activeIndex = (activeIndex + 1) % items.length;
          updateActiveItem();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          activeIndex = (activeIndex - 1 + items.length) % items.length;
          updateActiveItem();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const activeItem = items[activeIndex];
          if (activeItem) insertMention(activeItem.dataset.name);
          return;
        }
        if (e.key === 'Escape') {
          hideMentionPopup();
          return;
        }
      }
      
      // Enter 发送，Ctrl+Enter 换行
      if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+Enter 换行
          const pos = msgInput.selectionStart;
          const val = msgInput.value;
          msgInput.value = val.substring(0, pos) + '\n' + val.substring(pos);
          msgInput.setSelectionRange(pos + 1, pos + 1);
          e.preventDefault();
        } else {
          // Enter 发送
          e.preventDefault();
          sendMessage();
        }
      }
    });
    
    // 点击外部关闭联想
    document.addEventListener('click', (e) => {
      if (!mentionPopup.contains(e.target) && e.target !== msgInput) {
        hideMentionPopup();
      }
    });
    
    loadMessages();
    setInterval(loadMessages, 10000);
  </script>
</body>
</html>`;

// 档案馆页面 HTML
const ARCHIVE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>档案馆 - 枢纽</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; }
    
    .container { display: flex; height: 100vh; }
    
    .sidebar { width: 280px; background: #0f0f23; border-right: 1px solid #333; display: flex; flex-direction: column; }
    .sidebar-header { padding: 15px; text-align: center; border-bottom: 1px solid #333; }
    .sidebar-header h2 { font-size: 16px; color: #00d4ff; }
    .nav-links { padding: 10px; border-bottom: 1px solid #333; }
    .nav-link { display: block; padding: 10px 15px; color: #888; text-decoration: none; border-radius: 6px; margin-bottom: 5px; }
    .nav-link:hover { background: #1a1a3e; color: #eee; }
    .nav-link.active { background: #1a1a3e; color: #00d4ff; }
    
    .category-filter { padding: 10px 15px; border-bottom: 1px solid #333; }
    .category-filter label { font-size: 12px; color: #888; display: block; margin-bottom: 5px; }
    .category-filter select { width: 100%; padding: 8px; background: #1a1a2e; border: 1px solid #333; border-radius: 4px; color: #eee; }
    
    .doc-list { flex: 1; overflow-y: auto; padding: 10px; }
    .doc-item { padding: 12px; cursor: pointer; border-radius: 8px; margin-bottom: 8px; background: #16213e; border: 1px solid transparent; transition: all 0.2s; }
    .doc-item:hover { border-color: #333; }
    .doc-item.active { border-color: #00d4ff; }
    .doc-item .doc-title { font-size: 14px; color: #eee; margin-bottom: 4px; }
    .doc-item .doc-meta { font-size: 11px; color: #666; }
    .doc-item .doc-category { display: inline-block; padding: 2px 6px; background: #333; border-radius: 3px; font-size: 10px; margin-right: 5px; }
    
    .logout-btn { margin: 10px; padding: 8px; background: #333; border: none; border-radius: 6px; color: #888; cursor: pointer; font-size: 12px; }
    .logout-btn:hover { background: #444; color: #eee; }
    
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .header { padding: 15px 20px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 18px; color: #00d4ff; }
    
    .content { flex: 1; overflow-y: auto; padding: 30px 40px; }
    .content h1 { font-size: 24px; margin-bottom: 10px; color: #00d4ff; }
    .content h2 { font-size: 20px; margin: 25px 0 15px; color: #eee; border-bottom: 1px solid #333; padding-bottom: 8px; }
    .content h3 { font-size: 16px; margin: 20px 0 10px; color: #ccc; }
    .content p { line-height: 1.8; margin-bottom: 15px; }
    .content ul, .content ol { margin: 15px 0; padding-left: 25px; }
    .content li { line-height: 1.8; margin-bottom: 8px; }
    .content table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    .content th, .content td { padding: 10px 12px; border: 1px solid #333; text-align: left; }
    .content th { background: #0f0f23; }
    .content code { background: #0f0f23; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
    .content pre { background: #0f0f23; padding: 15px; border-radius: 6px; overflow-x: auto; margin: 15px 0; }
    .content blockquote { border-left: 3px solid #00d4ff; padding-left: 15px; margin: 15px 0; color: #aaa; }
    .content hr { border: none; border-top: 1px solid #333; margin: 20px 0; }
    .content strong { color: #00d4ff; }
    
    .doc-header { margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #333; }
    .doc-header .meta { font-size: 13px; color: #888; margin-top: 10px; }
    .doc-header .tags { margin-top: 8px; }
    .doc-header .tag { display: inline-block; padding: 3px 8px; background: #333; border-radius: 4px; font-size: 11px; margin-right: 5px; }
    
    .empty-state { text-align: center; padding: 50px; color: #666; }
    .loading { text-align: center; padding: 50px; color: #888; }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <div class="sidebar-header">
        <h2>🌟 星辰档案馆</h2>
      </div>
      <div class="nav-links">
        <a href="/" class="nav-link">💬 聊天记录</a>
        <a href="/archive" class="nav-link active">📜 档案馆</a>
        <a href="/docs" class="nav-link">📖 文档库</a>
      </div>
      <div style="padding:8px 15px;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px">
        <span style="color:#888;font-size:12px">语言:</span>
        <button id="langZh" onclick="setLang('zh')" style="padding:4px 10px;border-radius:4px;border:1px solid #333;cursor:pointer;font-size:12px">中文</button>
        <button id="langEn" onclick="setLang('en')" style="padding:4px 10px;border-radius:4px;border:1px solid #333;cursor:pointer;font-size:12px">EN</button>
      </div>
      <div class="category-filter">
        <label>搜索</label>
        <input type="text" id="searchInput" placeholder="标题/路径/关键词" oninput="filterDocs()" style="width:100%;padding:8px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#eee;margin-bottom:8px">
        <label>状态筛选</label>
        <select id="statusFilter" onchange="filterDocs()">
          <option value="">全部</option>
          <option value="approved">✅ Approved</option>
          <option value="draft">📝 Draft</option>
          <option value="unreviewed">🔍 Unreviewed</option>
          <option value="deprecated">🗑️ Deprecated</option>
        </select>
        <label style="margin-top:8px">分类筛选</label>
        <select id="categoryFilter" onchange="filterDocs()">
          <option value="">全部</option>
        </select>
      </div>
      <div class="doc-list" id="docList">
        <div class="loading">加载中...</div>
      </div>
      <button class="logout-btn" onclick="logout()">退出登录</button>
    </div>
    <div class="main">
      <div class="header">
        <h1>📜 档案馆</h1>
        <div style="font-size: 12px; color: #888; margin-top: 4px;">治理层文档 — 组织核心文件</div>
      </div>
      <div class="content" id="content">
        <div class="empty-state">← 选择左侧文档查看</div>
      </div>
    </div>
  </div>
  
  <script>
    let allDocs = [];
    let selectedDoc = null;
    let currentLang = localStorage.getItem('ui.lang') || 'zh';
    
    function setLang(lang) {
      currentLang = lang;
      localStorage.setItem('ui.lang', lang);
      updateLangButtons();
      // 重新加载列表和当前文档
      loadDocs();
      if (selectedDoc) selectDoc(selectedDoc);
    }
    function updateLangButtons() {
      const zh = document.getElementById('langZh');
      const en = document.getElementById('langEn');
      zh.style.background = currentLang === 'zh' ? '#00d4ff' : '#1a1a2e';
      zh.style.color = currentLang === 'zh' ? '#000' : '#888';
      en.style.background = currentLang === 'en' ? '#00d4ff' : '#1a1a2e';
      en.style.color = currentLang === 'en' ? '#000' : '#888';
    }
    updateLangButtons();
    
    async function loadDocs() {
      try {
        const res = await fetch('/api/docs?source=archive&lang=' + currentLang);
        const data = await res.json();
        if (data.error) {
          document.getElementById('docList').innerHTML = '<div class="empty-state">加载失败</div>';
          return;
        }
        allDocs = data.docs;
        window._catDisplay = data.categoryDisplay || {};
        // 动态填充分类筛选器（基于枚举，去重）
        const categories = [...new Set(allDocs.map(d => d.category).filter(Boolean))].sort();
        const catSel = document.getElementById('categoryFilter');
        // 清除旧选项（保留"全部"）
        while (catSel.options.length > 1) catSel.remove(1);
        const lang = currentLang;
        categories.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = (lang === 'zh' && window._catDisplay[s]) ? window._catDisplay[s] : s; catSel.appendChild(o); });
        renderDocList();
      } catch (e) {
        document.getElementById('docList').innerHTML = '<div class="empty-state">网络错误</div>';
      }
    }
    
    function filterDocs() {
      renderDocList();
    }
    
    function renderDocList() {
      const statusF = document.getElementById('statusFilter').value;
      const catF = document.getElementById('categoryFilter').value;
      const searchQ = (document.getElementById('searchInput').value || '').toLowerCase().trim();
      let docs = allDocs;
      if (statusF) docs = docs.filter(d => d.status === statusF);
      if (catF) docs = docs.filter(d => d.category === catF);
      if (searchQ) docs = docs.filter(d => (d.title || '').toLowerCase().includes(searchQ) || (d.filename || '').toLowerCase().includes(searchQ) || (d.category || '').toLowerCase().includes(searchQ) || (d.author || '').toLowerCase().includes(searchQ));
      
      if (docs.length === 0) {
        document.getElementById('docList').innerHTML = '<div class="empty-state">暂无文档</div>';
        return;
      }
      
      const statusColors = { 'approved': '#00c853', 'draft': '#ff9800', 'unreviewed': '#9e9e9e', 'deprecated': '#f44336' };
      document.getElementById('docList').innerHTML = docs.map(d => {
        const isActive = selectedDoc === d.filename;
        const statusBadge = d.status ? '<span style="display:inline-block;padding:2px 6px;background:' + (statusColors[d.status] || '#333') + ';border-radius:3px;font-size:10px;margin-right:5px;color:#fff">' + d.status + '</span>' : '';
        return '<div class="doc-item' + (isActive ? ' active' : '') + '" onclick="selectDoc(\\'' + d.filename.replace(/'/g, "\\\\'") + '\\')">' +
          '<div class="doc-title">' + escapeHtml(d.title) + '</div>' +
          '<div class="doc-meta">' +
            statusBadge +
            '<span class="doc-category">' + escapeHtml((currentLang === 'zh' && window._catDisplay[d.category]) ? window._catDisplay[d.category] : d.category) + '</span>' +
            ' ' + d.created_at +
          '</div>' +
        '</div>';
      }).join('');
    }
    
    async function selectDoc(filename) {
      selectedDoc = filename;
      renderDocList();
      
      document.getElementById('content').innerHTML = '<div class="loading">加载中...</div>';
      
      try {
        // 查找文档是否有 code，有则用 code API（支持语言切换）
        const docInfo = allDocs.find(d => d.filename === filename);
        let fetchUrl;
        if (docInfo && docInfo.code) {
          fetchUrl = '/api/doc/' + encodeURIComponent(docInfo.code) + '?lang=' + currentLang;
        } else {
          fetchUrl = '/api/docs/' + encodeURIComponent(filename);
        }
        const res = await fetch(fetchUrl);
        const data = await res.json();
        
        if (data.error) {
          document.getElementById('content').innerHTML = '<div class="empty-state">加载失败: ' + data.error + '</div>';
          return;
        }
        
        const meta = data.meta;
        const tags = Array.isArray(meta.tags) ? meta.tags : [];
        
        let html = '<div class="doc-header">';
        if (data.missingTranslation) {
          html += '<div style="background:#553300;padding:8px 12px;border-radius:6px;margin-bottom:10px;color:#ffaa00;font-size:13px">⚠️ Missing translation for "' + currentLang + '". Showing "' + (data.lang || 'zh') + '" version.</div>';
        }
        if (data.code) {
          html += '<div style="color:#888;font-size:12px;margin-bottom:6px">' + escapeHtml(data.code) + ' | ' + escapeHtml(data.doc_id || '') + '</div>';
        }
        html += '<h1>' + escapeHtml(meta.title || filename) + '</h1>';
        html += '<div class="meta">';
        if (meta.status) {
          const sc = meta.status.toLowerCase() === 'approved' ? '#00c853' : '#ff9800';
          html += '<span style="display:inline-block;padding:2px 8px;background:' + sc + ';border-radius:4px;font-size:12px;color:#fff;margin-right:8px">' + escapeHtml(meta.status) + '</span>';
        }
        html += '<span class="doc-category">' + escapeHtml(meta.category || meta.type || '未分类') + '</span>';
        if (meta.created_at) html += ' · ' + meta.created_at;
        if (meta.author) html += ' · 作者: ' + meta.author;
        if (meta.reviewer) html += ' · 审阅: ' + meta.reviewer;
        html += '</div>';
        if (tags.length > 0) {
          html += '<div class="tags">';
          tags.forEach(t => { html += '<span class="tag">' + escapeHtml(t) + '</span>'; });
          html += '</div>';
        }
        html += '</div>';
        
        // 简单的 Markdown 渲染
        html += '<div class="doc-body">' + renderMarkdown(data.body) + '</div>';
        
        document.getElementById('content').innerHTML = html;
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="empty-state">网络错误</div>';
      }
    }
    
    function renderMarkdown(md) {
      // 简单的 Markdown 转 HTML
      let html = escapeHtml(md);
      
      // 代码块
      html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
      // 行内代码
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      // 标题
      html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
      // 粗体
      html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      // 斜体
      html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
      // 分隔线
      html = html.replace(/^---$/gm, '<hr>');
      // 引用
      html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
      // 无序列表
      html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
      // 有序列表
      html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
      // 表格（简单处理）
      html = html.replace(/\\|(.+)\\|/g, function(match, content) {
        const cells = content.split('|').map(c => c.trim());
        if (cells.every(c => /^-+$/.test(c))) return '';
        const tag = cells[0].startsWith('**') ? 'th' : 'td';
        return '<tr>' + cells.map(c => '<' + tag + '>' + c.replace(/\\*\\*/g, '') + '</' + tag + '>').join('') + '</tr>';
      });
      html = html.replace(/(<tr>.*<\\/tr>\\n?)+/g, '<table>$&</table>');
      // 段落
      html = html.replace(/\\n\\n/g, '</p><p>');
      html = '<p>' + html + '</p>';
      html = html.replace(/<p><\\/p>/g, '');
      html = html.replace(/<p>(<h[123]>)/g, '$1');
      html = html.replace(/(<\\/h[123]>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<ul>)/g, '$1');
      html = html.replace(/(<\\/ul>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<table>)/g, '$1');
      html = html.replace(/(<\\/table>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<pre>)/g, '$1');
      html = html.replace(/(<\\/pre>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<hr>)/g, '$1');
      html = html.replace(/(<hr>)<\\/p>/g, '$1');
      html = html.replace(/<p>(<blockquote>)/g, '$1');
      html = html.replace(/(<\\/blockquote>)<\\/p>/g, '$1');
      
      return html;
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function logout() {
      fetch('/api/logout', { method: 'POST' }).then(() => location.href = '/');
    }
    
    loadDocs();
  </script>
</body>
</html>`;

// 文档库页面 HTML（基于档案馆模板，改 source=docs）
const DOCS_HTML = ARCHIVE_HTML
  .replace('<title>档案馆 - 枢纽</title>', '<title>文档库 - 枢纽</title>')
  .replace('<a href="/archive" class="nav-link active">📜 档案馆</a>', '<a href="/archive" class="nav-link">📜 档案馆</a>')
  .replace('<a href="/docs" class="nav-link">📖 文档库</a>', '<a href="/docs" class="nav-link active">📖 文档库</a>')
  .replace('<h1>📜 档案馆</h1>', '<h1>📖 文档库</h1>')
  .replace('治理层文档 — 组织核心文件', '工作层文档 — Runbooks / Specs / Templates')
  .replace("fetch('/api/docs?source=archive&lang=' + currentLang)", "fetch('/api/docs?source=docs&lang=' + currentLang)");

// 获取所有消息（带缓存 + 限制条数）
async function getMessages() {
  // 缓存检查
  if (msgCache.data && Date.now() - msgCache.time < CACHE_TTL) {
    return msgCache.data;
  }
  
  try {
    const client = await getRedisClient();
    // 使用 XREVRANGE + LIMIT 获取最新消息，避免全量扫描
    const serinaMsgs = await client.xRevRange('serina:messages', '+', '-', { COUNT: MSG_LIMIT });
    const cortanaMsgs = await client.xRevRange('cortana:messages', '+', '-', { COUNT: MSG_LIMIT });
    const rolandMsgs = await client.xRevRange('roland:messages', '+', '-', { COUNT: MSG_LIMIT });
    const bossMsgs = await client.xRevRange('boss:messages', '+', '-', { COUNT: MSG_LIMIT });
    
    const allMsgs = [];
    const seen = new Set();
    
    function addMsg(m) {
      const key = `${m.message.from}:${m.message.timestamp}:${m.message.content}`;
      if (seen.has(key)) return;
      seen.add(key);
      allMsgs.push({
        id: m.id, from: m.message.from, to: m.message.to,
        content: m.message.content, timestamp: m.message.timestamp || m.id.split('-')[0]
      });
    }
    
    for (const m of serinaMsgs) addMsg(m);
    for (const m of cortanaMsgs) addMsg(m);
    for (const m of rolandMsgs) addMsg(m);
    for (const m of bossMsgs) addMsg(m);
    
    allMsgs.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
    
    const result = { messages: allMsgs };
    msgCache = { data: result, time: Date.now() };
    return result;
  } catch (e) {
    console.error('[getMessages] 失败:', e.message);
    return { error: e.message };
  }
}

// 发送消息到 Redis
async function sendToRedis(from, to, content) {
  try {
    const client = await getRedisClient();
    const timestamp = Date.now().toString();
    let targets;
    if (to === 'all') {
      targets = ['serina', 'cortana', 'roland'];
    } else {
      targets = to.split(',').filter(t => ['serina', 'cortana', 'roland'].includes(t));
      if (targets.length === 0) targets = ['serina', 'cortana', 'roland'];
    }
    
    // to 字段包含所有收件人
    const toField = targets.join(', ');
    
    for (const target of targets) {
      await client.xAdd(`${target}:messages`, '*', {
        from, to: toField, content, timestamp
      });
    }
    // 清除缓存，让下次查询能看到新消息
    msgCache = { data: null, time: 0 };
    return true;
  } catch (e) {
    console.error('[sendToRedis] 失败:', e.message);
    return false;
  }
}

// 解析 POST body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { resolve({}); }
    });
  });
}

// HTTP 服务器
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  
  // API: 请求验证码
  if (pathname === '/api/request-code' && req.method === 'POST') {
    const code = generateCode();
    loginCodes.set(code, { expires: Date.now() + 5 * 60 * 1000, used: false });
    
    // 通知 Serina 发送钉钉消息
    const sent = await notifyCortana(`[登录验证码] 赵博正在登录枢纽平台，验证码：${code}（5分钟内有效，请转发给老板）`);
    
    res.setHeader('Content-Type', 'application/json');
    if (sent) {
      res.end(JSON.stringify({ success: true }));
    } else {
      res.end(JSON.stringify({ success: false, error: '发送失败，请稍后重试' }));
    }
    return;
  }
  
  // API: 验证码登录
  if (pathname === '/api/verify-code' && req.method === 'POST') {
    const { code } = await parseBody(req);
    const codeData = loginCodes.get(code);
    
    res.setHeader('Content-Type', 'application/json');
    
    if (!codeData) {
      res.end(JSON.stringify({ success: false, error: '验证码不存在' }));
      return;
    }
    
    if (codeData.used) {
      res.end(JSON.stringify({ success: false, error: '验证码已使用' }));
      return;
    }
    
    if (Date.now() > codeData.expires) {
      loginCodes.delete(code);
      res.end(JSON.stringify({ success: false, error: '验证码已过期' }));
      return;
    }
    
    // 标记已使用
    codeData.used = true;
    
    // 创建会话（存到 Redis）
    const sessionId = await createSession('boss');
    if (!sessionId) {
      res.end(JSON.stringify({ success: false, error: '创建会话失败' }));
      return;
    }
    
    res.setHeader('Set-Cookie', `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400`);
    res.end(JSON.stringify({ success: true }));
    return;
  }
  
  // API: 登出
  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.session) {
      await deleteSession(cookies.session);
    }
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
    return;
  }
  
  // API: 获取消息（需要登录）
  if (pathname === '/api/messages') {
    const user = await checkAuth(req);
    if (!user) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    
    res.setHeader('Content-Type', 'application/json');
    const data = await getMessages();
    res.end(JSON.stringify(data));
    return;
  }
  
  // API: 发送消息（需要登录）
  if (pathname === '/api/send' && req.method === 'POST') {
    const user = await checkAuth(req);
    if (!user) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    
    const { content, target } = await parseBody(req);
    
    if (!content || !target) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: '参数错误' }));
      return;
    }
    
    const sent = await sendToRedis('boss', target, content);
    
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: sent }));
    return;
  }
  
  // 只读 API token 验证（用于无登录态的档案馆访问）
  const DOCS_READ_TOKEN = process.env.DOCS_READ_TOKEN || 'stellaris-docs-readonly-2026';
  function checkDocsAuth(req) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || (req.headers.authorization || '').replace('Bearer ', '');
    if (token === DOCS_READ_TOKEN) return true;
    return checkAuth(req);
  }

  // API: 获取档案列表（登录或只读 token）
  if (pathname === '/api/docs') {
    const authed = await checkDocsAuth(req);
    if (!authed) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    
    let docs = getDocsList(url.searchParams.get('source') || null, url.searchParams.get('lang') || null);
    // 服务端搜索
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    if (q) {
      docs = docs.filter(d => (d.title || '').toLowerCase().includes(q) || (d.filename || '').toLowerCase().includes(q) || (d.category || '').toLowerCase().includes(q) || (d.author || '').toLowerCase().includes(q));
    }
    const status = url.searchParams.get('status');
    if (status) docs = docs.filter(d => d.status && d.status.toLowerCase() === status.toLowerCase());
    const category = url.searchParams.get('category');
    if (category) docs = docs.filter(d => d.category && d.category.toLowerCase() === category.toLowerCase());
    
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ docs, categoryDisplay: CATEGORY_DISPLAY }));
    return;
  }
  
  // API: 按 code 获取文档（/api/doc/SA-001?lang=zh）
  if (pathname.startsWith('/api/doc/') && req.method === 'GET') {
    const authed = await checkDocsAuth(req);
    if (!authed) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const code = decodeURIComponent(pathname.slice('/api/doc/'.length));
    const lang = url.searchParams.get('lang') || 'zh';
    const resolved = resolveByCode(code, lang);
    if (!resolved) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not_found', code }));
      return;
    }
    if (!fs.existsSync(resolved.fullPath)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'file_not_found', code, path: resolved.filePath }));
      return;
    }
    const content = fs.readFileSync(resolved.fullPath, 'utf-8');
    const { meta, body } = parseFrontmatter(content);
    const entry = resolved.entry;
    const repoName = entry.source === 'archive' ? 'stellaris-archive' : 'stellaris-docs';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      code: entry.code,
      doc_id: entry.doc_id,
      source: entry.source,
      status: entry.status,
      lang: resolved.lang,
      missingTranslation: resolved.missingTranslation,
      meta,
      body,
      translations: entry.translations,
      canonical: {
        ui: `/${entry.source === 'archive' ? 'archive' : 'docs'}/${entry.code}`,
        api: `/api/doc/${entry.code}`,
        github: `https://github.com/nescafe2009/${repoName}/blob/main/${resolved.filePath}`
      }
    }));
    return;
  }

  // API: 获取单个档案内容（登录或只读 token）
  if (pathname.startsWith('/api/docs/') && req.method === 'GET') {
    const authed = await checkDocsAuth(req);
    if (!authed) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    
    const filename = decodeURIComponent(pathname.slice('/api/docs/'.length));
    // 安全检查：防止路径遍历（允许子目录斜杠，但拒绝 ..）
    if (filename.includes('..')) {
      res.writeHead(403);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'path_traversal_rejected', code: 403 }));
      return;
    }
    
    const doc = getDocContent(filename);
    if (doc && doc.error) {
      res.writeHead(doc.code || 403);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: doc.error }));
      return;
    }
    if (!doc) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(doc));
    return;
  }
  
  // 档案馆页面（治理层）
  if (pathname === '/archive') {
    const user = await checkAuth(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(user ? ARCHIVE_HTML : LOGIN_HTML);
    return;
  }

  // 文档库页面（工作层）
  if (pathname === '/docs') {
    const user = await checkAuth(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(user ? DOCS_HTML : LOGIN_HTML);
    return;
  }

  // 按 code 访问文档（/archive/SA-001 或 /docs/SD-001）
  const codeMatch = pathname.match(/^\/(archive|docs)\/([A-Z]{2}-\d{3})$/);
  if (codeMatch) {
    const user = await checkAuth(req);
    if (!user) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(LOGIN_HTML);
      return;
    }
    const code = codeMatch[2];
    const lang = url.searchParams.get('lang') || 'zh';
    const resolved = resolveByCode(code, lang);
    if (!resolved || !fs.existsSync(resolved.fullPath)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<html><body style="background:#1a1a2e;color:#eee;font-family:sans-serif;padding:40px"><h1>404</h1><p>文档 ${code} 未找到</p><a href="/${codeMatch[1]}" style="color:#00d4ff">返回</a></body></html>`);
      return;
    }
    const content = fs.readFileSync(resolved.fullPath, 'utf-8');
    const { meta, body } = parseFrontmatter(content);
    const entry = resolved.entry;
    const otherLangs = Object.keys(entry.translations).filter(l => l !== resolved.lang);
    const langSwitchHtml = otherLangs.map(l => `<a href="/${codeMatch[1]}/${code}?lang=${l}" style="color:#00d4ff;margin-left:10px">${l === 'zh' ? '中文' : 'English'}</a>`).join('');
    const missingNote = resolved.missingTranslation ? `<div style="background:#553300;padding:8px 12px;border-radius:6px;margin-bottom:15px;color:#ffaa00">⚠️ Missing translation for "${lang}". Showing "${resolved.lang}" version.</div>` : '';
    // 简单 markdown 渲染（复用已有逻辑）
    const htmlBody = body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:#2a2a4e;padding:2px 6px;border-radius:3px">$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '<br><br>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${code} - ${meta.title || entry.doc_id}</title>
<style>body{background:#1a1a2e;color:#eee;font-family:-apple-system,sans-serif;padding:20px 40px;max-width:900px;margin:0 auto}
a{color:#00d4ff}h1,h2,h3{color:#00d4ff;margin-top:20px}code{background:#2a2a4e;padding:2px 6px;border-radius:3px}
.meta{color:#888;font-size:13px;margin-bottom:20px}.nav{margin-bottom:20px}li{margin:4px 0}</style></head><body>
<div class="nav"><a href="/${codeMatch[1]}">← 返回${codeMatch[1] === 'archive' ? '档案馆' : '文档库'}</a>${langSwitchHtml}</div>
<div class="meta">${code} | ${entry.doc_id} | ${entry.status} | ${resolved.lang}</div>
${missingNote}
<div class="content">${htmlBody}</div></body></html>`);
    return;
  }
  
  // 主页面
  const user = await checkAuth(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(user ? CHAT_HTML : LOGIN_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`枢纽平台 v6 running at http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[${signal}] 正在关闭...`);
  
  server.close(() => {
    console.log('[Server] HTTP 服务已关闭');
  });
  
  if (redisClient) {
    try {
      await redisClient.quit();
      console.log('[Redis] 连接已关闭');
    } catch (e) {
      console.error('[Redis] 关闭失败:', e.message);
    }
  }
  
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdown('uncaughtException');
});
