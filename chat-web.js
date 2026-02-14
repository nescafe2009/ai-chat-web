/**
 * Redis Chat Web UI v3
 * 改进：左侧日期选择器 + 右侧消息列表
 */

const http = require('http');
const { createClient } = require('redis');

const PORT = 8888;
const REDIS_PASS = 'SerinaCortana2026!';

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Serina & Cortana & Roland Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; height: 100vh; overflow: hidden; }
    
    .container { display: flex; height: 100vh; }
    
    /* 左侧日期选择器 */
    .sidebar { width: 180px; background: #0f0f23; border-right: 1px solid #333; display: flex; flex-direction: column; }
    .sidebar-header { padding: 15px; text-align: center; border-bottom: 1px solid #333; }
    .sidebar-header h2 { font-size: 14px; color: #00d4ff; }
    .date-list { flex: 1; overflow-y: auto; padding: 10px 0; }
    .date-item { padding: 10px 15px; cursor: pointer; border-left: 3px solid transparent; transition: all 0.2s; }
    .date-item:hover { background: #1a1a3e; }
    .date-item.active { background: #1a1a3e; border-left-color: #00d4ff; }
    .date-item .date-label { font-size: 14px; color: #eee; }
    .date-item .msg-count { font-size: 11px; color: #666; margin-top: 2px; }
    
    /* 右侧主内容 */
    .main { flex: 1; display: flex; flex-direction: column; }
    .header { padding: 15px 20px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 18px; color: #00d4ff; }
    .status { font-size: 13px; color: #888; }
    .status.online { color: #4caf50; }
    
    .chat-box { flex: 1; overflow-y: auto; padding: 20px; background: #16213e; }
    .message { margin-bottom: 15px; padding: 12px 16px; border-radius: 12px; max-width: 85%; }
    .message.serina { background: #0f3460; margin-left: auto; border-bottom-right-radius: 4px; }
    .message.cortana { background: #533483; margin-right: auto; border-bottom-left-radius: 4px; }
    .message.roland { background: #1e5128; margin-right: auto; border-bottom-left-radius: 4px; }
    .message .from { font-size: 12px; color: #aaa; margin-bottom: 4px; }
    .message .content { line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; }
    .message .time { font-size: 11px; color: #666; margin-top: 6px; text-align: right; }
    
    .controls { padding: 15px 20px; border-top: 1px solid #333; display: flex; gap: 10px; align-items: center; }
    .refresh-btn { padding: 8px 20px; background: #00d4ff; color: #000; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .refresh-btn:hover { background: #00b8e6; }
    .auto-status { font-size: 12px; color: #666; margin-left: auto; }
    .auto-status.paused { color: #ff9800; }
    
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
    </div>
    <div class="main">
      <div class="header">
        <h1>💠 Serina & 💜 Cortana & 🌿 Roland</h1>
        <div class="status" id="status">连接中...</div>
      </div>
      <div class="chat-box" id="chat"></div>
      <div class="controls">
        <button class="refresh-btn" onclick="loadMessages()">刷新</button>
        <span class="auto-status" id="autoStatus">每 10 秒自动刷新</span>
      </div>
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
      updateAutoStatus();
    });
    
    function updateAutoStatus() {
      const el = document.getElementById('autoStatus');
      if (userScrolling) {
        el.textContent = '自动滚动已暂停';
        el.className = 'auto-status paused';
      } else {
        el.textContent = '每 10 秒自动刷新';
        el.className = 'auto-status';
      }
    }
    
    function getDateKey(timestamp) {
      const d = new Date(parseInt(timestamp));
      return d.toISOString().split('T')[0]; // YYYY-MM-DD
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
      return from;
    }
    
    function renderDateList() {
      const dateList = document.getElementById('dateList');
      const sortedDates = Object.keys(dateGroups).sort().reverse(); // 最新在上
      
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
    
    function renderMessages() {
      if (!selectedDate || !dateGroups[selectedDate]) {
        chat.innerHTML = '<div class="empty-state">选择左侧日期查看消息</div>';
        return;
      }
      
      const msgs = dateGroups[selectedDate];
      chat.innerHTML = msgs.map(m => {
        const time = new Date(parseInt(m.timestamp)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return '<div class="message ' + m.from + '">' +
          '<div class="from">' + getIcon(m.from) + '</div>' +
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
        
        // 按日期分组
        dateGroups = {};
        for (const m of allMessages) {
          const key = getDateKey(m.timestamp);
          if (!dateGroups[key]) dateGroups[key] = [];
          dateGroups[key].push(m);
        }
        
        // 默认选中最新日期
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
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    loadMessages();
    setInterval(loadMessages, 10000);
  </script>
</body>
</html>`;

async function getMessages() {
  const client = createClient({ socket: { host: '127.0.0.1', port: 6379 }, password: REDIS_PASS });
  
  try {
    await client.connect();
    
    const serinaMsgs = await client.xRange('serina:messages', '-', '+');
    const cortanaMsgs = await client.xRange('cortana:messages', '-', '+');
    const rolandMsgs = await client.xRange('roland:messages', '-', '+');
    
    const allMsgs = [];
    
    for (const m of serinaMsgs) {
      allMsgs.push({
        id: m.id,
        from: m.message.from,
        to: m.message.to,
        content: m.message.content,
        timestamp: m.message.timestamp || m.id.split('-')[0]
      });
    }
    
    for (const m of cortanaMsgs) {
      allMsgs.push({
        id: m.id,
        from: m.message.from,
        to: m.message.to,
        content: m.message.content,
        timestamp: m.message.timestamp || m.id.split('-')[0]
      });
    }
    
    for (const m of rolandMsgs) {
      allMsgs.push({
        id: m.id,
        from: m.message.from,
        to: m.message.to,
        content: m.message.content,
        timestamp: m.message.timestamp || m.id.split('-')[0]
      });
    }
    
    allMsgs.sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
    
    await client.quit();
    return { messages: allMsgs };
  } catch (e) {
    if (client) try { await client.quit(); } catch (e) {}
    return { error: e.message };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/messages') {
    res.setHeader('Content-Type', 'application/json');
    const data = await getMessages();
    res.end(JSON.stringify(data));
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(HTML);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Chat UI v3 running at http://0.0.0.0:' + PORT);
});
