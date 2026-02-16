/**
 * Redis Chat Web UI v5
 * 修复：连接泄漏、增量拉取、graceful shutdown
 */

const http = require('http');
const crypto = require('crypto');
const { createClient } = require('redis');

// 配置（支持环境变量）
const PORT = process.env.PORT || 8888;
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_PASS = process.env.REDIS_PASS || 'SerinaCortana2026!';
const SESSION_TTL = 24 * 60 * 60;
const MSG_LIMIT = 200; // 每个 stream 最多拉取条数

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

// 登录页面 HTML
const LOGIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - AI Chat</title>
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
    <h1>🔐 AI Chat</h1>
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
  <title>AI Chat</title>
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
        <h2>📅 日期</h2>
      </div>
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
      return div.innerHTML;
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
          msgInput.value = val.substring(0, pos) + '\\n' + val.substring(pos);
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
  const path = url.pathname;
  
  // API: 请求验证码
  if (path === '/api/request-code' && req.method === 'POST') {
    const code = generateCode();
    loginCodes.set(code, { expires: Date.now() + 5 * 60 * 1000, used: false });
    
    // 通知 Serina 发送钉钉消息
    const sent = await notifySerina(`[登录验证码] 赵博正在登录 AI Chat 网页，验证码：${code}（5分钟内有效）`);
    
    res.setHeader('Content-Type', 'application/json');
    if (sent) {
      res.end(JSON.stringify({ success: true }));
    } else {
      res.end(JSON.stringify({ success: false, error: '发送失败，请稍后重试' }));
    }
    return;
  }
  
  // API: 验证码登录
  if (path === '/api/verify-code' && req.method === 'POST') {
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
  if (path === '/api/logout' && req.method === 'POST') {
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
  if (path === '/api/messages') {
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
  if (path === '/api/send' && req.method === 'POST') {
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
  
  // 主页面
  const user = await checkAuth(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(user ? CHAT_HTML : LOGIN_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Chat UI v5 running at http://0.0.0.0:${PORT}`);
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
