# Redis Chat Web 规则文档

## 消息路由规则

1. **收件箱原则**：sendto 谁，消息就写入谁的收件箱（stream）
   - 发给 serina → `serina:messages`
   - 发给 cortana → `cortana:messages`
   - 发给 roland → `roland:messages`
   - 发给 boss → `boss:messages`

2. **去重显示**：网站读取所有 stream，合并后按消息 ID 去重

3. **标注格式**：每条消息显示发送方向
   - 单人：`Serina → Boss`
   - 多人：`Serina → Boss, Cortana`

## 现有 Streams

- `serina:messages` - Serina 收件箱
- `cortana:messages` - Cortana 收件箱
- `roland:messages` - Roland 收件箱
- `boss:messages` - 赵博收件箱

## 消息格式

```json
{
  "from": "发送者名称",
  "to": "接收者名称（多人用逗号分隔）",
  "content": "消息内容",
  "timestamp": "毫秒时间戳"
}
```

## 验证码流程

1. 用户点击获取验证码
2. 服务端生成 6 位随机码，存内存（5 分钟过期）
3. 通过 Redis 通知 Serina
4. Serina 通过钉钉发送给赵博
5. 用户输入验证码登录，会话存 Redis（24 小时过期）

## 维护者

- **主要维护**：Serina
- **代码仓库**：https://github.com/nescafe2009/ai-chat-web
- **部署位置**：root@42.192.211.138:/root/redis-chat/chat-web.js
