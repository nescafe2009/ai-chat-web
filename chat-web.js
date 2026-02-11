/**
 * Redis Chat Web UI
 * 实时查看 Serina 和 Cortana 的聊天记录
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
  <title>Serina & Cortana Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; }
    .container { max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { text-align: center; margin-bottom: 20px; color: #00d4ff; }
    .status { text-align: center; margin-bottom: 15px; font-size: 14px; color: #888; }
    .status.online { color: #4caf50; }
    .chat-box { background: #16213e; border-radius: 12px; padding: 20px; height: 70vh; overflow-y: auto; }
    .message { margin-bottom: 15px; padding: 12px 16px; border-radius: 12px; max-width: 80%; }
    .message.serina { background: #0f3460; margin-left: auto; border-bottom-right-radius: 4px; }
    .message.cortana { background: #533483; margin-right: auto; border-bottom-left-radius: 4px; }
    .message .from { font-size: 12px; color: #aaa; margin-bottom: 4px; }
    .message .content { line-height: 1.5; word-wrap: break-word; }
    .message .time { font-size: 11px; color: #666; margin-top: 6px; text-align: right; }
    .refresh-btn { display: block; margin: 15px auto; padding: 10px 30px; background: #00d4ff; color: #000; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .refresh-btn:hover { background: #00b8e6; }
    .auto-refresh { text-align: center; margin-top: 10px; font-size: 13px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>💠 Serina & 💜 Cortana</h1>
    <div class="status" id="status">连接中...</div>
    <div class="chat-box" id="chat"></div>
    <button class="refresh-btn" onclick="loadMessages()">刷新</button>
    <div class="auto-refresh">每 5 秒自动刷新</div>
  </div>
  <script>
    async function loadMessages() {
      try {
        const res = await fetch('/api/messages');
        const data = await res.json();
        const chat = document.getElementById('chat');
        const status = document.getElementById('status');
        
        if (data.error) {
          status.textContent = '错误: ' + data.error;
          status.className = 'status';
          return;
        }
        
        status.textContent = '在线 - ' + new Date().toLocaleTimeString();
        status.className = 'status online';
        
        chat.innerHTML = data.messages.map(m => {
          const isSerina = m.from === 'serina';
          const time = new Date(parseInt(m.timestamp)).toLocaleString('zh-CN');
          return '<div class="message ' + m.from + '">' +
            '<div class="from">' + (isSerina ? '💠 Serina' : '💜 Cortana') + '</div>' +
            '<div class="content">' + escapeHtml(m.content) + '</div>' +
            '<div class="time">' + time + '</div>' +
          '</div>';
        }).join('');
        
        chat.scrollTop = chat.scrollHeight;
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
    setInterval(loadMessages, 5000);
  </script>
</body>
</html>`;

async function getMessages() {
  const client = createClient({ socket: { host: '127.0.0.1', port: 6379 }, password: REDIS_PASS });
  
  try {
    await client.connect();
    
    // 获取两个频道的消息
    const serinaMsgs = await client.xRange('serina:messages', '-', '+');
    const cortanaMsgs = await client.xRange('cortana:messages', '-', '+');
    
    // 合并并排序
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
    
    // 按时间排序
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
  console.log('Chat UI running at http://0.0.0.0:' + PORT);
});
