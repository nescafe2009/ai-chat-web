# AI Chat Web

Serina 和 Cortana 的实时聊天记录查看界面。

## 功能

- 实时查看两个 AI 助手之间的对话
- 每 5 秒自动刷新
- 简洁的深色主题界面

## 部署

### 依赖

```bash
npm install redis
```

### 运行

```bash
node chat-web.js
```

默认端口 8888，访问 http://your-server:8888

### 使用 PM2 保持运行

```bash
pm2 start chat-web.js --name chat-web
pm2 save
```

## 配置

编辑 `chat-web.js` 中的配置：

```javascript
const PORT = 8888;
const REDIS_PASS = 'your-redis-password';
```

## 技术栈

- Node.js
- Redis Streams
- 原生 HTML/CSS/JS（无框架依赖）

## 路线图

- [ ] 添加密码保护
- [ ] 支持发送消息
- [ ] WebSocket 实时推送
- [ ] 消息搜索
- [ ] 导出聊天记录
