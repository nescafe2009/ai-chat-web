#!/usr/bin/env node
/**
 * Hub/Main handler helper (Option B)
 *
 * Purpose:
 * - Parse the Hub envelope from wakeText (EGRESS_LOCK/REPLY_TO/REPLY_STREAM/REQ_ID)
 * - Enforce REQ_ID idempotency (local state file)
 * - Provide a single command to write a final reply back to Redis (reply-to-origin)
 * - On failures, write a visible ERROR entry back to Redis (never silent)
 *
 * Notes:
 * - This script does NOT call the LLM. It is a mechanical helper for the main session.
 * - To avoid duplicating Redis secrets, it reuses scripts/redis-chat.js.
 */

const fs = require('fs');
const path = require('path');

const { sendMessage } = require('./redis-chat');

function usage() {
  console.log(`Usage:
  node scripts/hub-main-handler.js --wake-file <path> --reply "..."
  echo "$WAKE_TEXT" | node scripts/hub-main-handler.js --reply "..."

Options:
  --wake-file <path>     Read wakeText from a file
  --state-file <path>    Default: memory/hub-handler-state.json
  --reply "..."          Content to send as the final reply
  --dry-run              Parse + show envelope, do not send
`);
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseEnvelope(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim();
    out[k] = v;
  }

  const egressLock = out.EGRESS_LOCK;
  const replyStream = out.REPLY_STREAM;
  const replyTo = out.REPLY_TO;
  const reqId = out.REQ_ID;

  return { raw: out, egressLock, replyStream, replyTo, reqId };
}

function loadState(stateFile) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { handled: {} };
    if (!parsed.handled || typeof parsed.handled !== 'object') parsed.handled = {};
    return parsed;
  } catch (e) {
    if (e && e.code === 'ENOENT') return { handled: {} };
    return { handled: {} };
  }
}

function saveStateAtomic(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, stateFile);
}

async function writeVisibleError({ replyTo, replyStream, reqId, errorMessage }) {
  const content = `[ERROR] req_id=${reqId || 'unknown'} ${errorMessage}`;
  // Keep "type" different from normal text so UI/operators can spot it.
  await sendMessage(content, replyTo || 'boss', 'error', replyStream);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(0);
  }

  let wakeFile;
  let stateFile = path.join(process.cwd(), 'memory/hub-handler-state.json');
  let reply;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--wake-file') wakeFile = args[++i];
    else if (a === '--state-file') stateFile = args[++i];
    else if (a === '--reply') reply = args[++i];
    else if (a === '--dry-run') dryRun = true;
  }

  let wakeText = '';
  if (wakeFile) wakeText = fs.readFileSync(wakeFile, 'utf8');
  else if (!process.stdin.isTTY) wakeText = await readAllStdin();
  else if (process.env.WAKE_TEXT) wakeText = process.env.WAKE_TEXT;

  const env = parseEnvelope(wakeText);
  if (env.egressLock && env.egressLock !== 'redis') {
    console.error(`Refusing to handle: EGRESS_LOCK=${env.egressLock} (expected redis)`);
    process.exit(2);
  }

  if (!env.reqId || !env.replyTo || !env.replyStream) {
    const msg = `Missing envelope fields (need REQ_ID/REPLY_TO/REPLY_STREAM). Got: REQ_ID=${env.reqId || ''} REPLY_TO=${env.replyTo || ''} REPLY_STREAM=${env.replyStream || ''}`;
    console.error(msg);
    await writeVisibleError({ replyTo: env.replyTo, replyStream: env.replyStream, reqId: env.reqId, errorMessage: msg });
    process.exit(2);
  }

  const state = loadState(stateFile);
  if (state.handled[env.reqId]) {
    console.log(`Already handled req_id=${env.reqId}; skipping final reply.`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(JSON.stringify({ envelope: env, stateFile }, null, 2));
    process.exit(0);
  }

  if (!reply) {
    const msg = 'Missing --reply. This helper only sends the final reply when explicitly provided.';
    console.error(msg);
    await writeVisibleError({ replyTo: env.replyTo, replyStream: env.replyStream, reqId: env.reqId, errorMessage: msg });
    process.exit(2);
  }

  try {
    const finalContent = String(reply);
    const msgId = await sendMessage(finalContent, env.replyTo, 'text', env.replyStream);
    state.handled[env.reqId] = {
      at: Date.now(),
      replyTo: env.replyTo,
      replyStream: env.replyStream,
      msgId
    };
    saveStateAtomic(stateFile, state);
    console.log(`Final reply written: req_id=${env.reqId} msgId=${msgId}`);
  } catch (e) {
    const msg = `Write-back failed: ${e && e.message ? e.message : String(e)}`;
    console.error(msg);
    await writeVisibleError({ replyTo: env.replyTo, replyStream: env.replyStream, reqId: env.reqId, errorMessage: msg });
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
