/**
 * openclaw-channel-nexus - Nexus Hub 2.0 Channel Plugin
 *
 * 订阅 hub2d SSE，通过 Gateway HTTP API dispatch inbound，
 * 拿到回复后 POST /v1/replies 回写。
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";

interface NexusConfig {
  enabled?: boolean;
  hub2dUrl?: string;
  roomId?: string;
  agentName?: string;
  longTextThreshold?: number;
  gatewayPort?: number;
  gatewayToken?: string;
  gatewayTimeoutMs?: number; // callGateway hard timeout, default 60000
}

const DEFAULT_HUB2D_URL = "http://127.0.0.1:9800";
const DEFAULT_ROOM_ID = "general";
const DEFAULT_AGENT_NAME = "serina";
const DEFAULT_LONG_TEXT = 4000;
const DEFAULT_GATEWAY_TIMEOUT_MS = 60000;

const meta = {
  id: "nexus",
  label: "Nexus",
  selectionLabel: "Nexus Hub 2.0",
  detailLabel: "Nexus Hub",
  docsPath: "/channels/nexus",
  blurb: "Multi-agent communication hub with SSE + SQLite persistence.",
};

let sseAbort: AbortController | null = null;
let lastEventId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

let pluginConfig: NexusConfig = {};
let gatewayPort = 18789;
let gatewayToken = "";
let gatewayTimeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS;
let runtimeApi: any = null;

function log(msg: string) {
  console.log(`[nexus] ${msg}`);
}

// ===== Gateway HTTP dispatch =====

const GATEWAY_TIMEOUT_MS = 60000; // legacy constant, actual value from gatewayTimeoutMs

async function callGateway(userContent: string, sessionKey: string): Promise<string> {
  const url = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;

  const timeoutMs = gatewayTimeoutMs || DEFAULT_GATEWAY_TIMEOUT_MS;
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      signal: abort.signal,
      body: JSON.stringify({
        model: "default",
        messages: [{ role: "user", content: userContent }],
        stream: false,
        user: sessionKey,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      const code = `http_${resp.status}`;
      throw Object.assign(new Error(`Gateway ${resp.status}: ${errText.slice(0, 200)}`), { code });
    }

    let data: any;
    try {
      data = await resp.json();
    } catch (jsonErr: any) {
      throw Object.assign(new Error("Gateway response JSON parse failed"), { code: "invalid_json" });
    }

    return data.choices?.[0]?.message?.content || "(no reply)";
  } catch (e: any) {
    if (e.name === "AbortError") {
      throw Object.assign(
        new Error(`[ERROR] gateway_timeout_${Math.round(timeoutMs / 1000)}s`),
        { code: `gateway_timeout_${Math.round(timeoutMs / 1000)}s` }
      );
    }
    // 保留已分类的 code，未分类的归为 fetch_error
    if (!e.code) e.code = "fetch_error";
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===== Hub2d helpers =====

async function postReply(hub2dUrl: string, body: Record<string, any>) {
  const resp = await fetch(`${hub2dUrl}/v1/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST /v1/replies failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

// ===== SSE connection =====

function connectSSE(config: NexusConfig, ctx: any) {
  const hub2dUrl = config.hub2dUrl || DEFAULT_HUB2D_URL;
  const agentName = config.agentName || DEFAULT_AGENT_NAME;

  if (sseAbort) sseAbort.abort();
  sseAbort = new AbortController();

  const url = new URL(`${hub2dUrl}/v1/events`);
  if (lastEventId) url.searchParams.set("last_event_id", lastEventId);
  url.searchParams.set("to", agentName);

  log(`SSE connecting: ${url.toString()}`);

  fetch(url.toString(), {
    signal: sseAbort.signal,
    headers: { Accept: "text/event-stream" },
  })
    .then(async (resp) => {
      if (!resp.ok || !resp.body) {
        throw new Error(`SSE connect failed: ${resp.status}`);
      }

      log("SSE connected");
      reconnectDelay = 1000;

      const snapshot = ctx.getStatus?.() || {};
      ctx.setStatus?.({ ...snapshot, running: true, connected: true, lastConnectedAt: Date.now() });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentId: string | null = null;
        let currentData = "";

        for (const line of lines) {
          if (line.startsWith("id: ")) {
            currentId = line.slice(4).trim();
          } else if (line.startsWith("data: ")) {
            currentData += line.slice(6);
          } else if (line === "" && currentData) {
            if (currentId) lastEventId = currentId;
            try {
              await handleEvent(JSON.parse(currentData), config, ctx);
            } catch (e: any) {
              log(`Event handle error: ${e.message}`);
            }
            currentData = "";
            currentId = null;
          }
        }
      }

      log("SSE stream ended, reconnecting...");
      scheduleReconnect(config, ctx);
    })
    .catch((e: any) => {
      if (e.name === "AbortError") return;
      log(`SSE error: ${e.message}, reconnecting in ${reconnectDelay}ms`);
      scheduleReconnect(config, ctx);
    });
}

function scheduleReconnect(config: NexusConfig, ctx: any) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const snapshot = ctx.getStatus?.() || {};
  ctx.setStatus?.({ ...snapshot, connected: false });
  reconnectTimer = setTimeout(() => connectSSE(config, ctx), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// ===== Inbound event handler =====

async function handleEvent(event: any, config: NexusConfig, ctx: any) {
  const agentName = config.agentName || DEFAULT_AGENT_NAME;
  const hub2dUrl = config.hub2dUrl || DEFAULT_HUB2D_URL;
  const threshold = config.longTextThreshold || DEFAULT_LONG_TEXT;

  // 跳过自己发的消息和回复
  if (event.from === agentName || event.is_reply) return;

  log(`Inbound: event_id=${event.event_id} from=${event.from} room=${event.room_id} len=${event.content?.length}`);

  const snapshot = ctx.getStatus?.() || {};
  ctx.setStatus?.({ ...snapshot, lastInboundAt: Date.now(), lastEventAt: Date.now() });

  const startMs = Date.now();

  try {
    let content = event.content || "";
    const origLen = content.length;
    const wasTruncated = origLen > threshold;
    if (wasTruncated) {
      content = content.substring(0, threshold) +
        ` [TRUNCATED orig_len=${origLen} kept=${threshold}]`;
      log(`Content truncated: orig=${origLen} kept=${threshold}`);
    }

    // 构建 session key: nexus:<room_id>:<from>
    const sessionKey = `nexus:${event.room_id || "general"}:${event.from}`;

    // 通过 Gateway HTTP API dispatch
    const replyText = await callGateway(content, sessionKey);
    const latencyMs = Date.now() - startMs;

    // 回写 hub2d
    await postReply(hub2dUrl, {
      event_id: event.event_id,
      room_id: event.room_id,
      text: replyText,
      status: "ok",
      latency_ms: latencyMs,
      truncated: wasTruncated,
      orig_len: wasTruncated ? origLen : undefined,
    });

    log(`Reply sent: event_id=${event.event_id} latency=${latencyMs}ms len=${replyText.length}`);
  } catch (e: any) {
    const latencyMs = Date.now() - startMs;
    const errCode: string = e.code || "unknown_error";
    log(`Error processing event ${event.event_id}: [${errCode}] ${e.message}`);

    try {
      await postReply(hub2dUrl, {
        event_id: event.event_id,
        room_id: event.room_id,
        text: `[ERROR] ${errCode}: ${e.message?.slice(0, 200) || "unknown"}`,
        status: "error",
        latency_ms: latencyMs,
        error: errCode,
      });
    } catch (e2: any) {
      log(`Failed to write error reply: ${e2.message}`);
    }
  }
}

// ===== Plugin definition =====

const nexusPlugin: ChannelPlugin<NexusConfig> = {
  id: "nexus",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: true,
    media: false,
    nativeCommands: false,
  },
  reload: { configPrefixes: ["channels.nexus"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg: any) => {
      const raw = (cfg.channels?.nexus ?? {}) as NexusConfig;
      return raw;
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account: NexusConfig) => Boolean(account.hub2dUrl?.trim()),
    describeAccount: (account: NexusConfig) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account.enabled ?? true,
      configured: Boolean(account.hub2dUrl?.trim()),
    }),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastInboundAt: null,
      lastEventAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }: any) => ({
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: account.enabled ?? true,
      configured: Boolean(account.hub2dUrl?.trim()),
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastEventAt: runtime?.lastEventAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async ({ text, threadId }: any) => {
      const hub2dUrl = pluginConfig.hub2dUrl || DEFAULT_HUB2D_URL;
      const agentName = pluginConfig.agentName || DEFAULT_AGENT_NAME;
      const roomId = threadId || pluginConfig.roomId || DEFAULT_ROOM_ID;

      const resp = await fetch(`${hub2dUrl}/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room_id: roomId, from: agentName, to: null, content: text }),
      });

      if (!resp.ok) throw new Error(`send failed: ${resp.status}`);
      const data: any = await resp.json();
      return { channel: "nexus", messageId: data.event_id || `nexus-${Date.now()}` };
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      pluginConfig = ctx.account || {};
      // 从 OpenClaw config 读取 gateway port 和 auth token
      gatewayPort = ctx.cfg?.gateway?.port || 18789;
      gatewayToken = ctx.cfg?.gateway?.auth?.token || "";
      gatewayTimeoutMs = pluginConfig.gatewayTimeoutMs || DEFAULT_GATEWAY_TIMEOUT_MS;
      connectSSE(pluginConfig, ctx);
      log(`Nexus channel started (gatewayTimeoutMs=${gatewayTimeoutMs})`);
    },
    stopAccount: async () => {
      if (sseAbort) sseAbort.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      sseAbort = null;
      reconnectTimer = null;
      log("Nexus channel stopped");
    },
  },
};

export default function register(api: any) {
  runtimeApi = api;
  api.registerChannel({ plugin: nexusPlugin });
  log("Nexus channel plugin registered");
}

export { nexusPlugin };
