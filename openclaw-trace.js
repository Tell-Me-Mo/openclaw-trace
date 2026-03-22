#!/usr/bin/env node
// OpenClaw Trace
// Repository: https://github.com/Tell-Me-Mo/openclaw-trace
// Usage: npx openclaw-trace        (foreground)
//        npx openclaw-trace --bg   (background daemon)
'use strict';

// ── Stop: gracefully shut down a running instance ────────────────────────────
if (process.argv.includes('--stop')) {
  const http = require('http');
  const req = http.get('http://127.0.0.1:3141/api/shutdown', (res) => {
    console.log('\n  🦞 OpenClaw Trace stopped\n');
    process.exit(0);
  });
  req.on('error', () => {
    console.log('\n  No running instance found on port 3141\n');
    process.exit(1);
  });
  req.setTimeout(3000, () => { req.destroy(); process.exit(1); });
} else

// ── Background mode: re-spawn as detached process ────────────────────────────
if (process.argv.includes('--bg')) {
  const { spawn } = require('child_process');
  const args = process.argv.slice(1).filter(a => a !== '--bg');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`\n  🦞 OpenClaw Trace running in background (pid ${child.pid})`);
  console.log(`  → http://localhost:3141`);
  console.log(`  Stop: npx openclaw-trace --stop\n`);
  process.exit(0);
}

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 3141;
const OC   = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const SHADOW_DIR = path.join(OC, '.openclaw-trace-shadow');

// ── Session file watcher (preserves heartbeats truncated by OpenClaw) ────────

try { fs.mkdirSync(SHADOW_DIR, { recursive: true }); } catch {}

// Track known file content so we can detect truncation
const fileSnapshots = {}; // filePath -> { lines: number, content: string }

function snapshotFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim() ? content.trim().split('\n').length : 0;
    fileSnapshots[filePath] = { lines, content };
  } catch {}
}

function onFileChanged(filePath) {
  try {
    const newContent = fs.readFileSync(filePath, 'utf8');
    const newLines = newContent.trim() ? newContent.trim().split('\n').length : 0;
    const prev = fileSnapshots[filePath];

    if (prev && newLines < prev.lines) {
      // File was truncated — save the removed entries
      const prevArr = prev.content.trim().split('\n');
      const newArr = newContent.trim() ? newContent.trim().split('\n') : [];
      // The truncated entries are lines that existed before but are gone now
      // OpenClaw resets to the pre-heartbeat state, so removed = prevArr[newArr.length..]
      const removed = prevArr.slice(newArr.length);
      if (removed.length > 0) {
        const agentId = filePath.split(path.sep + 'agents' + path.sep)[1]?.split(path.sep)[0];
        if (agentId) saveShadowEntries(agentId, filePath, removed);
      }
    }
    fileSnapshots[filePath] = { lines: newLines, content: newContent };
  } catch {}
}

function saveShadowEntries(agentId, sourceFile, lines) {
  const shadowFile = path.join(SHADOW_DIR, agentId + '.jsonl');
  try {
    // Deduplicate: check if these entries already exist in shadow
    const existing = new Set();
    try {
      const prev = fs.readFileSync(shadowFile, 'utf8').trim();
      if (prev) prev.split('\n').forEach(l => existing.add(l));
    } catch {}
    const newLines = lines.filter(l => !existing.has(l));
    if (newLines.length > 0) {
      fs.appendFileSync(shadowFile, newLines.join('\n') + '\n');
    }
  } catch {}
}

// Watch all agent session directories for JSONL changes
const watchers = {};
function startWatching() {
  const agentsDir = path.join(OC, 'agents');
  try {
    const agents = fs.readdirSync(agentsDir);
    for (const agent of agents) {
      const sessDir = path.join(agentsDir, agent, 'sessions');
      watchSessionDir(sessDir);
    }
  } catch {}
  // Also watch the agents dir for new agents
  try {
    fs.watch(agentsDir, (ev, filename) => {
      if (filename) {
        const sessDir = path.join(agentsDir, filename, 'sessions');
        watchSessionDir(sessDir);
      }
    });
  } catch {}
}

function watchSessionDir(sessDir) {
  if (watchers[sessDir]) return;
  try {
    // Snapshot existing JSONL files
    const files = fs.readdirSync(sessDir);
    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        snapshotFile(path.join(sessDir, file));
      }
    }
    // Watch for changes
    watchers[sessDir] = fs.watch(sessDir, (ev, filename) => {
      if (filename && filename.endsWith('.jsonl')) {
        const filePath = path.join(sessDir, filename);
        if (fs.existsSync(filePath)) onFileChanged(filePath);
      }
    });
  } catch {}
}

startWatching();

// ── Data ──────────────────────────────────────────────────────────────────────

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readJSONL(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function getAgentMeta() {
  const cfg = readJSON(path.join(OC, 'openclaw.json'));
  const map = {};
  for (const a of (cfg?.agents?.list || [])) {
    map[a.id] = { id: a.id, name: a.identity?.name || a.id, emoji: a.identity?.emoji || '🤖' };
  }
  if (!map['main']) map['main'] = { id: 'main', name: 'main', emoji: '⚡' };
  return map;
}

function extractText(msg) {
  let full;
  if (typeof msg.content === 'string') full = msg.content;
  else if (!Array.isArray(msg.content)) return '';
  else full = msg.content.filter(c => c.type === 'text').map(c => c.text || '').join('');
  return full;
}

function extractToolCalls(msg) {
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter(c => c.type === 'toolCall')
    .map(c => ({ id: c.id || '', name: c.name || '', args: c.arguments || {} }));
}

function shortPath(p) {
  return (p || '')
    .replace(/.*workspace-promo-assistant-[^/]+\//, '')
    .replace(/.*\.openclaw\//, '~/')
    .replace(/\/Users\/[^/]+\//, '~/')
    .slice(0, 45);
}

function describeCall(name, args) {
  if (name === 'browser') {
    const act = args.action || '';
    const req = args.request || {};
    if (act === 'navigate') {
      const u = args.targetUrl || '';
      try { const p = new URL(u).pathname; return 'nav → ' + p.slice(0, 42); } catch { return 'nav → ' + u.slice(0, 42); }
    }
    if (act === 'act') {
      const k = req.kind || '';
      if (k === 'evaluate') return `eval (fn ${(req.fn || '').length}c)`;
      if (k === 'snapshot') return `snapshot${req.selector ? ' [' + req.selector.slice(0, 18) + ']' : ''}`;
      if (k === 'wait') return `wait ${req.timeMs}ms`;
      if (k === 'click') return `click ${req.ref || ''}`;
      if (k === 'type') return `type "${(req.text || '').slice(0, 22)}"`;
      if (k === 'press') return `press ${req.key || ''}`;
      if (k === 'scroll') return `scroll`;
      return `act:${k}`;
    }
    if (act === 'tabs') return 'tabs';
    if (act === 'open') return 'open browser';
    if (act === 'close') return 'close';
    return act || 'browser';
  }
  if (name === 'read')         return shortPath(args.file_path || args.path || '');
  if (name === 'write')        return shortPath(args.file_path || args.path || '');
  if (name === 'edit')         return shortPath(args.file_path || args.path || '');
  if (name === 'glob')         return args.pattern || '';
  if (name === 'grep')         return `/${(args.pattern || '').slice(0, 28)}/`;
  if (name === 'bash')         return (args.command || '').replace(/\s+/g, ' ').slice(0, 50);
  if (name === 'notion_query') return 'notion query';
  if (name === 'notion')       return 'notion';
  if (name === 'slack')        return 'slack';
  return name;
}

function fmtSize(n) {
  if (!n) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
  return n + 'c';
}

function attachToolResult(step, msg) {
  const textParts = Array.isArray(msg.content)
    ? msg.content.filter(c => c.type === 'text').map(c => c.text || '')
    : [String(msg.content || '')];
  const text = textParts.join('');
  const size = text.length;
  step.toolResults = step.toolResults || [];
  step.toolResults.push({
    name:    msg.toolName || '?',
    callId:  msg.toolCallId || '',
    size,
    preview: text.slice(0, 500),
    full:    size > 500 ? text : null,
    isError: msg.isError || false,
  });
  step.resultTotalSize = (step.resultTotalSize || 0) + size;
}

// Sanitize numeric value: ensure it's a finite non-negative number
function safeNum(v) { return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0; }

function parseHeartbeats(entries, sessionFile) {
  const runs = [];
  let cur = null;

  for (let ei = 0; ei < entries.length; ei++) {
    const e = entries[ei];
    const msg = e.message;
    if (!msg?.role) continue;

    if (msg.role === 'toolResult') {
      if (cur?.steps?.length) attachToolResult(cur.steps[cur.steps.length - 1], msg);
      continue;
    }

    if (msg.role === 'user') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const allToolResults = content.length > 0 && content.every(c => c.type === 'toolResult');
      if (allToolResults) {
        if (cur?.steps?.length) {
          for (const c of content) {
            const text = Array.isArray(c.content)
              ? c.content.filter(x => x.type === 'text').map(x => x.text || '').join('')
              : String(c.content || '');
            cur.steps[cur.steps.length - 1].toolResults = cur.steps[cur.steps.length - 1].toolResults || [];
            cur.steps[cur.steps.length - 1].toolResults.push({
              name: c.toolName || '?', callId: c.toolCallId || '',
              size: text.length, preview: text.slice(0, 500), full: text.length > 500 ? text : null, isError: c.isError || false,
            });
            cur.steps[cur.steps.length - 1].resultTotalSize =
              (cur.steps[cur.steps.length - 1].resultTotalSize || 0) + text.length;
          }
        }
        continue;
      }

      if (cur) {
        cur.entryRange.end = ei - 1;
        if (cur.steps?.length || cur.apiErrors > 0) runs.push(finalizeRun(cur));
      }
      cur = {
        startTime:    e.timestamp || msg.timestamp || null,
        endTime:      null,
        durationMs:   null,
        trigger:      extractText(msg),
        steps:        [],
        totalCost:    0,
        totalTokensSum: 0,
        totalOutput:  0,
        finalContext: 0,
        summary:      '',
        sessionFile:  sessionFile || null,
        entryRange:   { start: ei, end: null },
      };
      continue;
    }

    if (msg.role === 'assistant' && cur) {
      const u     = msg.usage;
      const cost  = safeNum(u?.cost?.total);
      const text  = extractText(msg);
      const calls = extractToolCalls(msg);
      const ts    = e.timestamp || msg.timestamp || null;

      const hasContent = text || calls.length > 0;
      if (u && (u.totalTokens > 0 || u.output > 0) || hasContent) {
        cur.steps.push({
          time:             ts,
          output:           safeNum(u?.output),
          cacheRead:        safeNum(u?.cacheRead),
          cacheWrite:       safeNum(u?.cacheWrite),
          totalTokens:      safeNum(u?.totalTokens),
          cost,
          costInput:        safeNum(u?.cost?.input),
          costOutput:       safeNum(u?.cost?.output),
          costCacheRead:    safeNum(u?.cost?.cacheRead),
          costCacheWrite:   safeNum(u?.cost?.cacheWrite),
          toolCalls:        calls,
          toolResults:      [],
          resultTotalSize:  0,
          text,
          model:            msg.model || '',
          durationMs:       null,
        });
        cur.totalCost    += cost;
        cur.totalTokensSum += safeNum(u?.totalTokens);
        cur.totalOutput  += safeNum(u?.output);
        cur.finalContext  = Math.max(cur.finalContext, safeNum(u?.totalTokens));
        cur.endTime       = ts;
        if (text && calls.length === 0) cur.summary = text;
      } else if (u && u.totalTokens === 0 && u.output === 0 && !hasContent) {
        // API error — empty response (rate limit, overloaded, or transient failure)
        cur.apiErrors = (cur.apiErrors || 0) + 1;
        cur.endTime = ts;
      }
    }
  }
  if (cur?.steps?.length) { cur.entryRange.end = entries.length - 1; runs.push(finalizeRun(cur)); }
  // Also push runs with only API errors (no successful steps)
  if (cur && !cur.steps.length && cur.apiErrors > 0) { cur.entryRange.end = entries.length - 1; runs.push(finalizeRun(cur)); }
  return runs.reverse();
}

function finalizeRun(r) {
  if (r.startTime && r.endTime)
    r.durationMs = new Date(r.endTime) - new Date(r.startTime);

  // Calculate step durations
  for (let i = 0; i < r.steps.length - 1; i++) {
    const cur = r.steps[i];
    const nxt = r.steps[i + 1];
    if (cur.time && nxt.time) {
      cur.durationMs = new Date(nxt.time) - new Date(cur.time);
    }
  }
  // Last step: use endTime
  if (r.steps.length > 0 && r.endTime) {
    const last = r.steps[r.steps.length - 1];
    if (last.time && !last.durationMs) {
      last.durationMs = new Date(r.endTime) - new Date(last.time);
    }
  }

  // Error count (tool errors + API errors)
  r.apiErrors = r.apiErrors || 0;
  r.errorCount = r.steps.reduce((sum, s) =>
    sum + (s.toolResults?.filter(tr => hasError(tr)).length || 0), 0) + r.apiErrors;

  // Browser action breakdown
  const browserBreakdown = {};
  for (const s of r.steps) {
    for (const tc of (s.toolCalls || [])) {
      if (tc.name === 'browser') {
        const act = tc.args?.action || '';
        const kind = tc.args?.request?.kind || '';
        const label = act === 'act' ? kind || act : act;
        browserBreakdown[label] = (browserBreakdown[label] || 0) + 1;
      }
    }
  }
  r.browserBreakdown = browserBreakdown;

  // Cache hit rate (cacheRead / (cacheRead + input))
  let totalCacheRead = 0, totalInput = 0;
  for (const s of r.steps) {
    totalCacheRead += s.cacheRead || 0;
    // input = totalTokens - output - cacheRead - cacheWrite, or approximate from cost
    const input = Math.max(0, (s.totalTokens || 0) - (s.output || 0) - (s.cacheRead || 0) - (s.cacheWrite || 0));
    totalInput += input;
  }
  r.cacheHitRate = (totalCacheRead + totalInput) > 0 ? totalCacheRead / (totalCacheRead + totalInput) : 0;
  r.totalCacheRead = totalCacheRead;
  r.totalInput = totalInput;
  r.totalCacheWrite = r.steps.reduce((s,x) => s + (x.cacheWrite||0), 0);

  // Waste detection flags
  const wasteFlags = [];
  if (r.steps.length > 30) wasteFlags.push({ type: 'runaway', msg: `${r.steps.length} steps (likely runaway loop)` });
  if (r.cacheHitRate < 0.5 && r.steps.length > 5) wasteFlags.push({ type: 'cache', msg: `${Math.round(r.cacheHitRate*100)}% cache hit (cold start or drift)` });
  for (const s of r.steps) {
    if (s.resultTotalSize > 10000) {
      wasteFlags.push({ type: 'largeResult', msg: `Step with ${fmtSize(s.resultTotalSize)} result (unscoped snapshot?)` });
      break; // Only flag once per heartbeat
    }
  }
  for (const s of r.steps) {
    if (s.totalTokens > 50000) {
      wasteFlags.push({ type: 'bloatedCtx', msg: `Step with ${s.totalTokens.toLocaleString()} context (bloated)` });
      break;
    }
  }
  r.wasteFlags = wasteFlags;

  return r;
}

function getBudget() {
  const budgetFile = path.join(OC, 'canvas', 'budget.json');
  const budget = readJSON(budgetFile) || { daily: 5.00, monthly: 100.00 };
  return budget;
}

// ── Gateway Log Parsing (API errors, browser timeouts) ─────────────────────────
let _gatewayErrorsCache = { ts: 0, errors: [] };

function parseGatewayErrors() {
  // Cache for 10 seconds to avoid re-parsing on every request
  if (Date.now() - _gatewayErrorsCache.ts < 10000) return _gatewayErrorsCache.errors;

  const today = new Date();
  const dateStr = today.getFullYear() + '-' +
    String(today.getMonth()+1).padStart(2,'0') + '-' +
    String(today.getDate()).padStart(2,'0');
  const logFile = path.join('/tmp/openclaw', `openclaw-${dateStr}.log`);

  const errors = [];
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');

    // Track active lanes: agentId → { startTime, active }
    const activeLanes = {};   // agentId → lastDequeueTime
    const runToAgent = {};    // runId → agentId (from tool_result_persist)
    const runErrors = {};     // runId → { count, firstTime, lastTime, agentId }

    for (const line of lines) {
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }

      const msg = parsed['1'] || parsed['0'] || '';
      const time = parsed._meta?.date || parsed.time || '';
      if (typeof msg !== 'string') continue;

      // Track lane activity from dequeue/done events
      // "lane dequeue: lane=session:agent:AGENT_ID:..."
      const dequeueMatch = msg.match(/lane dequeue: lane=session:agent:([^:]+):/);
      if (dequeueMatch) {
        activeLanes[dequeueMatch[1]] = time;
      }
      // "lane task done: lane=session:agent:AGENT_ID:..."
      const doneMatch = msg.match(/lane task done: lane=session:agent:([^:]+):/);
      if (doneMatch) {
        delete activeLanes[doneMatch[1]];
      }

      // Track runId→agent from tool_result_persist (has explicit agent=XXX)
      const persistMatch = msg.match(/agent=([a-z0-9-]+)\s+session=agent:/);
      if (persistMatch) {
        // Find the currently active runId for this agent — track last seen
        runToAgent['_last_' + persistMatch[1]] = time;
      }

      // Detect API errors: "embedded run agent end: runId=XXX isError=true"
      const apiErrMatch = msg.match(/embedded run agent end: runId=([a-f0-9-]+) isError=true/);
      if (apiErrMatch) {
        const runId = apiErrMatch[1];
        if (!runErrors[runId]) {
          runErrors[runId] = { count: 0, firstTime: time, lastTime: time, agentId: null };
          // Attribute to the agent whose lane is currently active
          // Find the agent that was most recently dequeued (closest to this error time)
          let bestAgent = null, bestTime = '';
          for (const [agId, deqTime] of Object.entries(activeLanes)) {
            if (deqTime <= time && deqTime > bestTime) {
              bestTime = deqTime;
              bestAgent = agId;
            }
          }
          runErrors[runId].agentId = bestAgent;
        }
        runErrors[runId].count++;
        runErrors[runId].lastTime = time;
      }

      // Track runId→agent from "embedded run done: runId=XXX sessionId=YYY durationMs=NNN"
      const runDoneMatch = msg.match(/embedded run done: runId=([a-f0-9-]+) sessionId=([a-f0-9-]+) durationMs=(\d+)/);
      if (runDoneMatch) {
        const runId = runDoneMatch[1];
        const sessionId = runDoneMatch[2];
        const dur = parseInt(runDoneMatch[3]);
        if (runErrors[runId]) {
          runErrors[runId].sessionId = sessionId;
          runErrors[runId].durationMs = dur;
          // If no agent mapped yet, try session file lookup
          if (!runErrors[runId].agentId) {
            try {
              const agentsDir = path.join(OC, 'agents');
              for (const dir of fs.readdirSync(agentsDir)) {
                if (fs.existsSync(path.join(agentsDir, dir, 'sessions', sessionId + '.jsonl'))) {
                  runErrors[runId].agentId = dir;
                  break;
                }
              }
            } catch {}
          }
        }
      }

      // Detect browser timeouts: "⇄ res ✗ browser.request NNNms errorCode=XXX errorMessage=YYY"
      const browserErrMatch = msg.match(/res ✗ browser\.request (\d+)ms errorCode=(\w+) errorMessage=(.+?)(?:\s+conn=|$)/);
      if (browserErrMatch) {
        const dur = parseInt(browserErrMatch[1]);
        const errorCode = browserErrMatch[2];
        const errorMsg = browserErrMatch[3].trim().slice(0, 150);
        errors.push({
          time, type: 'browser', agentId: null,
          msg: `Browser CDP: ${errorCode} — ${errorMsg}`,
          detail: `${dur}ms timeout`,
        });
      }
    }

    // Build error entries from runErrors
    for (const [runId, info] of Object.entries(runErrors)) {
      if (info.count === 0) continue;
      const agentId = info.agentId || null;

      // Classify error based on retry count
      let errorMsg;
      if (info.count >= 3) {
        errorMsg = `API: ${info.count} consecutive failures (likely rate limit or overloaded)`;
      } else if (info.count === 2) {
        errorMsg = `API: ${info.count} retries (transient error)`;
      } else {
        errorMsg = 'API: single error (transient)';
      }
      if (info.durationMs !== undefined) {
        errorMsg += ` — session ${Math.round(info.durationMs/1000)}s`;
      }

      errors.push({
        time: info.firstTime,
        type: 'api',
        agentId,
        msg: errorMsg,
        detail: `runId: ${runId.slice(0,8)}… (${info.count} error${info.count>1?'s':''})`,
        retryCount: info.count,
      });
    }

    errors.sort((a,b) => (b.time||'') < (a.time||'') ? -1 : 1);
  } catch (e) {
    // Log file doesn't exist or can't be read — that's fine
  }

  _gatewayErrorsCache = { ts: Date.now(), errors };
  return errors;
}

function cleanStepForAPI(step) {
  return {
    time: step.time,
    durationMs: step.durationMs,
    text: step.text,
    toolCalls: step.toolCalls,
    toolResults: step.toolResults,
    cost: step.cost,
  };
}

function hasError(toolResult) {
  // Check explicit error flag
  if (toolResult.isError) return true;

  // Check if result content indicates an error
  const preview = toolResult.preview || '';
  try {
    // Try to parse JSON result
    const parsed = JSON.parse(preview);
    if (parsed.status === 'error' || parsed.error) return true;
  } catch {
    // Not JSON or parse error, check string content
    if (preview.includes('"status": "error"') || preview.includes('"status":"error"')) return true;
  }

  return false;
}

function cleanHeartbeatForAPI(hb, errorsOnly = false) {
  let steps = hb.steps?.map(cleanStepForAPI) || [];

  // Filter to only steps with errors if requested
  if (errorsOnly) {
    steps = steps.filter(step =>
      step.toolResults?.some(r => hasError(r)) || false
    );
  }

  const { sessionFile, entryRange, ...rest } = hb;
  return {
    ...rest,
    steps,
    ...(errorsOnly && { filteredToErrors: true, totalSteps: hb.steps?.length || 0 }),
  };
}

function loadAll(opts = {}) {
  const includeReset = opts.includeReset || false;
  const meta   = getAgentMeta();
  const agents = [];
  const dailyCosts = {}; // { "2026-02-11": cost }
  const dailyTokens = {}; // { "2026-02-11": tokens }
  const dailyHbs   = {}; // { "2026-02-11": count }
  const dailyByAgent = {}; // { "2026-02-11": { agentId: cost } }

  for (const [id, info] of Object.entries(meta)) {
    const sessDir = path.join(OC, 'agents', id, 'sessions');
    const sessFile = path.join(sessDir, 'sessions.json');
    const sessions = readJSON(sessFile) || {};

    const heartbeats = [];
    let totalCost     = 0;
    let totalTokensSum = 0;
    let totalErrors   = 0;
    let totalCacheReadTk = 0;
    let totalInputTk  = 0;
    let lastTime      = 0;
    let model         = '';
    let contextTokens = 200000;
    let totalTokens   = 0;

    // Read ALL .jsonl files in sessions directory (not just registered ones)
    const allSessionFiles = [];
    try {
      const files = fs.readdirSync(sessDir);
      for (const file of files) {
        if (file.endsWith('.jsonl') || (includeReset && file.includes('.jsonl.reset.'))) {
          allSessionFiles.push(path.join(sessDir, file));
        }
      }
    } catch (e) {
      // Directory doesn't exist or can't be read
    }

    // Include shadow file with preserved (truncated) heartbeat entries
    const shadowFile = path.join(SHADOW_DIR, id + '.jsonl');
    if (fs.existsSync(shadowFile)) {
      allSessionFiles.push(shadowFile);
    }

    // Prefer registered sessions for metadata
    for (const sess of Object.values(sessions)) {
      if (!sess.sessionFile) continue;
      model         = sess.model         || model;
      contextTokens = sess.contextTokens || contextTokens;
      totalTokens   = Math.max(totalTokens, sess.totalTokens || 0);
      lastTime      = Math.max(lastTime, sess.updatedAt || 0);
    }

    // Parse all session files
    for (const sessionFile of allSessionFiles) {
      const hbs = parseHeartbeats(readJSONL(sessionFile), sessionFile);
      for (const hb of hbs) heartbeats.push(hb);
    }

    // Deduplicate heartbeats (shadow file may overlap with live file during active runs)
    const seen = new Set();
    const uniqueHbs = [];
    heartbeats.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    for (const hb of heartbeats) {
      const key = hb.startTime || '';
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      uniqueHbs.push(hb);
    }

    // Compute totals and daily rollup from deduplicated heartbeats
    for (const hb of uniqueHbs) {
      totalCost   += hb.totalCost;
      totalTokensSum += hb.totalTokensSum || 0;
      totalErrors += hb.errorCount || 0;
      totalCacheReadTk += hb.totalCacheRead || 0;
      totalInputTk += hb.totalInput || 0;
      if (hb.startTime) {
        const d = new Date(hb.startTime);
        const dateKey = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        dailyCosts[dateKey] = (dailyCosts[dateKey] || 0) + hb.totalCost;
        dailyTokens[dateKey] = (dailyTokens[dateKey] || 0) + (hb.totalTokensSum || 0);
        dailyHbs[dateKey]   = (dailyHbs[dateKey] || 0) + 1;
        if (!dailyByAgent[dateKey]) dailyByAgent[dateKey] = {};
        dailyByAgent[dateKey][id] = (dailyByAgent[dateKey][id] || 0) + hb.totalCost;
      }
    }

    // Average cache hit rate
    const avgCacheHit = uniqueHbs.length
      ? uniqueHbs.reduce((sum, hb) => sum + (hb.cacheHitRate || 0), 0) / uniqueHbs.length
      : 0;

    agents.push({ ...info, model, contextTokens, totalTokens, totalCost, totalTokensSum, totalErrors, lastTime, heartbeats: uniqueHbs, avgCacheHit, totalCacheReadTk, totalInputTk });
  }

  agents.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));

  // Format daily costs for last 7 days
  const today = new Date();
  const dailySummary = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const cost = dailyCosts[key] || 0;
    const hbs  = dailyHbs[key] || 0;
    const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d.toLocaleDateString('en', {weekday:'short'});
    const tokens = dailyTokens[key] || 0;
    if (cost > 0 || i < 2) dailySummary.push({ label, cost, tokens, hbs, date: key, dayOffset: i });
  }

  // Budget projections
  const budget = getBudget();
  const todayKey = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  const todayCost = dailyCosts[todayKey] || 0;

  // 7-day average for monthly projection
  let sum7 = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    sum7 += dailyCosts[key] || 0;
  }
  const avg7 = sum7 / 7;
  const projectedMonthly = avg7 * 30;

  // Build 7-day trend data (oldest to newest)
  const trendData = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const label = i === 0 ? 'Today' : i === 1 ? 'Yest' : d.toLocaleDateString('en', {weekday:'short'}).slice(0,3);
    trendData.push({ date: key, label, dayOffset: i, total: dailyCosts[key] || 0, tokens: dailyTokens[key] || 0, byAgent: dailyByAgent[key] || {} });
  }

  // Gateway-level errors (API errors, browser timeouts from log)
  const gatewayErrors = parseGatewayErrors();

  return { agents, dailySummary, budget: { ...budget, todayCost, projectedMonthly, avg7 }, trendData, gatewayErrors };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const fullUrl = req.url;
  const url = fullUrl.split('?')[0];
  const params = new URL('http://x' + fullUrl).searchParams;

  if (url === '/api/data') {
    try {
      const includeReset = params.get('include_reset') === '1';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadAll({ includeReset })));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/agents - List all agents with summary stats
  if (url === '/api/agents') {
    try {
      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });
      const agents = data.agents.map(a => ({
        id: a.id,
        name: a.name,
        emoji: a.emoji,
        model: a.model,
        totalCost: a.totalCost,
        totalTokens: a.totalTokensSum || 0,
        totalErrors: a.totalErrors,
        heartbeatCount: a.heartbeats?.length || 0,
        lastRun: a.lastTime,
        avgCacheHit: Math.round((a.avgCacheHit || 0) * 100),
        contextUsed: a.totalTokens,
        contextLimit: a.contextTokens,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agents, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/agent/:id?errors_only=true - Get specific agent details
  if (url.startsWith('/api/agent/')) {
    try {
      const agentId = url.split('/api/agent/')[1].split('?')[0];
      const errorsOnly = params.get('errors_only') === 'true' || params.get('errorsOnly') === 'true';
      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });
      const agent = data.agents.find(a => a.id === agentId);
      if (!agent) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }
      // Clean up heartbeats in agent data
      const cleanAgent = {
        ...agent,
        heartbeats: agent.heartbeats?.map(hb => cleanHeartbeatForAPI(hb, errorsOnly)) || [],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cleanAgent, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/heartbeats?agent=X&limit=N&errors=true - Query heartbeats
  if (url === '/api/heartbeats') {
    try {
      const agentId = params.get('agent');
      const limit = parseInt(params.get('limit') || '10', 10);
      const errorsOnly = params.get('errors') === 'true';
      const minCost = parseFloat(params.get('minCost') || '0');
      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });

      let heartbeats = [];
      for (const a of data.agents) {
        if (agentId && a.id !== agentId) continue;
        for (const hb of a.heartbeats || []) {
          heartbeats.push({
            agent: a.id,
            agentName: a.name,
            startTime: hb.startTime,
            endTime: hb.endTime,
            durationMs: hb.durationMs,
            cost: hb.totalCost,
            tokens: hb.totalTokensSum || 0,
            steps: hb.steps?.length || 0,
            errors: hb.errorCount || 0,
            cacheHitRate: Math.round((hb.cacheHitRate || 0) * 100),
            context: hb.finalContext,
            summary: hb.summary || hb.trigger || '',
            wasteFlags: hb.wasteFlags || [],
          });
        }
      }

      // Apply filters
      if (errorsOnly) heartbeats = heartbeats.filter(h => h.errors > 0);
      if (minCost > 0) heartbeats = heartbeats.filter(h => h.cost >= minCost);

      // Sort by time (newest first) and limit
      heartbeats.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
      heartbeats = heartbeats.slice(0, limit);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(heartbeats, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/latest?agent=X&errors_only=true - Get latest heartbeat for agent
  if (url === '/api/latest') {
    try {
      const agentId = params.get('agent');
      const errorsOnly = params.get('errors_only') === 'true' || params.get('errorsOnly') === 'true';

      if (!agentId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'agent parameter required' }));
        return;
      }
      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });
      const agent = data.agents.find(a => a.id === agentId);
      if (!agent || !agent.heartbeats?.length) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No heartbeats found for agent' }));
        return;
      }
      const latest = cleanHeartbeatForAPI(agent.heartbeats[0], errorsOnly); // Already sorted newest first
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(latest, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/heartbeat?agent=X&index=N&errors_only=true - Get specific heartbeat by index (matches UI hash)
  if (url === '/api/heartbeat') {
    try {
      const agentId = params.get('agent');
      const index = parseInt(params.get('index') || params.get('hb') || '0', 10);
      const errorsOnly = params.get('errors_only') === 'true' || params.get('errorsOnly') === 'true';

      if (!agentId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'agent parameter required' }));
        return;
      }

      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });
      const agent = data.agents.find(a => a.id === agentId);
      if (!agent || !agent.heartbeats?.length) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No heartbeats found for agent' }));
        return;
      }

      if (index < 0 || index >= agent.heartbeats.length) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Heartbeat index ${index} out of range (0-${agent.heartbeats.length - 1})` }));
        return;
      }

      const heartbeat = cleanHeartbeatForAPI(agent.heartbeats[index], errorsOnly);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(heartbeat, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/raw-messages?agent=X&hb=N - Get raw JSONL entries for a specific heartbeat
  if (url === '/api/raw-messages') {
    try {
      const agentId = params.get('agent');
      const hbIdx = parseInt(params.get('hb') || '0', 10);
      if (!agentId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'agent parameter required' }));
        return;
      }
      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });
      const agent = data.agents.find(a => a.id === agentId);
      if (!agent || !agent.heartbeats?.length) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No heartbeats found for agent' }));
        return;
      }
      if (hbIdx < 0 || hbIdx >= agent.heartbeats.length) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Heartbeat index ${hbIdx} out of range` }));
        return;
      }
      const hb = agent.heartbeats[hbIdx];
      if (!hb.sessionFile || !hb.entryRange) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session file info not available for this heartbeat' }));
        return;
      }
      const allEntries = readJSONL(hb.sessionFile);
      const slice = allEntries.slice(hb.entryRange.start, hb.entryRange.end + 1);
      const messages = slice.map((entry, i) => ({
        index: hb.entryRange.start + i,
        role: entry.message?.role || entry.type || 'unknown',
        timestamp: entry.timestamp || entry.message?.timestamp || null,
        raw: entry,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ heartbeatIndex: hbIdx, messages }, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/budget - Get budget status
  if (url === '/api/budget') {
    try {
      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });
      const budget = data.budget || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        daily: budget.daily || 0,
        monthly: budget.monthly || 0,
        todayCost: budget.todayCost || 0,
        avg7Days: budget.avg7 || 0,
        projectedMonthly: budget.projectedMonthly || 0,
        dailyPct: budget.daily ? Math.round((budget.todayCost / budget.daily) * 100) : 0,
        monthlyPct: budget.monthly ? Math.round((budget.projectedMonthly / budget.monthly) * 100) : 0,
        status: budget.daily && budget.todayCost > budget.daily * 0.9 ? 'over' :
                budget.daily && budget.todayCost > budget.daily * 0.7 ? 'warning' : 'ok',
      }, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/daily?days=N - Get daily cost summary
  if (url === '/api/daily') {
    try {
      const days = parseInt(params.get('days') || '7', 10);
      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });
      const today = new Date();
      const dailySummary = [];

      for (let i = 0; i < days; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

        let cost = 0, tokens = 0, hbs = 0;
        const byAgent = {};
        for (const a of data.agents) {
          for (const hb of a.heartbeats || []) {
            if (hb.startTime && hb.startTime.startsWith(key)) {
              cost += hb.totalCost;
              tokens += hb.totalTokensSum || 0;
              hbs++;
              byAgent[a.id] = (byAgent[a.id] || 0) + hb.totalCost;
            }
          }
        }

        dailySummary.push({ date: key, cost, tokens, heartbeats: hbs, byAgent });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dailySummary, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/stats - Overall statistics
  if (url === '/api/stats') {
    try {
      const includeReset = params.get('include_reset') === '1';
      const data = loadAll({ includeReset });
      const totalCost = data.agents.reduce((s, a) => s + (a.totalCost || 0), 0);
      const totalTk = data.agents.reduce((s, a) => s + (a.totalTokensSum || 0), 0);
      const totalHbs = data.agents.reduce((s, a) => s + (a.heartbeats?.length || 0), 0);
      const totalErrors = data.agents.reduce((s, a) => s + (a.totalErrors || 0), 0);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalAgents: data.agents.length,
        totalCost,
        totalTokens: totalTk,
        totalHeartbeats: totalHbs,
        totalErrors,
        avgCostPerHeartbeat: totalHbs > 0 ? totalCost / totalHbs : 0,
        avgTokensPerHeartbeat: totalHbs > 0 ? Math.round(totalTk / totalHbs) : 0,
        budget: data.budget,
        dailySummary: data.dailySummary,
      }, null, 2));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }


  // DELETE /api/cleanup?agent=X - Delete all heartbeat session files for an agent
  // DELETE /api/cleanup - Delete all heartbeat session files for ALL agents
  if (url === '/api/cleanup' && req.method === 'DELETE') {
    try {
      const agentId = params.get('agent');
      const meta = getAgentMeta();
      const targets = agentId ? [agentId] : Object.keys(meta);
      const results = {};
      let totalDeleted = 0;

      for (const id of targets) {
        const sessDir = path.join(OC, 'agents', id, 'sessions');
        let deleted = 0;
        try {
          const files = fs.readdirSync(sessDir);
          for (const file of files) {
            if (file.endsWith('.jsonl')) {
              fs.unlinkSync(path.join(sessDir, file));
              deleted++;
            }
          }
          // Also clear sessions.json
          const sessFile = path.join(sessDir, 'sessions.json');
          if (fs.existsSync(sessFile)) {
            fs.writeFileSync(sessFile, '{}');
          }
          // Clean up shadow file
          const shadowFile = path.join(SHADOW_DIR, id + '.jsonl');
          try { fs.unlinkSync(shadowFile); } catch {}
        } catch (e) {
          // Directory doesn't exist or permission error
        }
        results[id] = deleted;
        totalDeleted += deleted;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: totalDeleted, byAgent: results }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/shutdown - graceful shutdown
  if (url === '/api/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'shutting down' }));
    process.exit(0);
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
}).listen(PORT, () => {
  console.log(`\n  🦞 OpenClaw Trace → http://localhost:${PORT}\n`);
});

// ── Frontend ──────────────────────────────────────────────────────────────────

const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Trace</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0e14;--surface:#12161f;--surface2:#1a1f2e;--surface3:#242a3a;
  --border:#1e2535;--border-light:#2a3245;--text:#e2e8f0;--muted:#64748b;--muted2:#475569;--chart-label:#94a3b8;
  --blue:#60a5fa;--green:#4ade80;--orange:#fbbf24;
  --red:#f87171;--purple:#a78bfa;--accent:#3b82f6;--teal:#2dd4bf;
  --glow-blue:rgba(96,165,250,.08);--glow-green:rgba(74,222,128,.08);
  --radius:10px;--radius-sm:6px;
  --font-sans:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
  --font-mono:'SF Mono','Fira Code',ui-monospace,monospace;
}
html.light{
  --bg:#f8fafc;--surface:#ffffff;--surface2:#f1f5f9;--surface3:#e2e8f0;
  --border:#e2e8f0;--border-light:#cbd5e1;--text:#1e293b;--muted:#64748b;--muted2:#94a3b8;--chart-label:#475569;
  --blue:#2563eb;--green:#16a34a;--orange:#d97706;
  --red:#dc2626;--purple:#7c3aed;--accent:#2563eb;--teal:#0d9488;
  --glow-blue:rgba(37,99,235,.06);--glow-green:rgba(22,163,74,.06);
}
body{background:var(--bg);color:var(--text);font:13px/1.6 var(--font-sans);display:flex;height:100vh;overflow:hidden}

/* ── Sidebar ── */
#sidebar{width:230px;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0;display:flex;flex-direction:column;transition:margin-left .3s,opacity .3s}
#sidebar.collapsed{margin-left:-230px;opacity:0;pointer-events:none}
#sidebar-head{padding:14px 16px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.agent-row{padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--border)33;transition:all .15s}
.agent-row:hover{background:var(--surface2)}
.agent-row.active{background:var(--accent)15;border-left:3px solid var(--blue);padding-left:13px}
.agent-name{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:5px}
.agent-sub{font-size:10.5px;color:var(--muted);margin-top:3px;display:flex;gap:8px}
.agent-cost{color:var(--green);font-family:var(--font-mono);font-size:10px}
.no-data{color:var(--border-light)}
.err-count{background:var(--red)18;color:var(--red);font-size:9px;padding:2px 6px;border-radius:4px;font-weight:700}

/* ── Main ── */
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}

/* ── Topbar ── */
#topbar{padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0;background:var(--surface)}
#agent-title{font-size:15px;font-weight:700;white-space:nowrap;letter-spacing:-.02em}
.pill{font-size:10px;padding:3px 10px;border-radius:12px;background:var(--surface2);border:1px solid var(--border-light);color:var(--muted);white-space:nowrap;font-weight:500}
.pill.model{color:var(--blue);border-color:var(--blue)33}
.pill.pct-low{color:var(--green)}.pill.pct-med{color:var(--orange)}.pill.pct-high{color:var(--red)}
#daily-pill{margin-left:auto;font-size:11px;color:var(--green);background:var(--glow-green);padding:5px 12px;border-radius:12px;border:1px solid var(--green)22;display:none}
#daily-pill .amt{font-weight:700;font-family:var(--font-mono)}
.sidebar-toggle-btn{font-size:16px;padding:6px 10px;border-radius:var(--radius-sm);background:var(--surface2);border:1px solid var(--border-light);color:var(--text);cursor:pointer;transition:all .15s;margin-right:4px;line-height:1}
.sidebar-toggle-btn:hover{background:var(--surface3);border-color:var(--muted2)}
.back-btn{font-size:15px;padding:4px 10px;border-radius:var(--radius-sm);background:var(--surface2);border:1px solid var(--border-light);color:var(--muted);cursor:pointer;transition:all .15s;line-height:1}
.back-btn:hover{background:var(--surface3);color:var(--text);border-color:var(--muted2)}
.cleanup-btn{font-size:10px;padding:5px 12px;border-radius:var(--radius-sm);background:var(--red)0a;border:1px solid var(--red)22;color:var(--red);cursor:pointer;transition:all .15s}
.cleanup-btn:hover{background:var(--red)18;border-color:var(--red)44}
.pager{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px 0;font-size:11px;color:var(--muted)}
.pager-btn{padding:4px 10px;border-radius:var(--radius-sm);background:var(--surface);border:1px solid var(--border);color:var(--text);cursor:pointer;font-size:11px;transition:all .15s}
.pager-btn:hover{background:var(--surface2);border-color:var(--blue)}
.pager-btn:disabled{opacity:.3;cursor:default;background:var(--surface)}
.pager-btn:disabled:hover{border-color:var(--border)}
.pager-num{padding:4px 8px;border-radius:var(--radius-sm);cursor:pointer;font-size:11px;color:var(--muted);transition:all .15s}
.pager-num:hover{background:var(--surface2);color:var(--text)}
.pager-num.active{background:var(--blue)22;color:var(--blue);font-weight:600}
.compare-mode-btn{font-size:10px;padding:5px 14px;border-radius:var(--radius-sm);background:var(--glow-blue);border:1px solid var(--blue)33;color:var(--blue);cursor:pointer;transition:all .15s;font-weight:600}
.compare-mode-btn:hover{background:var(--blue)1a;border-color:var(--blue)55}
#budget-wrap{flex:1;max-width:240px;min-width:130px;display:none}
#budget-label{font-size:10px;color:var(--muted);margin-bottom:3px;display:flex;justify-content:space-between}
#budget-track{height:6px;background:var(--border);border-radius:3px;overflow:hidden}
#budget-fill{height:6px;border-radius:3px;transition:width .3s,background .3s}
.budget-ok{background:var(--green)}.budget-warn{background:var(--orange)}.budget-over{background:var(--red)}

/* ── Content ── */
#content{flex:1;overflow-y:auto;padding:20px 24px}

/* ── Overview ── */
.agent-overview{margin-bottom:16px}
.agent-overview-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;user-select:none;margin-bottom:8px}
.agent-overview-toggle .section-title{margin-bottom:0}
.agent-overview-toggle .toggle-arrow{color:var(--muted);font-size:10px;transition:transform .2s}
.agent-overview-toggle:hover .section-title{color:var(--text)}
.agent-overview-body{overflow:hidden;transition:max-height .3s ease,opacity .2s ease}
.agent-overview-body.collapsed{max-height:0 !important;opacity:0;margin:0;padding:0}
.agent-overview-body.expanded{opacity:1}
#overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
.stat-box{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:500}
.stat-val{font-size:24px;font-weight:700;margin-top:6px;font-family:var(--font-mono);letter-spacing:-.03em}
.stat-val.green{color:var(--green)}.stat-val.purple{color:var(--purple)}.stat-val.blue{color:var(--blue)}.stat-val.orange{color:var(--orange)}

/* ── Cross-agent table ── */
.cross-agent-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;margin-bottom:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.cross-agent-tbl th{padding:10px 14px;text-align:left;color:var(--muted);font-weight:600;border-bottom:2px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;background:var(--surface2)}
.cross-agent-tbl td{padding:10px 14px;border-bottom:1px solid var(--border)44}
.cross-agent-tbl tbody tr:last-child td{border-bottom:none}
.cross-agent-tbl tbody tr{cursor:pointer;transition:all .15s}
.cross-agent-tbl tbody tr:hover{background:var(--surface2)}
.cross-agent-tbl .r{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--font-mono);font-size:11px}
.cross-agent-tbl .agent-cell{font-weight:600;display:flex;align-items:center;gap:8px}

/* ── Daily summary ── */
.daily-summary{display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap}
.daily-chip{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px}
.daily-chip-label{color:var(--muted);font-size:10px;margin-bottom:3px;font-weight:500}
.daily-chip-val{color:var(--green);font-weight:700;font-size:16px;font-family:var(--font-mono)}
.daily-chip-sub{color:var(--muted);font-size:10px;margin-top:2px}

/* ── Charts ── */
.section-title{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;font-weight:600}
.spark-wrap{overflow-x:auto;margin-bottom:20px}
.chart-row{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.chart-box{flex:1;min-width:180px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}

/* ── Heartbeat Stats Grid ── */
.hb-stats-grid{display:grid;grid-template-columns:2fr 1.2fr 1fr;gap:16px;margin-bottom:20px}
.stat-chart-card,.stat-breakdown-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;min-height:140px;display:flex;flex-direction:column}
.stat-chart-title{font-size:12px;color:var(--text);font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:6px;flex-shrink:0}
.stat-chart-content{overflow-x:auto;flex:1;display:flex;align-items:center}
.breakdown-table{display:flex;flex-direction:column;gap:4px}
.breakdown-row{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-radius:var(--radius-sm);font-size:12px}
.breakdown-row:hover{background:var(--surface2)}
.breakdown-label{color:var(--muted)}
.breakdown-value{font-weight:600;font-variant-numeric:tabular-nums;font-family:var(--font-mono);font-size:12px}
.breakdown-total{border-top:1px solid var(--border);margin-top:4px;padding-top:8px}
@media(max-width:1400px){.hb-stats-grid{grid-template-columns:repeat(2,1fr);}}
@media(max-width:900px){.hb-stats-grid{grid-template-columns:1fr;}}

/* ── Heartbeat list ── */
.hb{border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;overflow:hidden}
.hb-head{padding:12px 16px;display:flex;align-items:center;gap:14px;cursor:pointer;background:var(--surface);transition:all .15s;user-select:none;flex-wrap:wrap}
.hb-head:hover{background:var(--surface2)}
.hb-head.open{background:var(--surface2);border-bottom:1px solid var(--border)}
.hb-num{font-size:13px;color:var(--text);min-width:28px;font-family:var(--font-mono);font-weight:700}
.hb-time{font-size:12px;color:var(--muted);min-width:54px}
.hb-cost{font-size:14px;font-weight:700;color:var(--green);min-width:70px;font-family:var(--font-mono)}
.hb-ctx{font-size:12px;color:var(--purple);min-width:84px;font-family:var(--font-mono)}
.hb-dur{font-size:12px;color:var(--muted);min-width:44px}
.hb-steps{font-size:12px;color:var(--muted);min-width:52px}
.hb-browser{font-size:9px;color:var(--blue);background:var(--glow-blue);border:1px solid var(--blue)22;border-radius:12px;padding:2px 8px;white-space:nowrap}
.hb-cache{font-size:9px;border-radius:12px;padding:2px 8px;white-space:nowrap;font-weight:600}
.cache-good{color:var(--green);background:var(--glow-green);border:1px solid var(--green)22}
.cache-ok{color:var(--blue);background:var(--glow-blue);border:1px solid var(--blue)22}
.cache-low{color:var(--orange);background:var(--orange)0a;border:1px solid var(--orange)22}
.hb-sum{font-size:12px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:100px}
.hb-arrow{font-size:10px;color:var(--muted);margin-left:6px;transition:transform .2s}
.hb-head.open .hb-arrow{transform:rotate(90deg)}
.hb-api-btns{display:flex;gap:4px;flex-shrink:0;margin-left:auto}
.api-btn{font-size:9px;padding:3px 8px;border-radius:var(--radius-sm);background:var(--surface3);border:1px solid var(--border-light);color:var(--blue);cursor:pointer;transition:all .12s;white-space:nowrap;flex-shrink:0}
.api-btn:hover{background:var(--blue)18;border-color:var(--blue)33}
.api-btn.copied{background:var(--green)18;border-color:var(--green)33;color:var(--green)}

/* ── Heartbeat body ── */
.hb-body{display:none;padding:14px 16px 16px;background:var(--bg);border-top:1px solid var(--border)}
.hb-body.open{display:block}

/* ── Tool frequency bar ── */
.tool-freq{font-size:11px;color:var(--muted);margin-bottom:12px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tool-freq-label{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-right:4px;font-weight:600}
.tf-chip{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:3px 10px;font-size:11px;white-space:nowrap}
.tf-chip.t-browser{color:var(--blue);border-color:var(--blue)22;background:var(--glow-blue)}
.tf-chip.t-read,.tf-chip.t-write,.tf-chip.t-edit{color:var(--teal);border-color:var(--teal)22;background:var(--teal)08}
.tf-chip.t-bash{color:var(--orange);border-color:var(--orange)22;background:var(--orange)08}
.tf-chip.t-other{color:var(--muted)}

/* ── Step table ── */
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{padding:10px 12px;text-align:left;color:var(--muted);font-weight:600;border-bottom:2px solid var(--border);white-space:nowrap;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.tbl th.sortable{cursor:pointer;user-select:none;transition:background .15s}
.tbl th.sortable:hover{background:var(--surface2);color:var(--text)}
.sort-arrow{font-size:8px;margin-left:3px;opacity:.5}
.sort-arrow.asc::after{content:'▲'}
.sort-arrow.desc::after{content:'▼'}
.tbl td{padding:8px 12px;border-bottom:1px solid var(--border)33;vertical-align:top;line-height:1.4}
.tbl tr:last-child td{border-bottom:none}
.tbl .r{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--font-mono);font-size:11px}
.tbl .g{color:var(--green)}.tbl .b{color:var(--blue)}.tbl .p{color:var(--purple)}.tbl .o{color:var(--orange)}.tbl .m{color:var(--muted)}.tbl .r2{color:var(--red)}
.cost-bar{display:inline-block;height:6px;background:var(--green);border-radius:3px;vertical-align:middle;margin-right:6px;opacity:.7}

/* ── Step row heat colors ── */
.step-row{cursor:pointer;transition:background .12s}
.step-row:hover{background:var(--surface2) !important}
.step-warm{background:rgba(251,191,36,.05)}
.step-hot{background:rgba(248,113,113,.06)}
.step-row.expanded{background:var(--surface2)}

/* ── Step detail panel ── */
.step-detail td{padding:0 !important;border-bottom:1px solid var(--border) !important}
.step-detail-inner{padding:10px 12px;background:var(--surface3);display:flex;gap:12px;flex-wrap:wrap}
.thinking-section{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:8px}
.thinking-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;font-weight:600}
.thinking-text{font-size:11px;color:var(--text);line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto}
.thinking-text.expanded{max-height:none}
.detail-call{flex:1;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;font-size:11px}
.detail-call-head{font-size:11px;font-weight:600;color:var(--blue);margin-bottom:6px;display:flex;justify-content:space-between}
.detail-call-args{color:var(--muted);margin-bottom:8px;word-break:break-all;white-space:pre-wrap;max-height:80px;overflow-y:auto;font-family:var(--font-mono);font-size:10px}
.detail-result{border-top:1px solid var(--border);padding-top:6px;margin-top:4px}
.detail-result-head{font-size:10px;color:var(--muted);margin-bottom:3px;display:flex;gap:6px;align-items:center}
.detail-result-body{color:var(--text);white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;font-size:10px;opacity:.85;font-family:var(--font-mono)}
.detail-result-body.expanded{max-height:none}
.expand-btn{font-size:9px;padding:2px 8px;margin-top:4px;border-radius:3px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);cursor:pointer;transition:all .15s}
.expand-btn:hover{background:var(--surface3);color:var(--text)}
.err-badge{color:var(--red);font-size:9px;background:var(--red)14;padding:2px 6px;border-radius:4px;font-weight:600}
.err-badge-solved{color:var(--muted);font-size:9px;background:var(--surface2);padding:2px 6px;border-radius:4px}
.mark-solved-btn{font-size:9px;padding:3px 8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;cursor:pointer;margin-left:4px;transition:all .12s}
.mark-solved-btn:hover{background:var(--surface3);border-color:var(--green);color:var(--green)}
.mark-all-solved-btn{font-size:9px;padding:2px 8px;background:var(--surface2);color:var(--green);border:1px solid var(--border);border-radius:4px;cursor:pointer;margin-left:4px;font-weight:600;transition:all .12s}
.mark-all-solved-btn:hover{background:var(--surface3);border-color:var(--green)}

/* ── Waste warnings ── */
.waste-hints{background:var(--surface);border:1px solid var(--orange)33;border-radius:var(--radius);padding:10px 14px;margin-bottom:12px}
.waste-title{font-size:11px;color:var(--orange);font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.waste-list{font-size:11px;color:var(--muted);line-height:1.5}
.waste-item{margin-bottom:3px;display:flex;gap:6px}
.waste-icon{color:var(--orange)}

/* ── Comparison ── */
.compare-bar{background:var(--surface);border:1px solid var(--blue)33;border-radius:var(--radius);padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:12px}
.compare-label{font-size:11px;color:var(--blue);font-weight:600}
.compare-chip{font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:3px 10px;color:var(--muted)}
.compare-chip.selected{border-color:var(--blue);color:var(--blue);background:var(--glow-blue)}
.compare-btn{font-size:10px;padding:4px 10px;border-radius:var(--radius-sm);background:var(--blue)18;border:1px solid var(--blue)33;color:var(--blue);cursor:pointer;transition:background .12s}
.compare-btn:hover{background:var(--blue)28}
.compare-view{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
.compare-col{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
.compare-col-title{font-size:11px;font-weight:600;color:var(--blue);margin-bottom:10px}
.compare-stat{font-size:11px;padding:5px 0;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)33}
.compare-stat:last-child{border-bottom:none}

/* ── Heartbeat Health Timeline ── */
.health-timeline{margin-bottom:24px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.health-timeline .section-title{margin-bottom:12px}
.ht-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)22}
.ht-row:last-child{border-bottom:none}
.ht-agent{font-size:12px;min-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;font-weight:500;transition:color .12s}
.ht-agent:hover{color:var(--blue)}
.ht-dots{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.ht-dot{width:12px;height:12px;border-radius:3px;cursor:default;transition:all .15s;flex-shrink:0}
.ht-dot:hover{transform:scale(1.3);border-radius:2px}
.ht-dot.green{background:var(--green)}.ht-dot.yellow{background:var(--orange)}.ht-dot.red{background:var(--red)}.ht-dot.grey{background:var(--border)}
.ht-summary{font-size:10px;color:var(--muted);margin-left:8px;white-space:nowrap}

/* ── Bottom panels (error + actions side by side) ── */
.charts-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}
.charts-row .chart-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;min-width:0;display:flex;flex-direction:column}
.charts-row .chart-card svg{flex:1}
.charts-row .chart-card .section-title{margin-bottom:10px}
@media(max-width:1200px){.charts-row{grid-template-columns:1fr 1fr}.charts-row .chart-card:last-child{grid-column:span 2}}
@media(max-width:800px){.charts-row{grid-template-columns:1fr}.charts-row .chart-card:last-child{grid-column:span 1}}
.bottom-panels{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
@media(max-width:1100px){.bottom-panels{grid-template-columns:1fr}}

/* ── Error Log Panel ── */
.error-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.error-panel.has-errors{border-color:var(--red)33}
.error-header{cursor:pointer;display:flex;align-items:center;gap:10px;user-select:none;margin-bottom:10px}
.error-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.error-badge{background:var(--red)18;color:var(--red);font-size:10px;padding:2px 8px;border-radius:12px;font-weight:600}
.error-ok-badge{background:var(--glow-green);color:var(--green);font-size:10px;padding:2px 8px;border-radius:12px;font-weight:600}
.error-body{display:none;max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm)}
.error-body.open{display:block}
.error-filter{padding:8px 14px;border-bottom:1px solid var(--border)33;display:flex;gap:8px;flex-wrap:wrap}
.error-filter-btn{font-size:10px;padding:3px 10px;border-radius:12px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);cursor:pointer;transition:all .12s}
.error-filter-btn:hover,.error-filter-btn.active{background:var(--glow-blue);border-color:var(--blue)33;color:var(--blue)}
.error-item{padding:6px 12px;border-bottom:1px solid var(--border)33;font-size:11px;display:flex;gap:10px;align-items:flex-start;transition:background .1s}
.error-item:hover{background:var(--surface2)}
.error-item:last-child{border-bottom:none}
.error-time{color:var(--muted);min-width:44px;flex-shrink:0;font-family:var(--font-mono);font-size:10px}
.error-agent{min-width:22px;flex-shrink:0}
.error-msg{color:var(--red);word-break:break-word;line-height:1.5;opacity:.9}
.error-type-badge{font-size:9px;padding:1px 6px;border-radius:8px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;flex-shrink:0;min-width:42px;text-align:center}
.error-type-summary{font-size:10px;font-weight:500;margin-left:4px}
.error-type-counts{display:flex;gap:10px;margin-left:6px}

/* ── Actions Feed ── */
.actions-feed{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.actions-feed .section-title{margin-bottom:10px}
.af-controls{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
.af-filter-btn{font-size:10px;padding:3px 10px;border-radius:12px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);cursor:pointer;transition:all .12s}
.af-filter-btn:hover,.af-filter-btn.active{background:var(--glow-blue);border-color:var(--blue)33;color:var(--blue)}
.af-list{max-height:350px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-sm)}
.af-item{padding:6px 12px;border-bottom:1px solid var(--border)33;font-size:11px;display:flex;gap:10px;align-items:center;transition:background .1s}
.af-item:last-child{border-bottom:none}
.af-item:hover{background:var(--surface2)}
.af-time{color:var(--muted);min-width:44px;flex-shrink:0;font-family:var(--font-mono);font-size:10px}
.af-agent{min-width:20px;flex-shrink:0}
.af-type{font-size:9px;padding:2px 8px;border-radius:12px;white-space:nowrap;font-weight:600;min-width:54px;text-align:center}
.af-type.browser{color:var(--blue);background:var(--glow-blue);border:1px solid var(--blue)22}
.af-type.file{color:var(--teal);background:var(--teal)08;border:1px solid var(--teal)22}
.af-type.shell{color:var(--orange);background:var(--orange)08;border:1px solid var(--orange)22}
.af-type.error{color:var(--red);background:var(--red)08;border:1px solid var(--red)22}
.af-type.other{color:var(--muted);background:var(--surface2);border:1px solid var(--border)}
.af-desc{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;opacity:.8}
.compare-stat .lbl{color:var(--muted)}
.compare-stat .val{color:var(--text);font-weight:600;font-family:var(--font-mono);font-size:11px}
.compare-delta{font-size:9px;margin-left:6px}
.delta-pos{color:var(--green)}.delta-neg{color:var(--red)}.delta-zero{color:var(--muted)}

/* ── Misc ── */
.empty{padding:60px;text-align:center;color:var(--muted);font-size:13px}
#refresh{position:fixed;bottom:12px;right:16px;font-size:10px;color:var(--muted);font-family:var(--font-mono);display:flex;align-items:center;gap:4px}
#refresh.spin{color:var(--blue)}
#refresh-interval{font-size:10px;padding:1px 2px;border-radius:3px;background:var(--surface);border:1px solid var(--border);color:var(--muted);font-family:var(--font-mono);cursor:pointer}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--border-light)}
.thinking-cell:hover{background:var(--surface2)22}

.raw-messages-btn{font-size:11px;padding:3px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface2);cursor:pointer;color:var(--fg);margin-bottom:8px;display:inline-block}
.raw-messages-btn:hover{background:var(--surface3)}
.raw-messages-panel{margin-top:12px;border-top:1px solid var(--border);padding-top:12px}
.raw-msg-card{margin:4px 0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.raw-msg-head{padding:6px 10px;display:flex;gap:8px;align-items:center;cursor:pointer;font-size:11px;background:var(--surface2);user-select:none}
.raw-msg-head:hover{background:var(--surface3)}
.raw-msg-body{display:none;padding:8px}
.raw-msg-body.open{display:block}
.raw-msg-body pre{margin:0;white-space:pre-wrap;word-break:break-all;font-size:10px;max-height:400px;overflow:auto;background:var(--surface3);padding:8px;border-radius:4px;color:var(--fg)}
.raw-role{padding:1px 6px;border-radius:3px;font-weight:600;font-size:10px;color:#fff}
.raw-role-user{background:var(--blue)}
.raw-role-assistant{background:var(--green)}
.raw-role-toolResult{background:var(--orange)}
.raw-role-unknown{background:var(--border)}
.raw-msg-actions{margin-left:auto;display:flex;gap:4px}
.raw-msg-actions button{font-size:10px;padding:1px 6px;border:1px solid var(--border);border-radius:3px;background:var(--surface);cursor:pointer;color:var(--fg)}
.raw-msg-actions button:hover{background:var(--surface3)}
.raw-panel-actions{margin-bottom:8px;display:flex;gap:6px}

</style>
</head>
<body>

<div id="sidebar">
  <div id="sidebar-head">🦞 Agents</div>
  <!-- sidebar-head text is updated dynamically by toggleLang/init -->
  <div id="agent-list"></div>
</div>

<div id="main">
  <div id="topbar">
    <button id="sidebar-toggle" class="sidebar-toggle-btn" onclick="toggleSidebar()" title="Toggle sidebar">☰</button>
    <button id="back-btn" class="back-btn" onclick="goHome()" style="display:none" title="Back to overview">←</button>
    <span id="agent-title" style="cursor:pointer" onclick="if(selectedId)goHome()"></span>
    <span id="pill-model" class="pill model" style="display:none"></span>
    <span id="pill-ctx"   class="pill"       style="display:none"></span>
    <div id="budget-wrap"                     style="display:none">
      <div id="budget-label"><span class="lbl"></span><span class="proj"></span></div>
      <div id="budget-track"><div id="budget-fill"></div></div>
    </div>
    <button id="lang-btn" class="compare-mode-btn" onclick="toggleLang()">中</button>
    <button id="theme-btn" class="compare-mode-btn" onclick="toggleTheme()">☀</button>
    <button id="display-mode-btn" class="compare-mode-btn" onclick="toggleDisplayMode()">Token</button>
    <button id="compare-mode-btn" class="compare-mode-btn" onclick="toggleCompareMode()" style="display:none">Compare</button>
    <button id="reset-toggle-btn" class="compare-mode-btn" onclick="toggleResetFiles()"></button>
    <div id="daily-pill"><span class="amt"></span> <span class="m"></span></div>
  </div>
  <div id="content"><div class="empty"></div></div>
</div>

<div id="refresh"><span id="refresh-text"></span> <select id="refresh-interval" onchange="changeRefreshInterval(this.value)"><option value="5000">5s</option><option value="10000">10s</option><option value="30000">30s</option><option value="60000">60s</option></select></div>


<script>
let DATA = null;
let selectedId = null;
let openHbIdx  = null;
let openHbKey  = null; // stable identifier (startTime) for the open heartbeat
const expandedSteps = {};
const expandedStepsKeys = {}; // maps startTime -> Set of expanded step indices
const rawPanelOpen = {};      // hbIdx -> true if raw panel is open
const rawPanelOpenKeys = {};  // startTime -> true if raw panel is open
let compareMode = false;
let compareHbs = []; // [hbIdx1, hbIdx2]
let compareHbKeys = []; // stable identifiers for compared heartbeats
let agentOverviewOpen = true;
const expandedFullIds = new Set(); // tracks expanded result/thinking element IDs
let hbPage = 0;
const HB_PAGE_SIZE = 20;
let includeReset = localStorage.getItem('includeReset') === '1';
let refreshMs = parseInt(localStorage.getItem('refreshMs')) || 5000;
let refreshTimer = null;

// Get a stable key for a heartbeat (startTime or fallback)
function hbKey(hb) { return hb.startTime || null; }

// After data refresh, remap index-based state to match new data order
function remapHbIndices(agent) {
  if (!agent || !agent.heartbeats) return;
  const hbs = agent.heartbeats;

  // Remap openHbIdx
  if (openHbKey) {
    const newIdx = hbs.findIndex(h => hbKey(h) === openHbKey);
    openHbIdx = newIdx >= 0 ? newIdx : null;
    if (openHbIdx === null) openHbKey = null;
  }

  // Remap expandedSteps: transfer from key-based store to index-based
  const newExpanded = {};
  for (let i = 0; i < hbs.length; i++) {
    const k = hbKey(hbs[i]);
    if (k && expandedStepsKeys[k]) {
      newExpanded[i] = expandedStepsKeys[k];
    }
  }
  // Clear and repopulate expandedSteps
  for (const k of Object.keys(expandedSteps)) delete expandedSteps[k];
  Object.assign(expandedSteps, newExpanded);

  // Remap rawPanelOpen
  const newRawOpen = {};
  for (let i = 0; i < hbs.length; i++) {
    const k = hbKey(hbs[i]);
    if (k && rawPanelOpenKeys[k]) newRawOpen[i] = true;
  }
  for (const k of Object.keys(rawPanelOpen)) delete rawPanelOpen[k];
  Object.assign(rawPanelOpen, newRawOpen);

  // Remap compareHbs
  if (compareHbKeys.length) {
    compareHbs = compareHbKeys.map(k => hbs.findIndex(h => hbKey(h) === k)).filter(i => i >= 0);
    compareHbKeys = compareHbs.map(i => hbKey(hbs[i])).filter(Boolean);
  }
}

let displayMode = localStorage.getItem('displayMode') || 'cost'; // 'cost' | 'token'
let theme = localStorage.getItem('theme') || 'dark'; // 'dark' | 'light'
if (theme === 'light') document.documentElement.classList.add('light');

// ── i18n ──────────────────────────────────────────────────────────────────────
const I18N = {
  en: {
    agents: 'Agents',
    openclawTrace: 'OpenClaw Trace',
    toggleSidebar: 'Toggle sidebar',
    backToOverview: 'Back to overview',
    compare: 'Compare',
    exitCompare: 'Exit Compare',
    allAgents: 'All agents',
    agent: 'Agent',
    health: 'Health',
    heartbeats: 'Heartbeats',
    avgCostPerHb: 'Avg $/hb',
    avgTokPerHb: 'Avg tok/hb',
    sessionCost: 'Session cost',
    sessionTokens: 'Session tokens',
    lastRun: 'Last run',
    costByAgent: 'Cost',
    tokensByAgent: 'Tokens',
    byAgentSuffix: 'by agent (session)',
    sevenDaySpend: '7-day spend',
    sevenDayTokens: '7-day tokens',
    activityByHour: 'Activity by hour (today)',
    sessionOverview: 'Session overview',
    avgCostHb: 'Avg cost / hb',
    avgTokHb: 'Avg tok / hb',
    cacheHitRate: 'Cache hit rate',
    costPerHb: 'Cost per heartbeat',
    tokensPerHb: 'Tokens per heartbeat',
    contextGrowth: 'Context growth over heartbeats',
    costPerStep: '💰 Cost per step',
    tokensPerStep: '🔢 Tokens per step',
    toolUsage: '🔧 Tool usage',
    costBreakdown: '📊 Cost breakdown',
    tokenBreakdown: '📊 Token breakdown',
    input: 'Input',
    output: 'Output',
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    toolResults: 'Tool results',
    total: 'Total',
    time: 'Time',
    dur: 'Dur',
    action: 'Action',
    result: 'Result',
    outTok: 'Out tok',
    cacheR: 'Cache R',
    ctx: 'Ctx',
    cost: 'Cost',
    tokens: 'Tokens',
    thinking: 'Thinking',
    thinkingLabel: '💭 Thinking',
    noToolCalls: 'No tool calls — model reasoning step',
    noSteps: 'No steps',
    noHeartbeats: 'No heartbeats recorded yet',
    selectAgent: '← select an agent',
    noData: 'No data',
    noCostData: 'No cost data',
    noTrendData: 'No trend data',
    noToolsUsed: 'No tools used',
    noDurationData: 'No duration data',
    session1: 'Session 1',
    session2Delta: 'Session 2 (delta)',
    steps: 'Steps',
    context: 'Context',
    cacheHit: 'Cache hit',
    duration: 'Duration',
    errors: 'Errors',
    errorLog: 'Error Log',
    noErrors: 'No errors',
    noErrorsToday: 'No errors today',
    actionsFeed: 'Actions feed (today)',
    all: 'All',
    browser: 'Browser',
    files: 'Files',
    shell: 'Shell',
    other: 'Other',
    noActionsRecorded: 'No actions recorded',
    cleanupHeartbeats: '🗑 Cleanup heartbeats',
    pageOf: '{cur} / {total}',
    prevPage: '‹ Prev',
    nextPage: 'Next ›',
    resetFiles: 'Archive',
    showFull: 'Show full',
    collapse: 'Collapse',
    rawMessages: 'Raw Messages',
    rawMessagesHide: 'Hide Raw',
    expandJson: 'Expand',
    collapseJson: 'Collapse',
    copyJson: 'Copy JSON',
    copyAllJson: 'Copy All',
    cleanupConfirm: 'Delete all {count} heartbeat sessions for {name}?\\n\\nThis cannot be undone.',
    today: 'Today',
    yesterday: 'Yesterday',
    hbHealthTimeline: 'Heartbeat health timeline (today)',
    ok: 'ok',
    warn: 'warn',
    err: 'err',
    error: 'ERROR',
    solved: '✓ SOLVED',
    markSolved: 'Mark as solved',
    markAllSolved: '✓ All',
    compareMode: 'Compare mode:',
    select1st: 'Select 1st',
    select2nd: 'Select 2nd',
    clear: 'Clear',
    autoRefresh: '● auto-refresh',
    refreshed: '● refreshed',
    loading: '⟳ loading…',
    budget: 'Budget',
    api: 'API',
    tool: 'Tool',
    system: 'System',
    hb: 'hb',
    cache: 'cache',
    cached: 'cached',
    perHeartbeat: 'per heartbeat',
    step: 'step',
    todayLabel: 'today',
    cleanupFailed: 'Cleanup failed: ',
    markAllTitle: 'Mark all errors in this heartbeat as solved',
    copyApiAll: 'Copy API URL (all steps)',
    copyApiErrors: 'Copy API URL (errors only)',
    clickRowFull: 'Click row to see full text',
    optimizationHints: '⚠ Optimization hints',
    yest: 'Yest',
    model: 'Model',
  },
  zh: {
    agents: '代理',
    openclawTrace: 'OpenClaw Trace',
    toggleSidebar: '切换侧边栏',
    backToOverview: '返回概览',
    compare: '对比',
    exitCompare: '退出对比',
    allAgents: '所有代理',
    agent: '代理',
    health: '健康',
    heartbeats: '心跳',
    avgCostPerHb: '均$/hb',
    avgTokPerHb: '均tok/hb',
    sessionCost: '会话花费',
    sessionTokens: '会话 Token',
    lastRun: '最近运行',
    costByAgent: '花费',
    tokensByAgent: 'Token',
    byAgentSuffix: '按代理（会话）',
    sevenDaySpend: '7日花费',
    sevenDayTokens: '7日 Token',
    activityByHour: '按小时活跃度（今日）',
    sessionOverview: '会话概览',
    avgCostHb: '均花费 / hb',
    avgTokHb: '均 tok / hb',
    cacheHitRate: '缓存命中率',
    costPerHb: '每次心跳花费',
    tokensPerHb: '每次心跳 Token',
    contextGrowth: '上下文增长趋势',
    costPerStep: '💰 每步花费',
    tokensPerStep: '🔢 每步 Token',
    toolUsage: '🔧 工具使用',
    costBreakdown: '📊 花费明细',
    tokenBreakdown: '📊 Token 明细',
    input: '输入',
    output: '输出',
    cacheRead: '缓存读取',
    cacheWrite: '缓存写入',
    toolResults: '工具结果',
    total: '合计',
    time: '时间',
    dur: '时长',
    action: '操作',
    result: '结果',
    outTok: '输出 tok',
    cacheR: '缓存读',
    ctx: '上下文',
    cost: '花费',
    tokens: 'Token',
    thinking: '思考',
    thinkingLabel: '💭 思考',
    noToolCalls: '无工具调用 — 模型推理步骤',
    noSteps: '无步骤',
    noHeartbeats: '尚无心跳记录',
    selectAgent: '← 选择一个代理',
    noData: '无数据',
    noCostData: '无花费数据',
    noTrendData: '无趋势数据',
    noToolsUsed: '未使用工具',
    noDurationData: '无时长数据',
    session1: '会话 1',
    session2Delta: '会话 2（差异）',
    steps: '步骤',
    context: '上下文',
    cacheHit: '缓存命中',
    duration: '时长',
    errors: '错误',
    errorLog: '错误日志',
    noErrors: '无错误',
    noErrorsToday: '今日无错误',
    actionsFeed: '操作流（今日）',
    all: '全部',
    browser: '浏览器',
    files: '文件',
    shell: '命令行',
    other: '其他',
    noActionsRecorded: '无操作记录',
    cleanupHeartbeats: '🗑 清理心跳',
    pageOf: '{cur} / {total}',
    prevPage: '‹ 上一页',
    nextPage: '下一页 ›',
    resetFiles: '归档',
    showFull: '展开全部',
    collapse: '收起',
    rawMessages: '原始消息',
    rawMessagesHide: '隐藏原始',
    expandJson: '展开',
    collapseJson: '收起',
    copyJson: '复制 JSON',
    copyAllJson: '复制全部',
    cleanupConfirm: '删除 {name} 的全部 {count} 条心跳会话？\\n\\n此操作不可撤销。',
    today: '今天',
    yesterday: '昨天',
    hbHealthTimeline: '心跳健康时间线（今日）',
    ok: '正常',
    warn: '警告',
    err: '错误',
    error: '错误',
    solved: '✓ 已解决',
    markSolved: '标记已解决',
    markAllSolved: '✓ 全部',
    compareMode: '对比模式：',
    select1st: '选择第1项',
    select2nd: '选择第2项',
    clear: '清除',
    autoRefresh: '● 自动刷新',
    refreshed: '● 已刷新',
    loading: '⟳ 加载中…',
    budget: '预算',
    api: 'API',
    tool: '工具',
    system: '系统',
    hb: 'hb',
    cache: '缓存',
    cached: '缓存',
    perHeartbeat: '每次心跳',
    step: '步骤',
    todayLabel: '今日',
    cleanupFailed: '清理失败：',
    markAllTitle: '标记此心跳中的所有错误为已解决',
    copyApiAll: '复制 API URL（全部步骤）',
    copyApiErrors: '复制 API URL（仅错误）',
    clickRowFull: '点击行查看完整文本',
    optimizationHints: '⚠ 优化提示',
    yest: '昨',
    model: '模型',
  }
};
let lang = localStorage.getItem('lang') || 'en';
const t = key => (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
function trendLabel(d) {
  if (d.dayOffset === 0) return t('today');
  if (d.dayOffset === 1) return t('yest');
  if (d.date) { const dt = new Date(d.date+'T12:00:00'); return dt.toLocaleDateString(lang==='zh'?'zh-CN':'en',{weekday:'short'}).slice(0,3); }
  return d.label;
}
function dailyLabel(d) {
  if (d.dayOffset === 0) return t('today');
  if (d.dayOffset === 1) return t('yesterday');
  if (d.date) { const dt = new Date(d.date+'T12:00:00'); return dt.toLocaleDateString(lang==='zh'?'zh-CN':'en',{weekday:'short'}); }
  return d.label;
}

// ── Solved Errors Tracking ────────────────────────────────────────────────────
// Store solved errors by agentId:hbStartTime:stepIdx:resultIdx
// Using startTime (stable) instead of array index (shifts when new heartbeats arrive)
let solvedErrors = {};
try {
  const stored = localStorage.getItem('solvedErrors');
  if (stored) solvedErrors = JSON.parse(stored);
} catch {}

function saveSolvedErrors() {
  try {
    localStorage.setItem('solvedErrors', JSON.stringify(solvedErrors));
  } catch {}
}

function getErrorKey(agentId, hbId, stepIdx, resultIdx) {
  return agentId + ':' + hbId + ':' + stepIdx + ':' + resultIdx;
}

function isErrorSolved(agentId, hbId, stepIdx, resultIdx) {
  const key = getErrorKey(agentId, hbId, stepIdx, resultIdx);
  return solvedErrors[key] === true;
}

function markErrorSolved(agentId, hbId, stepIdx, resultIdx) {
  const key = getErrorKey(agentId, hbId, stepIdx, resultIdx);
  solvedErrors[key] = true;
  saveSolvedErrors();

  // Reload the current agent view to update error counts
  if (!DATA) return;
  const a = DATA.agents.find(a => a.id === selectedId);
  if (a) {
    // Recalculate error counts for this agent
    recalculateErrorCounts(a);
    renderAgent(a);
    renderSidebar();
  }
}

function markAllErrorsSolved(hbIdx) {
  if (!DATA || !selectedId) return;
  const agent = DATA.agents.find(a => a.id === selectedId);
  if (!agent || !agent.heartbeats || !agent.heartbeats[hbIdx]) return;

  const hb = agent.heartbeats[hbIdx];
  const hbId = hb.startTime || hbIdx;
  let markedCount = 0;

  // Iterate through all steps and tool results in this heartbeat
  for (let stepIdx = 0; stepIdx < (hb.steps || []).length; stepIdx++) {
    const step = hb.steps[stepIdx];
    const results = step.toolResults || [];

    for (let resultIdx = 0; resultIdx < results.length; resultIdx++) {
      const tr = results[resultIdx];
      if (hasErrorInResult(tr) && !isErrorSolved(selectedId, hbId, stepIdx, resultIdx)) {
        const key = getErrorKey(selectedId, hbId, stepIdx, resultIdx);
        solvedErrors[key] = true;
        markedCount++;
      }
    }
  }

  if (markedCount > 0) {
    saveSolvedErrors();
    recalculateErrorCounts(agent);
    renderAgent(agent);
    renderSidebar();
  }
}

function recalculateErrorCounts(agent) {
  // Recalculate error counts for all heartbeats, excluding solved errors
  for (let hbIdx = 0; hbIdx < (agent.heartbeats || []).length; hbIdx++) {
    const hb = agent.heartbeats[hbIdx];
    const hbId = hb.startTime || hbIdx;
    let errorCount = 0;

    for (let stepIdx = 0; stepIdx < (hb.steps || []).length; stepIdx++) {
      const step = hb.steps[stepIdx];
      const results = step.toolResults || [];

      for (let resultIdx = 0; resultIdx < results.length; resultIdx++) {
        const tr = results[resultIdx];
        if (hasErrorInResult(tr) && !isErrorSolved(agent.id, hbId, stepIdx, resultIdx)) {
          errorCount++;
        }
      }
    }

    hb.errorCount = errorCount;
  }

  // Recalculate total errors for agent
  agent.totalErrors = agent.heartbeats.reduce((sum, hb) => sum + (hb.errorCount || 0), 0);
}

function hasErrorInResult(toolResult) {
  if (toolResult.isError) return true;
  const preview = toolResult.preview || '';
  try {
    const parsed = JSON.parse(preview);
    if (parsed.status === 'error' || parsed.error) return true;
  } catch {
    if (preview.includes('"status": "error"') || preview.includes('"status":"error"')) return true;
  }
  return false;
}

// ── Formatters ────────────────────────────────────────────────────────────────
const f$  = n => '$' + (+n||0).toFixed(4);
const fTk = n => { n = +n || 0; if (n >= 1e9) return (n/1e9).toFixed(1) + 'G'; if (n >= 1e6) return (n/1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n/1e3).toFixed(1) + 'K'; return n.toString(); };
const dVal = (costVal, tokenVal) => displayMode === 'cost' ? costVal : tokenVal;
const dFmt = (costVal, tokenVal) => displayMode === 'cost' ? f$(costVal) : fTk(tokenVal);
const fN  = n => (+n||0).toLocaleString();
const fT  = ts => { if(!ts) return '—'; const d=new Date(ts); const mm=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0'); const hh=String(d.getHours()).padStart(2,'0'); const mi=String(d.getMinutes()).padStart(2,'0'); const ss=String(d.getSeconds()).padStart(2,'0'); return mm+'-'+dd+' '+hh+':'+mi+':'+ss; };
const fD  = ms => { if(!ms) return '—'; const s=Math.round(ms/1000); return s<60?s+'s':s<3600?Math.floor(s/60)+'m':Math.floor(s/3600)+'h'; };
const fmtSize = n => { if(!n) return '—'; if(n>=1000000) return (n/1000000).toFixed(1)+'M'; if(n>=1000) return (n/1000).toFixed(1)+'k'; return n.toString(); };
const fAgo= ms => {
  if(!ms) return '';
  const s = Math.round((Date.now()-ms)/1000);
  return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':s<86400?Math.floor(s/3600)+'h ago':Math.floor(s/86400)+'d ago';
};
const fModel = m => (m||'').replace('claude-','').replace(/-20\\d{6}$/,'');
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fSz = n => { if(!n) return '—'; if(n>=1000000) return (n/1000000).toFixed(1)+'M'; if(n>=1000) return (n/1000).toFixed(1)+'k'; return n+'c'; };

// ── SVG helpers ──────────────────────────────────────────────────────────────
function svgBars(vals, h, color, tipFn) {
  if (!vals.length) return '<svg></svg>';
  const maxV = Math.max(...vals, 1e-9);
  const W = 600, padL = 50, padR = 10, padT = 14, padB = 24;
  const chartW = W - padL - padR, chartH = h - padT - padB;
  const barW = Math.max(6, Math.floor(chartW / vals.length) - 4);
  const gap = Math.max(2, Math.floor((chartW - vals.length * barW) / Math.max(vals.length, 1)));

  // Y-axis grid + labels
  const ySteps = 3;
  const grid = Array.from({length: ySteps + 1}, (_, i) => {
    const v = maxV * (1 - i / ySteps);
    const y = padT + (i * chartH / ySteps);
    return \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="var(--border)" stroke-width="1"/>
      <text x="\${padL - 6}" y="\${y + 3}" fill="var(--muted2)" font-size="9" text-anchor="end" font-family="var(--font-mono)">\${displayMode==='cost'?f$(v):fTk(v)}</text>\`;
  }).join('');

  const bars = vals.map((v, i) => {
    const bh = Math.max(2, Math.round((v / maxV) * chartH));
    const x = padL + i * (barW + gap) + gap / 2;
    const y = padT + chartH - bh;
    const opacity = 0.5 + 0.5 * (v / maxV);
    return \`<g>
      <rect x="\${x}" y="\${y}" width="\${barW}" height="\${bh}" fill="\${color}" rx="3" opacity="\${opacity.toFixed(2)}"><title>\${tipFn ? tipFn(v, i) : v}</title></rect>
      <text x="\${x + barW / 2}" y="\${y - 4}" fill="var(--chart-label)" font-size="8" text-anchor="middle" font-family="var(--font-mono)">\${displayMode==='cost'?f$(v):fTk(v)}</text>
      <text x="\${x + barW / 2}" y="\${h - 6}" fill="var(--muted2)" font-size="9" text-anchor="middle">#\${i + 1}</text>
    </g>\`;
  }).join('');

  return \`<svg viewBox="0 0 \${W} \${h}" width="100%" height="\${h}" style="display:block">\${grid}\${bars}</svg>\`;
}

function svgLine(vals, h, color) {
  const n = vals.length;
  if (n < 2) return '<svg></svg>';
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals, 1);
  const range = maxV - minV || 1;
  const W = 600, padL = 56, padR = 10, padT = 14, padB = 24;
  const chartW = W - padL - padR, chartH = h - padT - padB;

  // Y-axis grid + labels
  const ySteps = 3;
  const grid = Array.from({length: ySteps + 1}, (_, i) => {
    const v = maxV - (i / ySteps) * range;
    const y = padT + (i * chartH / ySteps);
    return \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="var(--border)" stroke-width="1"/>
      <text x="\${padL - 6}" y="\${y + 3}" fill="var(--muted2)" font-size="9" text-anchor="end" font-family="var(--font-mono)">\${fN(Math.round(v))}</text>\`;
  }).join('');

  // Data points + line
  const points = vals.map((v, i) => {
    const x = padL + Math.round(i * chartW / (n - 1));
    const y = padT + Math.round((1 - (v - minV) / range) * chartH);
    return { x, y, v };
  });
  const pts = points.map(p => p.x + ',' + p.y).join(' ');

  // Gradient fill under line
  const fillPts = \`\${padL},\${padT + chartH} \${pts} \${padL + chartW},\${padT + chartH}\`;

  // Dots + value labels (show first, last, max)
  const dots = points.map((p, i) => {
    const showLabel = i === 0 || i === n - 1 || p.v === maxV;
    return \`<circle cx="\${p.x}" cy="\${p.y}" r="3.5" fill="\${color}" stroke="var(--surface)" stroke-width="2"><title>#\${i + 1}: \${fN(Math.round(p.v))}</title></circle>
      \${showLabel ? \`<text x="\${p.x}" y="\${p.y - 8}" fill="var(--chart-label)" font-size="9" text-anchor="middle" font-family="var(--font-mono)">\${fN(Math.round(p.v))}</text>\` : ''}
    \`;
  }).join('');

  // X-axis labels
  const xLabels = points.map((p, i) =>
    \`<text x="\${p.x}" y="\${h - 6}" fill="var(--muted2)" font-size="9" text-anchor="middle">#\${i + 1}</text>\`
  ).join('');

  return \`<svg viewBox="0 0 \${W} \${h}" width="100%" height="\${h}" style="display:block">
    \${grid}
    <polygon points="\${fillPts}" fill="\${color}" opacity="0.06"/>
    <polyline points="\${pts}" fill="none" stroke="\${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    \${dots}
    \${xLabels}
  </svg>\`;
}

function svgToolBreakdown(steps) {
  const toolCounts = {};
  for (const s of steps) {
    for (const tc of (s.toolCalls || [])) {
      toolCounts[tc.name] = (toolCounts[tc.name] || 0) + 1;
    }
  }
  const entries = Object.entries(toolCounts).sort((a,b) => b[1] - a[1]).slice(0, 5);
  if (!entries.length) return '<div class="m" style="padding:20px;text-align:center;font-size:10px">'+t('noToolsUsed')+'</div>';

  const maxCount = Math.max(...entries.map(e => e[1]));
  const colors = {browser:'var(--blue)',read:'var(--teal)',write:'var(--teal)',edit:'var(--teal)',bash:'var(--orange)',grep:'var(--purple)',glob:'var(--purple)'};

  return entries.map(([tool, count]) => {
    const pct = Math.round((count / maxCount) * 100);
    const color = colors[tool] || 'var(--muted)';
    return \`<div style="margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <span style="color:var(--text);font-weight:500">\${tool}</span>
        <span style="color:var(--muted);font-family:var(--font-mono)">\${count}×</span>
      </div>
      <div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden">
        <div style="width:\${pct}%;height:100%;background:\${color};transition:width .3s;border-radius:4px"></div>
      </div>
    </div>\`;
  }).join('');
}

function svgDurationBreakdown(steps) {
  // Find top 5 slowest steps
  const stepDurations = steps.map((s, i) => ({
    index: i + 1,
    duration: s.durationMs || 0,
    text: (s.text || '').slice(0, 30) || 'Step ' + (i + 1)
  })).filter(s => s.duration > 0).sort((a, b) => b.duration - a.duration).slice(0, 5);

  if (!stepDurations.length) {
    return '<div class="m" style="padding:20px;text-align:center;font-size:10px">'+t('noDurationData')+'</div>';
  }

  const maxDuration = Math.max(...stepDurations.map(s => s.duration));

  return stepDurations.map(step => {
    const pct = Math.round((step.duration / maxDuration) * 100);
    const label = step.text.length > 30 ? step.text.slice(0, 27) + '...' : step.text;
    return \`<div style="margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px">
        <span style="color:var(--text)" title="\${esc(step.text)}">Step #\${step.index}</span>
        <span style="color:var(--muted)">\${fD(step.duration)}</span>
      </div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
        <div style="width:\${pct}%;height:100%;background:var(--orange);transition:width .3s"></div>
      </div>
    </div>\`;
  }).join('');
}

// ── Shared chart dimensions ──────────────────────────────────────────────────
const CHART_H = 180; // consistent height across all 3 charts

// ── Chart 1: Cost by Agent (horizontal bar) ─────────────────────────────────
function svgCostByAgent(agents) {
  const valFn = a => dVal(a.totalCost, a.totalTokensSum || 0);
  const sorted = agents.filter(a => valFn(a) > 0).sort((a,b) => valFn(b) - valFn(a));
  if (!sorted.length) return '<div class="m" style="padding:20px;text-align:center">No data</div>';
  const maxVal = valFn(sorted[0]);
  const totalVal = agents.reduce((s,x) => s + valFn(x), 0);
  const n = sorted.length;
  const barH = Math.min(22, Math.floor((CHART_H - 4) / n) - 4);
  const gap = Math.min(4, Math.floor((CHART_H - n * barH) / Math.max(n - 1, 1)));
  const labelW = 80, chartW = 180, valW = 100;
  const totalW = labelW + chartW + valW;
  const bars = sorted.map((a, i) => {
    const v = valFn(a);
    const y = i * (barH + gap) + 2;
    const w = Math.max(2, (v / maxVal) * chartW);
    const share = totalVal > 0 ? ((v / totalVal) * 100).toFixed(0) + '%' : '';
    const label = dFmt(a.totalCost, a.totalTokensSum || 0);
    return \`<g>
      <text x="\${labelW - 6}" y="\${y + barH/2 + 4}" fill="var(--text)" font-size="11" text-anchor="end">\${esc(a.emoji)} \${esc(a.name.replace(' Promo',''))}</text>
      <rect x="\${labelW}" y="\${y}" width="\${w.toFixed(1)}" height="\${barH}" rx="3" fill="var(--blue)" opacity="0.8"><title>\${a.emoji} \${a.name}: \${label}</title></rect>
      <text x="\${labelW + w + 6}" y="\${y + barH/2 + 4}" fill="var(--chart-label)" font-size="10">\${label} <tspan fill="var(--muted2)">\${share}</tspan></text>
    </g>\`;
  }).join('');
  return \`<svg width="100%" viewBox="0 0 \${totalW} \${CHART_H}" style="display:block">\${bars}</svg>\`;
}

// ── Chart 2: 7-Day Daily Spend (vertical bar) ──────────────────────────────
function svgDailySpend(trendData) {
  if (!trendData || trendData.length < 1) return '<div class="m" style="padding:20px;text-align:center">'+t('noTrendData')+'</div>';
  const W = 360, padL = 45, padR = 10, padT = 16, padB = 28;
  const chartW = W - padL - padR, chartH = CHART_H - padT - padB;
  const n = trendData.length;
  const vals = trendData.map(d => dVal(d.total, d.tokens || 0));
  const maxV = Math.max(...vals, 0.01);
  const barW = Math.min(36, Math.floor(chartW / n) - 8);
  const gap = (chartW - n * barW) / (n + 1);
  const fmtV = v => displayMode === 'cost' ? f$(v) : fTk(v);

  // Grid lines
  const ySteps = 3;
  const gridLines = Array.from({length: ySteps + 1}, (_, i) => {
    const v = maxV * (1 - i / ySteps);
    const y = padT + (i * chartH / ySteps);
    return \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="var(--border)" stroke-width="1"/>
      <text x="\${padL - 6}" y="\${y + 3}" fill="var(--muted2)" font-size="9" text-anchor="end">\${fmtV(v)}</text>\`;
  }).join('');

  const bars = trendData.map((d, i) => {
    const v = vals[i];
    const x = padL + gap + i * (barW + gap);
    const barH = Math.max(1, (v / maxV) * chartH);
    const y = padT + chartH - barH;
    const isToday = i === n - 1;
    const color = 'var(--blue)';
    const opacity = isToday ? '0.9' : '0.45';
    return \`<g>
      <rect x="\${x}" y="\${y}" width="\${barW}" height="\${barH.toFixed(1)}" rx="3" fill="\${color}" opacity="\${opacity}"><title>\${esc(trendLabel(d))}: \${fmtV(v)}</title></rect>
      <text x="\${x + barW/2}" y="\${y - 4}" fill="var(--chart-label)" font-size="9" text-anchor="middle">\${fmtV(v)}</text>
      <text x="\${x + barW/2}" y="\${CHART_H - 6}" fill="var(--muted2)" font-size="9" text-anchor="middle">\${esc(trendLabel(d))}</text>
    </g>\`;
  }).join('');

  return \`<svg width="100%" viewBox="0 0 \${W} \${CHART_H}" style="display:block">\${gridLines}\${bars}</svg>\`;
}

// ── Chart 3: Activity by Hour (vertical bar) ────────────────────────────────
function svgHourlyActivity(agents) {
  const hourBuckets = new Array(24).fill(0);
  const hourCosts = new Array(24).fill(0);
  for (const a of agents) {
    for (const hb of (a.heartbeats || [])) {
      if (!hb.startTime) continue;
      const h = new Date(hb.startTime).getHours();
      hourBuckets[h]++;
      hourCosts[h] += dVal(hb.totalCost || 0, hb.totalTokensSum || 0);
    }
  }
  const maxCount = Math.max(...hourBuckets, 1);
  const W = 420, padL = 4, padB = 24, padT = 16;
  const chartH = CHART_H - padT - padB;
  const barW = 14, gap = 3;
  const bars = hourBuckets.map((count, h) => {
    const x = padL + h * (barW + gap);
    const barH = Math.max(1, (count / maxCount) * chartH);
    const y = padT + chartH - barH;
    const opacity = count > 0 ? 0.4 + 0.6 * (count / maxCount) : 0.15;
    const color = count > 0 ? 'var(--blue)' : 'var(--border)';
    const tip = \`\${String(h).padStart(2,'0')}:00 — \${count} \${t('heartbeats')}, \${displayMode === 'cost' ? f$(hourCosts[h]) : fTk(hourCosts[h])}\`;
    return \`<g>
      <rect x="\${x}" y="\${y}" width="\${barW}" height="\${barH.toFixed(1)}" rx="2" fill="\${color}" opacity="\${opacity.toFixed(2)}"><title>\${esc(tip)}</title></rect>
      \${count > 0 ? \`<text x="\${x + barW/2}" y="\${y - 3}" fill="var(--muted)" font-size="8" text-anchor="middle">\${count}</text>\` : ''}
      \${h % 3 === 0 ? \`<text x="\${x + barW/2}" y="\${CHART_H - 4}" fill="var(--muted2)" font-size="9" text-anchor="middle">\${String(h).padStart(2,'0')}</text>\` : ''}
    </g>\`;
  }).join('');
  return \`<svg width="100%" viewBox="0 0 \${W} \${CHART_H}" style="display:block">\${bars}</svg>\`;
}

// ── Tool helpers ──────────────────────────────────────────────────────────────
function describeCall(name, args) {
  if (name === 'browser') {
    const act = args.action || '';
    const req = args.request || {};
    if (act === 'navigate') {
      const u = args.targetUrl || '';
      try { const p = new URL(u).pathname; return 'nav → '+p.slice(0,42); } catch { return 'nav → '+u.slice(0,42); }
    }
    if (act === 'act') {
      const k = req.kind || '';
      if (k === 'evaluate') return 'eval (fn '+((req.fn||'').length)+'c)';
      if (k === 'snapshot') return 'snapshot'+(req.selector?' ['+req.selector.slice(0,18)+']':'');
      if (k === 'wait')     return 'wait '+req.timeMs+'ms';
      if (k === 'click')    return 'click '+(req.ref||'');
      if (k === 'type')     return 'type "'+((req.text||'').slice(0,22))+'"';
      if (k === 'press')    return 'press '+(req.key||'');
      if (k === 'scroll')   return 'scroll';
      return 'act:'+k;
    }
    if (act === 'tabs')  return 'tabs';
    if (act === 'open')  return 'open browser';
    if (act === 'close') return 'close';
    return act || 'browser';
  }
  const p = args.file_path || args.path || '';
  if (name === 'read' || name === 'write' || name === 'edit') {
    return p.replace(/.*workspace-promo-assistant-[^/]+\\//, '').replace(/.*\\.openclaw\\//, '~/').slice(0,45);
  }
  if (name === 'glob')  return args.pattern || '';
  if (name === 'grep')  return '/'+(args.pattern||'').slice(0,28)+'/';
  if (name === 'bash')  return (args.command||'').replace(/\\s+/g,' ').slice(0,50);
  return name;
}

function toolChipClass(name) {
  if (name === 'browser') return 't-browser';
  if (name === 'read' || name === 'write' || name === 'edit') return 't-read';
  if (name === 'bash') return 't-bash';
  return 't-other';
}

function toolFreqBar(steps) {
  const freq = {};
  const browserBreakdown = {};
  for (const s of steps) {
    for (const tc of (s.toolCalls||[])) {
      freq[tc.name] = (freq[tc.name]||0)+1;
      if (tc.name === 'browser') {
        const act = tc.args?.action || '';
        const kind = tc.args?.request?.kind || '';
        const label = act==='act' ? kind||act : act;
        browserBreakdown[label] = (browserBreakdown[label]||0)+1;
      }
    }
  }
  if (!Object.keys(freq).length) return '';
  const chips = Object.entries(freq)
    .sort((a,b) => b[1]-a[1])
    .map(([name, count]) => {
      let label = name+'×'+count;
      if (name==='browser' && Object.keys(browserBreakdown).length) {
        const detail = Object.entries(browserBreakdown).map(([k,v])=>k+'×'+v).join(' ');
        label += ' <span class="m" style="font-size:9px;opacity:.7">('+esc(detail)+')</span>';
      }
      return \`<span class="tf-chip \${toolChipClass(name)}">\${label}</span>\`;
    }).join('');
  return \`<div class="tool-freq"><span class="tool-freq-label">Tools</span>\${chips}</div>\`;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  if (!DATA) return;
  const agents = DATA.agents || [];
  document.getElementById('agent-list').innerHTML = agents.map(a => {
    const last = a.heartbeats?.[0];
    const cls  = a.id===selectedId ? 'active' : '';
    const cost = last ? dFmt(last.totalCost, last.totalTokensSum) : '—';
    const ago  = fAgo(a.lastTime);
    const hbn  = a.heartbeats?.length||0;
    const errBadge = a.totalErrors ? \`<span class="err-count">⚠\${a.totalErrors}</span>\` : '';

    // Live status dot
    const ageMs = a.lastTime ? Date.now() - a.lastTime : Infinity;
    const dotColor = ageMs < 900000 ? 'var(--green)' : ageMs < 3600000 ? 'var(--orange)' : 'var(--border)'; // 15min green, 1hr yellow, else grey
    const liveDot = \`<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:\${dotColor};margin-right:4px"></span>\`;

    return \`<div class="agent-row \${cls}" onclick="select('\${a.id}')">
      <div class="agent-name">\${liveDot}\${a.emoji} \${a.name} \${errBadge}</div>
      <div class="agent-sub">
        <span class="agent-cost \${!last?'no-data':''}">\${cost}</span>
        \${ago?\`<span>\${ago}</span>\`:''}
        \${hbn ?\`<span>\${hbn} hb</span>\`:''}
      </div>
    </div>\`;
  }).join('');
}

// ── Cross-agent overview ──────────────────────────────────────────────────────
function renderCrossAgentView() {
  if (!DATA) return;

  // Hide compare button in cross-agent view
  document.getElementById('compare-mode-btn').style.display = 'none';
  document.getElementById('agent-title').textContent = t('openclawTrace');
  document.getElementById('pill-model').style.display = 'none';
  document.getElementById('pill-ctx').style.display = 'none';

  const agents = DATA.agents || [];
  const daily  = DATA.dailySummary || [];

  const totalSessionCost = agents.reduce((s,a) => s + (a.totalCost||0), 0);
  const totalHbs = agents.reduce((s,a) => s + (a.heartbeats?.length||0), 0);

  const trendData = DATA.trendData || [];
  const costChart = svgCostByAgent(agents);
  const dailyChart = svgDailySpend(trendData);
  const activityChart = svgHourlyActivity(agents);

  const rows = agents.map(a => {
    const hbs = a.heartbeats?.length || 0;
    const avgCost = hbs ? a.totalCost / hbs : 0;
    const avgTokens = hbs ? (a.totalTokensSum || 0) / hbs : 0;
    const errBadge = a.totalErrors ? \`<span class="err-count">⚠\${a.totalErrors}</span>\` : '';
    const hbList = (a.heartbeats || []).slice().reverse();
    const dots = hbList.map(hb => {
      const errs = hb.errorCount || 0;
      const waste = (hb.wasteFlags || []).length;
      const cls = errs > 0 ? 'red' : waste > 0 ? 'yellow' : 'green';
      const tm = hb.startTime ? new Date(hb.startTime).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) : '?';
      const tip = tm + ' · ' + (errs ? errs+' '+t('err') : waste ? waste+' '+t('warn') : t('ok')) + ' · ' + dFmt(hb.totalCost, hb.totalTokensSum);
      return \`<span class="ht-dot \${cls}" title="\${esc(tip)}"></span>\`;
    }).join('');
    return \`<tr onclick="select('\${a.id}')">
      <td><div class="agent-cell">\${a.emoji} \${a.name} \${errBadge}</div></td>
      <td><div class="ht-dots">\${dots}</div></td>
      <td class="r">\${hbs}</td>
      <td class="r g">\${dFmt(avgCost, avgTokens)}</td>
      <td class="r g">\${dFmt(a.totalCost, a.totalTokensSum)}</td>
      <td class="m">\${fAgo(a.lastTime)}</td>
    </tr>\`;
  }).join('');

  return \`
    <div class="charts-row">
      <div class="chart-card">
        <div class="section-title">\${dVal(t('costByAgent'),t('tokensByAgent'))} \${t('byAgentSuffix')}</div>
        \${costChart}
      </div>
      <div class="chart-card">
        <div class="section-title">\${dVal(t('sevenDaySpend'),t('sevenDayTokens'))}</div>
        \${dailyChart}
      </div>
      <div class="chart-card">
        <div class="section-title">\${t('activityByHour')}</div>
        \${activityChart}
      </div>
    </div>
    <div class="section-title">\${t('allAgents')}</div>
    <table class="cross-agent-tbl">
      <thead>
        <tr>
          <th>\${t('agent')}</th>
          <th>\${t('health')}</th>
          <th class="r">\${t('heartbeats')}</th>
          <th class="r">\${dVal(t('avgCostPerHb'),t('avgTokPerHb'))}</th>
          <th class="r">\${dVal(t('sessionCost'),t('sessionTokens'))}</th>
          <th>\${t('lastRun')}</th>
        </tr>
      </thead>
      <tbody>\${rows}</tbody>
    </table>
    <div class="bottom-panels">
      \${renderActionsFeed(agents)}
      \${renderErrorPanel(agents)}
    </div>
  \`;
}

// ── Heartbeat Health Timeline ─────────────────────────────────────────────────
function renderHealthTimeline(agents) {
  const rows = agents.map(a => {
    const hbs = (a.heartbeats || []).slice().reverse(); // oldest first
    if (!hbs.length) return '';
    const dots = hbs.map(hb => {
      const errs = hb.errorCount || 0;
      const waste = (hb.wasteFlags || []).length;
      const cls = errs > 0 ? 'red' : waste > 0 ? 'yellow' : 'green';
      const tm = hb.startTime ? new Date(hb.startTime).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) : '?';
      const tip = tm + ' · ' + (errs ? errs+' '+t('err') : waste ? waste+' '+t('warn') : t('ok')) + ' · ' + dFmt(hb.totalCost, hb.totalTokensSum);
      return \`<span class="ht-dot \${cls}" title="\${esc(tip)}"></span>\`;
    }).join('');
    const greens = hbs.filter(h=>!h.errorCount && !(h.wasteFlags||[]).length).length;
    const reds = hbs.filter(h=>h.errorCount>0).length;
    const summary = hbs.length + ' ' + t('hb') + (reds ? ', ' + reds + ' ' + t('err') : '');
    return \`<div class="ht-row">
      <div class="ht-agent" onclick="select('\${a.id}')">\${a.emoji} \${a.name}</div>
      <div class="ht-dots">\${dots}</div>
      <div class="ht-summary">\${summary}</div>
    </div>\`;
  }).filter(Boolean).join('');
  if (!rows) return '';
  return \`<div class="health-timeline">
    <div class="section-title">\${t('hbHealthTimeline')}</div>
    \${rows}
  </div>\`;
}

// ── Error Log Panel ───────────────────────────────────────────────────────────
function collectErrors(agents) {
  const errors = [];
  for (const a of agents) {
    for (const hb of (a.heartbeats || [])) {
      // Tool-level errors from steps
      for (const s of (hb.steps || [])) {
        for (const tr of (s.toolResults || [])) {
          if (!hasErrorInResult(tr)) continue;
          const time = s.time || hb.startTime;
          const msg = (tr.preview || 'Unknown error').slice(0, 200);
          // Classify the error type
          let type = 'tool';
          if (msg.includes('timed out') || msg.includes('TimeoutError') || msg.includes('UNAVAILABLE')) type = 'browser';
          if (msg.includes('strict mode') || msg.includes('too many elements')) type = 'browser';
          errors.push({ time, agentId: a.id, emoji: a.emoji, name: a.name, msg, type });
        }
      }
      // API-level errors (empty responses from Anthropic)
      if (hb.apiErrors > 0) {
        const retries = hb.apiErrors;
        let msg = retries >= 3
          ? 'API: ' + retries + ' consecutive failures (rate limit / overloaded)'
          : retries === 2
            ? 'API: ' + retries + ' retries (transient error)'
            : 'API: empty response (transient)';
        if (hb.steps?.length <= 3 && hb.durationMs) {
          msg += ' — heartbeat aborted after ' + Math.round(hb.durationMs/1000) + 's, ' + hb.steps.length + ' step' + (hb.steps.length!==1?'s':'');
        }
        errors.push({ time: hb.endTime || hb.startTime, agentId: a.id, emoji: a.emoji, name: a.name, msg, type: 'api' });
      }
    }
  }

  // Add gateway-level errors (from log file)
  const gw = (DATA?.gatewayErrors || []);
  for (const ge of gw) {
    // Skip if we already have a matching JSONL-sourced API error for same agent+time
    if (ge.type === 'api' && ge.agentId && errors.some(e => e.type === 'api' && e.agentId === ge.agentId && Math.abs(new Date(e.time) - new Date(ge.time)) < 120000)) continue;
    const a = agents.find(x => x.id === ge.agentId);
    errors.push({
      time: ge.time,
      agentId: ge.agentId || null,
      emoji: a?.emoji || '⚡',
      name: a?.name || ge.agentId || 'system',
      msg: ge.msg,
      type: ge.type || 'system',
      detail: ge.detail,
    });
  }

  errors.sort((a,b) => (b.time||'') < (a.time||'') ? -1 : 1);
  return errors;
}

let errorFilterAgent = 'all';
let errorFilterType = 'all';

function renderErrorPanel(agents) {
  const allErrors = collectErrors(agents);
  const filtered = allErrors.filter(e => {
    if (errorFilterAgent !== 'all' && e.agentId !== errorFilterAgent) return false;
    if (errorFilterType !== 'all' && (e.type || 'tool') !== errorFilterType) return false;
    return true;
  });
  const hasErrors = allErrors.length > 0;
  const expanded = hasErrors; // auto-expand if errors exist

  const agentIds = [...new Set(allErrors.map(e => e.agentId).filter(Boolean))];
  const agentBtns = [\`<span class="error-filter-btn \${errorFilterAgent==='all'?'active':''}" onclick="filterErrors('all')">\${t('all')}</span>\`]
    .concat(agentIds.map(id => {
      const a = agents.find(x=>x.id===id);
      return \`<span class="error-filter-btn \${errorFilterAgent===id?'active':''}" onclick="filterErrors('\${id}')">\${a?.emoji||''} \${a?.name||id}</span>\`;
    })).join('');

  // Count by type
  const typeCounts = {};
  for (const e of allErrors) { typeCounts[e.type||'tool'] = (typeCounts[e.type||'tool'] || 0) + 1; }
  const typeLabels = { api: t('api'), browser: t('browser'), tool: t('tool'), system: t('system') };
  const typeColors = { api: 'var(--red)', browser: 'var(--orange)', tool: 'var(--orange)', system: 'var(--muted)' };

  const typeBtns = Object.entries(typeCounts).map(([type, count]) => {
    const label = typeLabels[type] || type;
    const color = typeColors[type] || 'var(--muted)';
    return \`<span class="error-filter-btn \${errorFilterType===type?'active':''}" onclick="filterErrorsByType('\${type}')" style="\${errorFilterType===type?'':'color:'+color}">\${count} \${label}</span>\`;
  }).join('');

  const summaryBadges = Object.entries(typeCounts).map(([type, count]) => {
    const label = typeLabels[type] || type;
    const color = typeColors[type] || 'var(--muted)';
    return \`<span class="error-type-summary" style="color:\${color}">\${count} \${label}</span>\`;
  }).join('');

  const items = filtered.slice(0, 50).map(e => {
    const t = e.time ? new Date(e.time).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) : '??';
    const type = e.type || 'tool';
    const typeLabel = typeLabels[type] || type;
    const typeColor = typeColors[type] || 'var(--muted)';
    return \`<div class="error-item">
      <span class="error-time">\${t}</span>
      <span class="error-agent" title="\${esc(e.name)}">\${e.emoji}</span>
      <span class="error-type-badge" style="background:\${typeColor}18;color:\${typeColor}">\${typeLabel}</span>
      <span class="error-msg" \${type==='api'?'style="color:var(--red)"':''}>\${esc(e.msg)}</span>
    </div>\`;
  }).join('');

  return \`<div class="error-panel \${hasErrors?'has-errors':''}">
    <div class="error-header" onclick="toggleErrorPanel()">
      <span class="error-title">\${t('errorLog')}</span>
      \${hasErrors
        ? \`<span class="error-badge">\${allErrors.length} \${t('errors')}</span><span class="error-type-counts">\${summaryBadges}</span>\`
        : \`<span class="error-ok-badge">\${t('noErrors')}</span>\`}
      <span class="hb-arrow" id="error-arrow">\${expanded?'▾':'▸'}</span>
    </div>
    <div class="error-body \${expanded?'open':''}" id="error-body">
      \${hasErrors ? \`<div class="error-filter">\${typeBtns}</div><div class="error-filter">\${agentBtns}</div>\` : ''}
      \${items || '<div style="padding:10px 12px;color:var(--muted);font-size:10px">'+t('noErrorsToday')+'</div>'}
    </div>
  </div>\`;
}

function toggleErrorPanel() {
  const body = document.getElementById('error-body');
  const arrow = document.getElementById('error-arrow');
  body.classList.toggle('open');
  arrow.textContent = body.classList.contains('open') ? '▾' : '▸';
}

function filterErrors(agentId) {
  errorFilterAgent = agentId;
  if (DATA && !selectedId) {
    document.getElementById('content').innerHTML = renderCrossAgentView();
  }
}

function filterErrorsByType(type) {
  errorFilterType = errorFilterType === type ? 'all' : type;
  if (DATA && !selectedId) {
    document.getElementById('content').innerHTML = renderCrossAgentView();
  }
}

// ── Actions Taken Feed ────────────────────────────────────────────────────────
function collectActions(agents) {
  const actions = [];
  for (const a of agents) {
    for (const hb of (a.heartbeats || [])) {
      for (const s of (hb.steps || [])) {
        for (const tc of (s.toolCalls || [])) {
          const time = s.startTime || hb.startTime;
          let type = 'other';
          let desc = '';
          const name = tc.name || '';
          const args = tc.args || {};

          if (name === 'browser') {
            type = 'browser';
            const act = args.action || '';
            const req = args.request || {};
            if (act === 'act') {
              const k = req.kind || '';
              if (k === 'click') desc = 'Click ' + (req.ref || '');
              else if (k === 'type') desc = 'Type "' + (req.text || '').slice(0, 40) + '"';
              else if (k === 'evaluate') desc = 'Evaluate (fn ' + ((req.fn || '').length) + 'c)';
              else if (k === 'snapshot') desc = 'Snapshot' + (req.selector ? ' [' + req.selector.slice(0,20) + ']' : '');
              else if (k === 'wait') desc = 'Wait ' + req.timeMs + 'ms';
              else desc = k;
            } else if (act === 'open') desc = 'Open browser';
            else if (act === 'close') desc = 'Close browser';
            else if (act === 'navigate') desc = 'Navigate ' + (args.url || '').slice(0, 50);
            else desc = act;
          } else if (name === 'read' || name === 'write' || name === 'edit') {
            type = 'file';
            const p = (args.file_path || args.path || '').replace(/.*workspace-promo-assistant-[^/]+\\//, '').replace(/.*\\.openclaw\\//, '~/');
            desc = name + ' ' + p.slice(0, 45);
          } else if (name === 'bash') {
            type = 'shell';
            desc = (args.command || '').replace(/\\s+/g, ' ').slice(0, 60);
          } else if (name === 'glob' || name === 'grep') {
            type = 'file';
            desc = name + ' ' + (args.pattern || '').slice(0, 40);
          } else {
            desc = name;
          }

          if (tc.isError) type = 'error';
          actions.push({ time, agentId: a.id, emoji: a.emoji, type, desc });
        }
      }
    }
  }
  actions.sort((a,b) => (b.time||0) - (a.time||0));
  return actions;
}

let actionFilter = 'all';

function renderActionsFeed(agents) {
  const allActions = collectActions(agents);
  const filtered = actionFilter === 'all' ? allActions : allActions.filter(a => a.type === actionFilter);
  const shown = filtered.slice(0, 80);

  const counts = {};
  for (const a of allActions) counts[a.type] = (counts[a.type] || 0) + 1;

  const types = ['all', 'browser', 'file', 'shell', 'error', 'other'];
  const labels = { all: t('all'), browser: t('browser'), file: t('files'), shell: t('shell'), error: t('errors'), other: t('other') };
  const filterBtns = types.filter(t => t === 'all' || counts[t]).map(t => {
    const cnt = t === 'all' ? allActions.length : (counts[t] || 0);
    return \`<span class="af-filter-btn \${actionFilter===t?'active':''}" onclick="filterActions('\${t}')">\${labels[t]} (\${cnt})</span>\`;
  }).join('');

  const items = shown.map(a => {
    const t = a.time ? new Date(a.time).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) : '??';
    return \`<div class="af-item">
      <span class="af-time">\${t}</span>
      <span class="af-agent">\${a.emoji}</span>
      <span class="af-type \${a.type}">\${a.type}</span>
      <span class="af-desc" title="\${esc(a.desc)}">\${esc(a.desc)}</span>
    </div>\`;
  }).join('');

  return \`<div class="actions-feed">
    <div class="section-title">\${t('actionsFeed')}</div>
    <div class="af-controls">\${filterBtns}</div>
    <div class="af-list">\${items || '<div style="padding:10px;color:var(--muted);font-size:10px">'+t('noActionsRecorded')+'</div>'}</div>
  </div>\`;
}

function filterActions(type) {
  actionFilter = type;
  if (DATA && !selectedId) {
    document.getElementById('content').innerHTML = renderCrossAgentView();
  }
}

// ── Agent view ────────────────────────────────────────────────────────────────
function renderAgent(a) {
  document.getElementById('agent-title').textContent = a.emoji+' '+a.name;

  const mEl = document.getElementById('pill-model');
  mEl.textContent = fModel(a.model);
  mEl.style.display = a.model ? '' : 'none';

  // Hide context pill
  document.getElementById('pill-ctx').style.display = 'none';

  const pct = a.contextTokens ? Math.round(a.totalTokens/a.contextTokens*100) : 0;

  // Show compare mode button
  const compareBtnEl = document.getElementById('compare-mode-btn');
  compareBtnEl.style.display = '';
  compareBtnEl.textContent = compareMode ? t('exitCompare') : t('compare');

  const el = document.getElementById('content');
  if (!a.heartbeats?.length) {
    el.innerHTML = '<div class="empty">'+t('noHeartbeats')+'</div>';
    return;
  }

  const hbs   = a.heartbeats;
  const costs = hbs.slice().reverse().map(h => dVal(h.totalCost, h.totalTokensSum || 0));
  const ctxs  = hbs.slice().reverse().map(h=>h.finalContext);

  const cachePct = Math.round((a.avgCacheHit || 0) * 100);

  const overviewOpen = typeof agentOverviewOpen === 'undefined' || agentOverviewOpen;
  const ovState = overviewOpen ? 'expanded' : 'collapsed';
  const ovArrow = overviewOpen ? '▼' : '▶';

  el.innerHTML = \`
    <div class="agent-overview">
      <div class="agent-overview-toggle" onclick="toggleAgentOverview()">
        <span class="toggle-arrow">\${ovArrow}</span>
        <span class="section-title">\${t('sessionOverview')}</span>
        <span style="color:var(--muted);font-size:11px;margin-left:auto">\${dFmt(a.totalCost, a.totalTokensSum)} · \${hbs.length} \${t('hb')} · \${cachePct}% \${t('cache')}\${displayMode==='cost'?'':\` (\${fTk(a.totalCacheReadTk||0)}/\${fTk((a.totalCacheReadTk||0)+(a.totalInputTk||0))})\`}</span>
      </div>
      <div class="agent-overview-body \${ovState}" style="max-height:\${overviewOpen?'600px':'0'}">
        <div id="overview">
          <div class="stat-box"><div class="stat-label">\${dVal(t('sessionCost'),t('sessionTokens'))}</div><div class="stat-val green">\${dFmt(a.totalCost, a.totalTokensSum)}</div></div>
          <div class="stat-box"><div class="stat-label">\${t('heartbeats')}</div><div class="stat-val blue">\${hbs.length}</div></div>
          <div class="stat-box"><div class="stat-label">\${dVal(t('avgCostHb'),t('avgTokHb'))}</div><div class="stat-val orange">\${dFmt(a.totalCost/hbs.length, (a.totalTokensSum||0)/hbs.length)}</div></div>
          <div class="stat-box"><div class="stat-label">\${t('cacheHitRate')}</div><div class="stat-val \${cachePct>70?'green':cachePct>50?'blue':'orange'}">\${cachePct}%</div></div>
          <div class="stat-box" style="display:flex;align-items:center;justify-content:center"><button class="cleanup-btn" onclick="cleanupAgent('\${a.id}')" style="font-size:10px;padding:6px 12px">\${t('cleanupHeartbeats')}</button></div>
        </div>
        \${compareMode?\`
          <div class="compare-bar">
            <span class="compare-label">\${t('compareMode')}</span>
            <span class="compare-chip \${compareHbs.length>=1?'selected':''}">\${compareHbs[0]!==undefined?'#'+(hbs.length-compareHbs[0]):t('select1st')}</span>
            <span class="m">vs</span>
            <span class="compare-chip \${compareHbs.length>=2?'selected':''}">\${compareHbs[1]!==undefined?'#'+(hbs.length-compareHbs[1]):t('select2nd')}</span>
            \${compareHbs.length===2?\`<button class="compare-btn" onclick="clearCompare()">\${t('clear')}</button>\`:''}
          </div>
        \`:''}
        \${compareHbs.length===2?renderComparison(hbs[compareHbs[0]],hbs[compareHbs[1]]):''}
        <div class="chart-row">
          <div class="chart-box">
            <div class="section-title">\${dVal(t('costPerHb'),t('tokensPerHb'))}</div>
            <div class="spark-wrap">\${svgBars(costs,130,'var(--green)',(v,i)=>'#'+(i+1)+' '+(displayMode==='cost'?f$(v):fTk(v)))}</div>
          </div>
          <div class="chart-box">
            <div class="section-title">\${t('contextGrowth')}</div>
            <div class="spark-wrap">\${svgLine(ctxs,130,'var(--purple)')}</div>
          </div>
        </div>
      </div>
    </div>
    \${renderPager(hbs.length)}
    \${hbs.slice(hbPage*HB_PAGE_SIZE, (hbPage+1)*HB_PAGE_SIZE).map((hb,si)=>{
      const i = hbPage*HB_PAGE_SIZE + si;
      return heartbeatRow(hb,i,hbs.length);
    }).join('')}
    \${hbs.length > HB_PAGE_SIZE ? renderPager(hbs.length) : ''}
  \`;
  // Restore raw message panels that were open before re-render
  setTimeout(() => {
    for (const idx of Object.keys(rawPanelOpen)) {
      const cacheKey = selectedId + ':' + idx;
      const panel = document.getElementById('raw-panel-' + idx);
      if (panel && rawMessageCache[cacheKey]) {
        renderRawMessages(panel, rawMessageCache[cacheKey], parseInt(idx));
      }
    }
  }, 0);
}

function renderPager(total) {
  const pages = Math.ceil(total / HB_PAGE_SIZE);
  if (pages <= 1) return '';
  const cur = hbPage;
  let nums = '';
  for (let p = 0; p < pages; p++) {
    // Show first, last, and pages near current
    if (p === 0 || p === pages-1 || Math.abs(p - cur) <= 2) {
      nums += \`<span class="pager-num \${p===cur?'active':''}" onclick="goPage(\${p})">\${p+1}</span>\`;
    } else if (p === 1 || p === pages-2) {
      nums += '<span style="color:var(--muted)">…</span>';
    }
  }
  return \`<div class="pager">
    <button class="pager-btn" onclick="goPage(\${cur-1})" \${cur<=0?'disabled':''}>\${t('prevPage')}</button>
    \${nums}
    <button class="pager-btn" onclick="goPage(\${cur+1})" \${cur>=pages-1?'disabled':''}>\${t('nextPage')}</button>
    <span style="margin-left:6px">\${total} \${t('hb')}</span>
  </div>\`;
}

function goPage(p) {
  const a = DATA?.agents?.find(a=>a.id===selectedId);
  if (!a) return;
  const pages = Math.ceil(a.heartbeats.length / HB_PAGE_SIZE);
  hbPage = Math.max(0, Math.min(p, pages-1));
  renderAgent(a);
  document.getElementById('content')?.scrollTo({top:0,behavior:'smooth'});
}

// ── Heartbeat row ──────────────────────────────────────────────────────────────
function heartbeatRow(hb, i, total) {
  const isOpen = openHbIdx===i;
  const errBadge = hb.errorCount ? \`<span class="err-count">⚠\${hb.errorCount}</span>\` : '';
  const markAllBtn = hb.errorCount ? \`<button class="mark-all-solved-btn" onclick="event.stopPropagation(); markAllErrorsSolved(\${i})" title="\${t('markAllTitle')}">\${t('markAllSolved')}</button>\` : '';
  const hbId = hb.startTime || i;
  const browserBadge = Object.keys(hb.browserBreakdown||{}).length
    ? \`<span class="hb-browser">\${Object.entries(hb.browserBreakdown).map(([k,v])=>k+'×'+v).join(' ')}</span>\`
    : '';

  const compareSelected = compareHbs.includes(i);
  const hbCls = compareSelected ? 'style="background:var(--blue)11"' : '';

  // API URLs
  const resetParam = includeReset ? '&include_reset=1' : '';
  const apiUrl = \`http://127.0.0.1:3141/api/heartbeat?agent=\${selectedId}&hb=\${i}\${resetParam}\`;
  const apiUrlErrors = \`http://127.0.0.1:3141/api/heartbeat?agent=\${selectedId}&hb=\${i}&errors_only=true\${resetParam}\`;

  return \`<div class="hb" id="hb\${i}" \${hbCls}>
    <div class="hb-head \${isOpen?'open':''}" onclick="toggleHb(\${i})" \${hbCls}>
      <span class="hb-num">#\${total-i}</span>
      <span class="hb-time">\${fT(hb.startTime)}</span>
      <span class="hb-cost">\${dFmt(hb.totalCost, hb.totalTokensSum)}</span>
      <span class="hb-ctx">ctx \${fTk(hb.finalContext)}</span>
      <span class="hb-dur">\${fD(hb.durationMs)}</span>
      <span class="hb-steps">\${hb.steps?.length||0} \${t('steps')}</span>
      \${errBadge}
      \${markAllBtn}
      \${browserBadge}
      <span class="hb-sum">\${esc(hb.summary||hb.trigger||'')}</span>
      <div class="hb-api-btns" onclick="event.stopPropagation()">
        <button class="api-btn" onclick="copyApiUrl('\${apiUrl}', this)" title="\${t('copyApiAll')}">📋 API</button>
        <button class="api-btn" onclick="copyApiUrl('\${apiUrlErrors}', this)" title="\${t('copyApiErrors')}">⚠ API</button>
      </div>
      <span class="hb-arrow">\${isOpen?'▲':'▼'}</span>
    </div>
    <div class="hb-body \${isOpen?'open':''}">\${isOpen?heartbeatBody(hb,i):''}</div>
  </div>\`;
}

// ── Heartbeat body ──────────────────────────────────────────────────────────────
function heartbeatBody(hb, hbIdx) {
  const hbId = hb.startTime || hbIdx;
  const steps = hb.steps||[];
  if (!steps.length) return '<div class="empty">'+t('noSteps')+'</div>';

  const costs   = steps.map(s => dVal(s.cost||0, s.totalTokens||0));
  const ctxs    = steps.map(s=>s.totalTokens||0);
  const avgCost = costs.reduce((a,b)=>a+b,0)/costs.length;

  const totIn  = steps.reduce((s,x)=>s+(x.costInput||0),0);
  const totOut = steps.reduce((s,x)=>s+(x.costOutput||0),0);
  const totCR  = steps.reduce((s,x)=>s+(x.costCacheRead||0),0);
  const totCW  = steps.reduce((s,x)=>s+(x.costCacheWrite||0),0);
  const totRes = steps.reduce((s,x)=>s+(x.resultTotalSize||0),0);

  // Token-level totals (reuse heartbeat-level sums from finalizeRun)
  const tkIn  = hb.totalInput || 0;
  const tkOut = hb.totalOutput || 0;
  const tkCR  = hb.totalCacheRead || 0;
  const tkCW  = hb.totalCacheWrite || 0;
  const tkTotal = tkIn + tkOut + tkCR + tkCW;
  const tkPct = v => displayMode==='cost'?'':\` <span class="m">(\${tkTotal>0?Math.round(v/tkTotal*100):0}%)</span>\`;
  const cachePctTotal = (tkCR+tkIn)>0 ? Math.round(tkCR/(tkCR+tkIn)*100) : 0;
  const cachedNote = displayMode==='cost'?'':\` <span class="m" style="margin-left:6px">\${cachePctTotal}% \${t('cached')}</span>\`;
  const maxStep = Math.max(...costs, 1e-9);

  const open = expandedSteps[hbIdx] || new Set();

  // Waste hints
  const wasteHtml = (hb.wasteFlags && hb.wasteFlags.length) ? \`
    <div class="waste-hints">
      <div class="waste-title"><span class="waste-icon">⚠</span> \${t('optimizationHints').replace('⚠ ','')}</div>
      <div class="waste-list">
        \${hb.wasteFlags.map(w => \`<div class="waste-item"><span class="waste-icon">•</span><span>\${esc(w.msg)}</span></div>\`).join('')}
      </div>
    </div>
  \` : '';

  return \`
    <button class="raw-messages-btn" onclick="toggleRawMessages(\${hbIdx})">\${rawPanelOpen[hbIdx] ? t('rawMessagesHide') : t('rawMessages')}</button>
    <div id="raw-panel-\${hbIdx}" class="raw-messages-panel" style="display:\${rawPanelOpen[hbIdx] ? 'block' : 'none'}"></div>
    \${wasteHtml}
    <div class="hb-stats-grid">
      <div class="stat-chart-card">
        <div class="stat-chart-title">\${dVal(t('costPerStep'),t('tokensPerStep'))}</div>
        <div class="stat-chart-content">
          \${svgBars(costs,130,'var(--green)',(v,i)=>'step '+(i+1)+' '+(displayMode==='cost'?f$(v):fTk(v)))}
        </div>
      </div>
      <div class="stat-chart-card">
        <div class="stat-chart-title">\${t('toolUsage')}</div>
        <div class="stat-chart-content" style="display:block;overflow-y:auto;max-height:140px">
          \${svgToolBreakdown(steps)}
        </div>
      </div>
      <div class="stat-breakdown-card">
        <div class="stat-chart-title">\${dVal(t('costBreakdown'),t('tokenBreakdown'))}</div>
        <div class="breakdown-table">
          <div class="breakdown-row"><span class="breakdown-label">\${t('input')}</span><span class="breakdown-value g">\${displayMode==='cost'?f$(totIn):fTk(tkIn)}\${tkPct(tkIn)}</span></div>
          <div class="breakdown-row"><span class="breakdown-label">\${t('output')}</span><span class="breakdown-value g">\${displayMode==='cost'?f$(totOut):fTk(tkOut)}\${tkPct(tkOut)}</span></div>
          <div class="breakdown-row"><span class="breakdown-label">\${t('cacheRead')}</span><span class="breakdown-value g">\${displayMode==='cost'?f$(totCR):fTk(tkCR)}\${tkPct(tkCR)}</span></div>
          <div class="breakdown-row"><span class="breakdown-label">\${t('cacheWrite')}</span><span class="breakdown-value g">\${displayMode==='cost'?f$(totCW):fTk(tkCW)}\${tkPct(tkCW)}</span></div>
          <div class="breakdown-row"><span class="breakdown-label">\${t('toolResults')}</span><span class="breakdown-value b">\${fSz(totRes)}</span></div>
          <div class="breakdown-row breakdown-total">
            <span class="breakdown-label"><b>\${t('total')}</b></span>
            <span class="breakdown-value g"><b>\${dFmt(hb.totalCost, hb.totalTokensSum)}</b>\${cachedNote}</span>
          </div>
        </div>
      </div>
    </div>
    <table class="tbl">
      <thead>
        <tr>
          <th>#</th>
          <th>\${t('model')}</th>
          <th>\${t('time')}</th>
          <th class="sortable" onclick="sortSteps(\${hbIdx},'dur')">\${t('dur')} <span class="sort-arrow" id="sort-dur-\${hbIdx}"></span></th>
          <th class="sortable" onclick="sortSteps(\${hbIdx},'action')">\${t('action')} <span class="sort-arrow" id="sort-action-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'result')">\${t('result')} <span class="sort-arrow" id="sort-result-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'output')">\${t('outTok')} <span class="sort-arrow" id="sort-output-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'cacheRead')">\${t('cacheR')} <span class="sort-arrow" id="sort-cacheRead-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'ctx')">\${t('ctx')} <span class="sort-arrow" id="sort-ctx-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'cost')">\${dVal(t('cost'),t('tokens'))} <span class="sort-arrow" id="sort-cost-\${hbIdx}"></span></th>
          <th>\${t('thinking')}</th>
        </tr>
      </thead>
      <tbody id="steps-\${hbIdx}">
        \${steps.map((s,si) => stepRows(s, si, hbIdx, hbId, maxStep, avgCost, open)).join('')}
      </tbody>
    </table>
  \`;
}

// ── Step rows (main row + optional detail row) ────────────────────────────────
function stepRows(s, si, hbIdx, hbId, maxStep, avgCost, open) {
  const isOpen = open.has(si);
  const stepVal = dVal(s.cost||0, s.totalTokens||0);
  const heat   = stepVal > avgCost*3 ? 'step-hot' : stepVal > avgCost*1.5 ? 'step-warm' : '';
  const expanded = isOpen ? 'expanded' : '';

  // Check if this step has unsolved errors
  const hasStepError = (toolResults, hbId, stepIdx) => {
    if (!toolResults) return false;
    return toolResults.some((tr, resultIdx) => {
      if (!hasErrorInResult(tr)) return false;
      // Check if this specific error is marked as solved
      return !isErrorSolved(selectedId, hbId, stepIdx, resultIdx);
    });
  };
  const hasError = hasStepError(s.toolResults, hbId, si);
  const errorBadge = hasError ? '<span class="err-badge" style="margin-left:4px">'+t('error')+'</span>' : '';

  let actionCell = '—';
  if (s.toolCalls?.length) {
    const descs = s.toolCalls.map(tc => {
      const d = esc(describeCall(tc.name, tc.args));
      const cls = toolChipClass(tc.name);
      return \`<span class="tf-chip \${cls}">\${d}</span>\`;
    });
    actionCell = descs.slice(0,3).join(' ') + (descs.length>3 ? \` <span class="m">+\${descs.length-3}</span>\` : '') + errorBadge;
  }

  const thinkingText = esc(s.text || '');
  const thinkingPreview = thinkingText.slice(0, 120);
  const isTruncated = thinkingText.length > 120;

  const sIn = Math.max(0, (s.totalTokens||0) - (s.output||0) - (s.cacheRead||0) - (s.cacheWrite||0));
  const sCR = s.cacheRead || 0;
  const sCachePct = (sCR + sIn) > 0 ? Math.round(sCR / (sCR + sIn) * 100) : 0;
  const ctxTip = \`Input: \${fTk(sIn)} | Cache: \${fTk(sCR)} (\${sCachePct}%) | Out: \${fTk(s.output)}\`;

  const mainRow = \`<tr class="step-row \${heat} \${expanded}" onclick="toggleStep(\${hbIdx},\${si})">
    <td class="m">\${si+1}</td>
    <td class="m" style="font-size:10px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${esc(s.model||'')}">\${fModel(s.model)}</td>
    <td class="m">\${fT(s.time)}</td>
    <td class="m">\${fD(s.durationMs)}</td>
    <td style="max-width:280px">\${actionCell}</td>
    <td class="r b">\${fSz(s.resultTotalSize)}</td>
    <td class="r o">\${fTk(s.output)}</td>
    <td class="r p">\${fTk(s.cacheRead)}</td>
    <td class="r p" title="\${ctxTip}">\${fTk(s.totalTokens)}</td>
    <td class="r g">
      <span class="cost-bar" style="width:\${Math.round(stepVal/maxStep*36)}px"></span>\${displayMode==='cost'?f$(s.cost):fTk(s.totalTokens)}
    </td>
    <td class="m thinking-cell" style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px\${isTruncated?';cursor:pointer;text-decoration:underline dotted':''}"
        title="\${isTruncated?t('clickRowFull'):''}">
      \${thinkingPreview}\${isTruncated?' <span style="color:var(--blue);font-weight:600">↓</span>':''}
    </td>
  </tr>\`;

  if (!isOpen) return mainRow;

  return mainRow + \`<tr class="step-detail"><td colspan="11">\${stepDetail(s, hbIdx, hbId, si)}</td></tr>\`;
}

// ── Step detail panel ─────────────────────────────────────────────────────────
function stepDetail(s, hbIdx, hbId, stepIdx) {
  const calls = s.toolCalls || [];
  const results = s.toolResults || [];
  const thinkingText = s.text || '';

  // Thinking text section (if present)
  const thinkingId = 'think-'+hbId+'-'+stepIdx;
  const thinkExpanded = expandedFullIds.has(thinkingId);
  const thinkingHtml = thinkingText ? \`
    <div class="thinking-section">
      <div class="thinking-label">\${t('thinkingLabel')}</div>
      <div class="thinking-text\${thinkExpanded?' expanded':''}" id="\${thinkingId}">\${esc(thinkingText)}</div>
      \${thinkingText.length > 300 ? \`<button class="expand-btn" onclick="toggleExpand('\${thinkingId}',this)">\${thinkExpanded?t('collapse'):t('showFull')}</button>\` : ''}
    </div>
  \` : '';

  if (!calls.length && !results.length) {
    return \`<div class="step-detail-inner">
      \${thinkingHtml}
      \${!thinkingText ? '<div class="m" style="font-size:10px;padding:4px">'+t('noToolCalls')+'</div>' : ''}
    </div>\`;
  }

  const resultByCallId = {};
  const unmatchedResults = [];
  let resultIndexMap = new Map(); // Map result objects to their original indices

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    resultIndexMap.set(r, i);
    if (r.callId && calls.find(c => c.id === r.callId)) {
      resultByCallId[r.callId] = r;
    } else {
      unmatchedResults.push(r);
    }
  }

  const cards = calls.map((tc, i) => {
    const result = resultByCallId[tc.id] || unmatchedResults.shift();
    const resultIdx = result ? resultIndexMap.get(result) : -1;
    return detailCard(tc, result, hbId, stepIdx, resultIdx);
  });

  for (const r of unmatchedResults) {
    const resultIdx = resultIndexMap.get(r);
    cards.push(detailCard(null, r, hbId, stepIdx, resultIdx));
  }

  return \`<div class="step-detail-inner">\${thinkingHtml}\${cards.join('')}</div>\`;
}

function detailCard(tc, result, hbId, stepIdx, resultIdx) {
  let header = '';
  let argsHtml = '';

  if (tc) {
    const desc = esc(describeCall(tc.name, tc.args));
    header = \`<div class="detail-call-head"><span class="b">\${esc(tc.name)}</span><span class="m">\${desc}</span></div>\`;

    const args = tc.args || {};
    const lines = [];
    if (tc.name === 'browser') {
      if (args.action) lines.push('action: '+args.action);
      if (args.targetUrl) lines.push('url: '+args.targetUrl);
      if (args.profile) lines.push('profile: '+args.profile);
      if (args.request?.kind) lines.push('kind: '+args.request.kind);
      if (args.request?.fn) lines.push('fn: '+args.request.fn.slice(0,200)+(args.request.fn.length>200?'…':''));
      if (args.request?.selector) lines.push('selector: '+args.request.selector);
      if (args.request?.ref) lines.push('ref: '+args.request.ref);
      if (args.request?.text) lines.push('text: '+JSON.stringify(args.request.text).slice(0,80));
      if (args.request?.timeMs) lines.push('wait: '+args.request.timeMs+'ms');
    } else {
      const skip = new Set(['file_path','path']);
      for (const [k,v] of Object.entries(args)) {
        if (skip.has(k)) continue;
        const vs = typeof v === 'string' ? v : JSON.stringify(v);
        lines.push(k+': '+vs.slice(0,80));
      }
      if (args.file_path || args.path) lines.unshift('path: '+(args.file_path||args.path||''));
    }
    argsHtml = \`<div class="detail-call-args">\${esc(lines.join('\\n'))}</div>\`;
  }

  let resultHtml = '';
  if (result) {
    const hasError = hasErrorInResult(result);
    const isSolved = hasError && resultIdx >= 0 && isErrorSolved(selectedId, hbId, stepIdx, resultIdx);

    let errBadge = '';
    if (hasError) {
      if (isSolved) {
        errBadge = \`<span class="err-badge-solved">\${t('solved')}</span>\`;
      } else {
        errBadge = \`<span class="err-badge">\${t('error')}</span> <button class="mark-solved-btn" onclick="markErrorSolved('\${selectedId}','\${hbId}',\${stepIdx},\${resultIdx})">\${t('markSolved')}</button>\`;
      }
    }

    resultHtml = \`<div class="detail-result">
      <div class="detail-result-head">
        <span class="m">\${t('result')}</span>
        <span class="b">\${fSz(result.size)}</span>
        \${errBadge}
      </div>
      <div class="detail-result-body \${hasError && !isSolved?'r2':''}\${expandedFullIds.has('res-'+hbId+'-'+stepIdx+'-'+resultIdx)?' expanded':''}" id="res-\${hbId}-\${stepIdx}-\${resultIdx}">\${expandedFullIds.has('res-'+hbId+'-'+stepIdx+'-'+resultIdx) && result.full ? esc(result.full) : esc(result.preview)+(result.full?'<span class="m"> …('+fSz(result.size)+' total)</span>':'')}</div>
      \${result.full?\`<button class="expand-btn" onclick="toggleFullResult('\${hbId}',\${stepIdx},\${resultIdx})">\${expandedFullIds.has('res-'+hbId+'-'+stepIdx+'-'+resultIdx)?t('collapse'):t('showFull')}</button>\`:''}
    </div>\`;
  }

  return \`<div class="detail-call">\${header}\${argsHtml}\${resultHtml}</div>\`;
}

// ── Comparison ────────────────────────────────────────────────────────────────
function renderComparison(hb1, hb2) {
  const delta = (v1, v2, fmt = v => v) => {
    const d = v2 - v1;
    const sign = d > 0 ? '+' : d < 0 ? '' : '±';
    const cls = d > 0 ? 'delta-neg' : d < 0 ? 'delta-pos' : 'delta-zero';
    return \`<span class="compare-delta \${cls}">\${sign}\${fmt(Math.abs(d))}</span>\`;
  };

  return \`<div class="compare-view">
    <div class="compare-col">
      <div class="compare-col-title">\${t('session1')}</div>
      <div class="compare-stat"><span class="lbl">\${dVal(t('cost'),t('tokens'))}</span><span class="val">\${dFmt(hb1.totalCost, hb1.totalTokensSum)}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('steps')}</span><span class="val">\${hb1.steps?.length||0}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('context')}</span><span class="val">\${fN(hb1.finalContext)}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('cacheHit')}</span><span class="val">\${Math.round((hb1.cacheHitRate||0)*100)}%</span></div>
      <div class="compare-stat"><span class="lbl">\${t('duration')}</span><span class="val">\${fD(hb1.durationMs)}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('errors')}</span><span class="val">\${hb1.errorCount||0}</span></div>
    </div>
    <div class="compare-col">
      <div class="compare-col-title">\${t('session2Delta')}</div>
      <div class="compare-stat"><span class="lbl">\${dVal(t('cost'),t('tokens'))}</span><span class="val">\${dFmt(hb2.totalCost, hb2.totalTokensSum)}\${delta(dVal(hb1.totalCost,hb1.totalTokensSum),dVal(hb2.totalCost,hb2.totalTokensSum),displayMode==='cost'?f$:fTk)}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('steps')}</span><span class="val">\${hb2.steps?.length||0}\${delta(hb1.steps?.length||0,hb2.steps?.length||0,v=>v)}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('context')}</span><span class="val">\${fN(hb2.finalContext)}\${delta(hb1.finalContext,hb2.finalContext,fN)}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('cacheHit')}</span><span class="val">\${Math.round((hb2.cacheHitRate||0)*100)}%\${delta(Math.round((hb1.cacheHitRate||0)*100),Math.round((hb2.cacheHitRate||0)*100),v=>v+'%')}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('duration')}</span><span class="val">\${fD(hb2.durationMs)}</span></div>
      <div class="compare-stat"><span class="lbl">\${t('errors')}</span><span class="val">\${hb2.errorCount||0}\${delta(hb1.errorCount||0,hb2.errorCount||0,v=>v)}</span></div>
    </div>
  </div>\`;
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed');
}

function toggleCompareMode() {
  compareMode = !compareMode;
  if (!compareMode) compareHbs = [];
  if (!DATA) return;
  const a = DATA.agents.find(a=>a.id===selectedId);
  if (a) renderAgent(a);
}

function clearCompare() {
  compareHbs = [];
  if (!DATA) return;
  const a = DATA.agents.find(a=>a.id===selectedId);
  if (a) renderAgent(a);
}

function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', theme);
  document.documentElement.classList.toggle('light', theme === 'light');
  document.getElementById('theme-btn').textContent = theme === 'dark' ? '☀' : '☾';
}

function toggleLang() {
  lang = lang === 'en' ? 'zh' : 'en';
  localStorage.setItem('lang', lang);
  document.getElementById('lang-btn').textContent = lang === 'en' ? '中' : 'EN';
  if (selectedId) {
    const a = DATA?.agents?.find(x => x.id === selectedId);
    if (a) renderAgent(a);
  } else {
    document.getElementById('content').innerHTML = renderCrossAgentView();
  }
  renderSidebar();
  updateDailyPill();
  updateBudget();
  document.getElementById('sidebar-head').textContent = '🦞 ' + t('agents');
  document.getElementById('refresh-text').textContent = t('autoRefresh');
  document.getElementById('reset-toggle-btn').textContent = t('resetFiles');
  document.getElementById('sidebar-toggle').title = t('toggleSidebar');
  document.getElementById('back-btn').title = t('backToOverview');
}

function toggleDisplayMode() {
  displayMode = displayMode === 'cost' ? 'token' : 'cost';
  localStorage.setItem('displayMode', displayMode);
  document.getElementById('display-mode-btn').textContent = displayMode === 'cost' ? 'Token' : 'Cost';
  if (selectedId) {
    const a = DATA?.agents?.find(x => x.id === selectedId);
    if (a) renderAgent(a);
  } else {
    document.getElementById('content').innerHTML = renderCrossAgentView();
  }
  renderSidebar();
  updateDailyPill();
  updateBudget();
}


function changeRefreshInterval(val) {
  refreshMs = parseInt(val) || 5000;
  localStorage.setItem('refreshMs', refreshMs);
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchData, refreshMs);
}

function toggleResetFiles() {
  includeReset = !includeReset;
  localStorage.setItem('includeReset', includeReset ? '1' : '0');
  const btn = document.getElementById('reset-toggle-btn');
  if (btn) btn.style.opacity = includeReset ? 1 : 0.5;
  fetchData();
}

// ── URL hash navigation ───────────────────────────────────────────────────────
function updateHash() {
  if (!selectedId) {
    history.pushState(null, '', window.location.pathname);
    return;
  }
  let hash = \`#agent=\${selectedId}\`;
  if (openHbIdx !== null) hash += \`&hb=\${openHbIdx}\`;
  history.pushState(null, '', hash);
}

function goHome(skipPush) {
  selectedId = null;
  openHbIdx = null;
  openHbKey = null;
  hbPage = 0;
  compareMode = false;
  compareHbs = [];
  compareHbKeys = [];
  if (!skipPush) history.pushState(null, '', window.location.pathname);
  renderSidebar();
  document.getElementById('back-btn').style.display = 'none';
  document.getElementById('agent-title').textContent = t('openclawTrace');
  document.getElementById('pill-model').style.display = 'none';
  document.getElementById('pill-ctx').style.display = 'none';
  document.getElementById('compare-mode-btn').style.display = 'none';
  document.getElementById('content').innerHTML = renderCrossAgentView();
}

function parseHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return { agent: null, hb: null };
  const params = {};
  for (const pair of hash.split('&')) {
    const [k, v] = pair.split('=');
    params[k] = v;
  }
  return { agent: params.agent || null, hb: params.hb !== undefined ? parseInt(params.hb, 10) : null };
}

function restoreFromHash() {
  const { agent, hb } = parseHash();
  if (agent && DATA) {
    const a = DATA.agents.find(x => x.id === agent);
    if (a) {
      selectedId = agent;
      openHbIdx = hb;
      openHbKey = (hb !== null && a.heartbeats?.[hb]) ? hbKey(a.heartbeats[hb]) : null;
      if (hb !== null) hbPage = Math.floor(hb / HB_PAGE_SIZE);
      document.getElementById('back-btn').style.display = '';
      renderSidebar();
      renderAgent(a);
      if (hb !== null) {
        setTimeout(() => document.getElementById(\`hb\${hb}\`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
      }
    }
  }
}

// ── Copy API URL ──────────────────────────────────────────────────────────────
function copyApiUrl(url, btn) {
  const orig = btn.textContent;
  navigator.clipboard.writeText(url).then(() => {
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 2000);
  }).catch(err => {
    console.error('Copy failed:', err);
    btn.textContent = '✗ Failed';
    setTimeout(() => {
      btn.textContent = orig;
    }, 2000);
  });
}

// ── Table Sorting ─────────────────────────────────────────────────────────────
const sortState = {}; // {hbIdx: {column, direction}}

function sortSteps(hbIdx, column) {
  if (!DATA) return;
  const agent = DATA.agents.find(a => a.id === selectedId);
  if (!agent) return;
  const hb = agent.heartbeats[hbIdx];
  if (!hb) return;
  const hbId = hb.startTime || hbIdx;

  const state = sortState[hbIdx] || {};
  let newDir = null;

  // 3-click cycle: asc -> desc -> clear
  if (state.column === column) {
    if (state.direction === 'asc') {
      newDir = 'desc';
    } else if (state.direction === 'desc') {
      newDir = null; // Clear sorting
    }
  } else {
    newDir = 'asc'; // First click on new column
  }

  // Clear all arrows
  document.querySelectorAll(\`#steps-\${hbIdx}\`).forEach(el => {
    el.parentElement.querySelectorAll('.sort-arrow').forEach(arr => arr.className = 'sort-arrow');
  });

  // If clearing, reset to original order
  if (newDir === null) {
    delete sortState[hbIdx];
    const steps = hb.steps || [];
    const costs = steps.map(s => s.cost || 0);
    const avgCost = costs.reduce((a,b) => a+b, 0) / costs.length;
    const maxStep = Math.max(...costs, 1e-9);
    const open = expandedSteps[hbIdx] || new Set();
    const tbody = document.getElementById(\`steps-\${hbIdx}\`);
    if (tbody) tbody.innerHTML = steps.map((s, si) => stepRows(s, si, hbIdx, hbId, maxStep, avgCost, open)).join('');
    return;
  }

  // Update sort state
  sortState[hbIdx] = { column, direction: newDir };

  // Set current arrow
  const arrow = document.getElementById(\`sort-\${column}-\${hbIdx}\`);
  if (arrow) arrow.className = \`sort-arrow \${newDir}\`;

  // Sort steps
  const steps = [...(hb.steps || [])];
  const costs = steps.map(s => s.cost || 0);
  const avgCost = costs.reduce((a,b) => a+b, 0) / costs.length;
  const maxStep = Math.max(...costs, 1e-9);
  const open = expandedSteps[hbIdx] || new Set();

  steps.sort((a, b) => {
    let valA, valB;
    switch(column) {
      case 'dur': valA = a.durationMs || 0; valB = b.durationMs || 0; break;
      case 'action': valA = (a.toolCalls?.[0]?.name || ''); valB = (b.toolCalls?.[0]?.name || ''); break;
      case 'result': valA = a.resultTotalSize || 0; valB = b.resultTotalSize || 0; break;
      case 'output': valA = a.output || 0; valB = b.output || 0; break;
      case 'cacheRead': valA = a.cacheRead || 0; valB = b.cacheRead || 0; break;
      case 'ctx': valA = a.totalTokens || 0; valB = b.totalTokens || 0; break;
      case 'cost': valA = dVal(a.cost||0, a.totalTokens||0); valB = dVal(b.cost||0, b.totalTokens||0); break;
      default: return 0;
    }
    if (typeof valA === 'string') return newDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    return newDir === 'asc' ? valA - valB : valB - valA;
  });

  // Re-render tbody
  const tbody = document.getElementById(\`steps-\${hbIdx}\`);
  if (tbody) tbody.innerHTML = steps.map((s, si) => stepRows(s, si, hbIdx, hbId, maxStep, avgCost, open)).join('');
}

// ── Interactions ──────────────────────────────────────────────────────────────
function select(id) {
  selectedId = id;
  openHbIdx  = null;
  openHbKey  = null;
  hbPage     = 0;
  compareMode = false;
  compareHbs = [];
  compareHbKeys = [];
  updateHash();
  renderSidebar();
  document.getElementById('back-btn').style.display = '';
  if (!DATA) return;
  const a = DATA.agents.find(a=>a.id===id);
  if (a) renderAgent(a);
}

function toggleAgentOverview() {
  agentOverviewOpen = !agentOverviewOpen;
  const body = document.querySelector('.agent-overview-body');
  const arrow = document.querySelector('.toggle-arrow');
  if (body) {
    body.classList.toggle('collapsed', !agentOverviewOpen);
    body.classList.toggle('expanded', agentOverviewOpen);
    body.style.maxHeight = agentOverviewOpen ? '600px' : '0';
  }
  if (arrow) arrow.textContent = agentOverviewOpen ? '▼' : '▶';
}

function toggleHb(i) {
  const a = DATA?.agents?.find(a=>a.id===selectedId);
  const hb = a?.heartbeats?.[i];

  if (compareMode) {
    // In compare mode: select heartbeats for comparison
    if (compareHbs.includes(i)) {
      compareHbs = compareHbs.filter(x => x !== i);
      if (hb) compareHbKeys = compareHbKeys.filter(k => k !== hbKey(hb));
    } else if (compareHbs.length < 2) {
      compareHbs.push(i);
      if (hb) compareHbKeys.push(hbKey(hb));
    }
    if (a) renderAgent(a);
    return;
  }

  // Normal mode: toggle open/close
  openHbIdx = openHbIdx===i ? null : i;
  openHbKey = openHbIdx !== null && hb ? hbKey(hb) : null;
  // Navigate to the page containing this heartbeat
  if (openHbIdx !== null) hbPage = Math.floor(openHbIdx / HB_PAGE_SIZE);
  updateHash();
  if (!expandedSteps[i]) expandedSteps[i] = new Set();
  if (hb && hbKey(hb) && !expandedStepsKeys[hbKey(hb)]) expandedStepsKeys[hbKey(hb)] = expandedSteps[i];
  if (!a) return;
  renderAgent(a);
  if (openHbIdx !== null)
    setTimeout(()=>document.getElementById('hb'+i)?.scrollIntoView({behavior:'smooth',block:'nearest'}),50);
}

function toggleStep(hbIdx, stepIdx) {
  if (!expandedSteps[hbIdx]) expandedSteps[hbIdx] = new Set();
  const set = expandedSteps[hbIdx];
  if (set.has(stepIdx)) set.delete(stepIdx); else set.add(stepIdx);

  // Sync to key-based store
  if (!DATA) return;
  const a    = DATA.agents.find(a=>a.id===selectedId);
  const hb   = a?.heartbeats?.[hbIdx];
  if (!hb) return;
  const k = hbKey(hb);
  if (k) expandedStepsKeys[k] = set;
  const hbId    = hb.startTime || hbIdx;
  const steps   = hb.steps||[];
  const costs   = steps.map(s=>s.cost||0);
  const avgCost = costs.reduce((a,b)=>a+b,0)/costs.length;
  const maxStep = Math.max(...costs,1e-9);
  const tbody = document.getElementById('steps-'+hbIdx);
  if (tbody) tbody.innerHTML = steps.map((s,si)=>stepRows(s,si,hbIdx,hbId,maxStep,avgCost,set)).join('');
}

function toggleExpand(elId, btn) {
  const el = document.getElementById(elId);
  if (!el) return;
  const expanded = el.classList.toggle('expanded');
  if (expanded) expandedFullIds.add(elId); else expandedFullIds.delete(elId);
  if (btn) btn.textContent = expanded ? t('collapse') : t('showFull');
}

function toggleFullResult(hbId, stepIdx, resultIdx) {
  const elId = 'res-'+hbId+'-'+stepIdx+'-'+resultIdx;
  const el = document.getElementById(elId);
  if (!el) return;
  const btn = el.parentElement.querySelector('.expand-btn');
  const isExpanded = el.classList.toggle('expanded');
  if (isExpanded) {
    expandedFullIds.add(elId);
    const a = DATA?.agents?.find(a=>a.id===selectedId);
    const hb = a?.heartbeats?.find(h => (h.startTime||'') === hbId);
    const result = hb?.steps?.[stepIdx]?.toolResults?.[resultIdx];
    if (result?.full) el.textContent = result.full;
    if (btn) btn.textContent = t('collapse');
  } else {
    expandedFullIds.delete(elId);
    const a = DATA?.agents?.find(a=>a.id===selectedId);
    const hb = a?.heartbeats?.find(h => (h.startTime||'') === hbId);
    const result = hb?.steps?.[stepIdx]?.toolResults?.[resultIdx];
    if (result) el.innerHTML = esc(result.preview) + '<span class="m"> …(' + fSz(result.size) + ' total)</span>';
    if (btn) btn.textContent = t('showFull');
  }
}

// ── Raw messages viewer ─────────────────────────────────────────────────────
const rawMessageCache = {};

async function toggleRawMessages(hbIdx) {
  const panel = document.getElementById('raw-panel-' + hbIdx);
  if (!panel) return;
  const agent = DATA?.agents?.find(a => a.id === selectedId);
  const hb = agent?.heartbeats?.[hbIdx];
  const k = hb ? hbKey(hb) : null;
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    delete rawPanelOpen[hbIdx];
    if (k) delete rawPanelOpenKeys[k];
    return;
  }
  panel.style.display = 'block';
  rawPanelOpen[hbIdx] = true;
  if (k) rawPanelOpenKeys[k] = true;
  const cacheKey = selectedId + ':' + hbIdx;
  if (rawMessageCache[cacheKey]) {
    renderRawMessages(panel, rawMessageCache[cacheKey], hbIdx);
    return;
  }
  panel.innerHTML = '<div class="m" style="padding:8px">Loading...</div>';
  try {
    const resp = await fetch('/api/raw-messages?agent=' + encodeURIComponent(selectedId) + '&hb=' + hbIdx);
    const data = await resp.json();
    if (data.error) { panel.innerHTML = '<div class="m" style="padding:8px;color:var(--red)">Error: ' + esc(data.error) + '</div>'; return; }
    rawMessageCache[cacheKey] = data;
    renderRawMessages(panel, data, hbIdx);
  } catch (e) {
    panel.innerHTML = '<div class="m" style="padding:8px;color:var(--red)">Failed to load: ' + esc(e.message) + '</div>';
  }
}

function renderRawMessages(panel, data, hbIdx) {
  const msgs = data.messages || [];
  let html = '<div class="raw-panel-actions">';
  html += '<button class="raw-messages-btn" onclick="copyAllRawMessages(' + hbIdx + ')">' + t('copyAllJson') + '</button>';
  html += '</div>';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const role = m.role || 'unknown';
    const roleCls = 'raw-role raw-role-' + (role === 'user' || role === 'assistant' || role === 'toolResult' ? role : 'unknown');
    const ts = m.timestamp ? fT(m.timestamp) : '';
    const preview = getRawPreview(m.raw);
    html += '<div class="raw-msg-card">';
    html += '<div class="raw-msg-head" onclick="toggleRawMsgBody(&quot;raw-body-' + hbIdx + '-' + i + '&quot;)">';
    html += '<span class="' + roleCls + '">' + esc(role) + '</span>';
    html += '<span class="m">' + esc(ts) + '</span>';
    html += '<span class="m" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(preview) + '</span>';
    html += '<div class="raw-msg-actions"><button onclick="event.stopPropagation();copyRawMessage(' + hbIdx + ',' + i + ')">' + t('copyJson') + '</button></div>';
    html += '</div>';
    html += '<div class="raw-msg-body" id="raw-body-' + hbIdx + '-' + i + '"><pre>' + esc(JSON.stringify(m.raw, null, 2)) + '</pre></div>';
    html += '</div>';
  }
  panel.innerHTML = html;
}

function getRawPreview(raw) {
  const msg = raw?.message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.slice(0, 120);
  if (Array.isArray(msg.content)) {
    const types = msg.content.map(c => c.type).filter(Boolean);
    const textParts = msg.content.filter(c => c.type === 'text').map(c => (c.text || '').slice(0, 80));
    if (textParts.length) return textParts[0];
    return types.join(', ');
  }
  return '';
}

function toggleRawMsgBody(elId) {
  const el = document.getElementById(elId);
  if (el) el.classList.toggle('open');
}

function copyRawMessage(hbIdx, msgIdx) {
  const cacheKey = selectedId + ':' + hbIdx;
  const data = rawMessageCache[cacheKey];
  if (!data?.messages?.[msgIdx]) return;
  navigator.clipboard.writeText(JSON.stringify(data.messages[msgIdx].raw, null, 2));
}

function copyAllRawMessages(hbIdx) {
  const cacheKey = selectedId + ':' + hbIdx;
  const data = rawMessageCache[cacheKey];
  if (!data?.messages) return;
  const all = data.messages.map(m => m.raw);
  navigator.clipboard.writeText(JSON.stringify(all, null, 2));
}

// ── Cleanup heartbeats ───────────────────────────────────────────────────────
async function cleanupAgent(agentId) {
  const agent = DATA?.agents?.find(a => a.id === agentId);
  const name = agent ? agent.name : agentId;
  const hbCount = agent?.heartbeats?.length || 0;
  if (!confirm(t('cleanupConfirm').replace('{count}',hbCount).replace('{name}',name))) return;
  try {
    const r = await fetch(\`/api/cleanup?agent=\${agentId}\`, { method: 'DELETE' });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    fetchData();
  } catch (e) {
    alert(t('cleanupFailed') + e.message);
  }
}

function updateDailyPill() {
  if (!DATA) return;
  const daily = DATA.dailySummary || [];
  const today = daily.find(d => d.dayOffset === 0);
  if (today && (today.cost > 0 || today.tokens > 0)) {
    const pill = document.getElementById('daily-pill');
    pill.querySelector('.amt').textContent = dFmt(today.cost, today.tokens);
    pill.querySelector('.m').textContent = t('todayLabel')+' ('+today.hbs+' '+t('hb')+')';
    pill.style.display = '';
  }
}

function updateBudget() {
  if (!DATA) return;
  const budget = DATA.budget || {};
  const bWrap = document.getElementById('budget-wrap');
  if (displayMode === 'token') {
    bWrap.style.display = 'none';
    return;
  }
  if (budget.daily && budget.todayCost !== undefined) {
    const pct = Math.min(100, (budget.todayCost / budget.daily) * 100);
    const cls = pct > 90 ? 'budget-over' : pct > 70 ? 'budget-warn' : 'budget-ok';
    bWrap.querySelector('.lbl').textContent = \`\${t('budget')}: \${f$(budget.todayCost)} / \${f$(budget.daily)}\`;
    bWrap.querySelector('.proj').textContent = \`~\${f$(budget.projectedMonthly)}/mo\`;
    const bFill = document.getElementById('budget-fill');
    bFill.style.width = pct + '%';
    bFill.className = cls;
    bWrap.style.display = '';
  }
}

// ── Data fetching ──────────────────────────────────────────────────────────────
async function fetchData() {
  const el = document.getElementById('refresh');
  const txt = document.getElementById('refresh-text');
  el.className = 'spin'; txt.textContent = t('loading');
  try {
    const r = await fetch('/api/data' + (includeReset ? '?include_reset=1' : ''));
    if (!r.ok) throw new Error('HTTP '+r.status);
    DATA = await r.json();

    // Recalculate error counts for all agents, excluding solved errors
    for (const agent of DATA.agents || []) {
      recalculateErrorCounts(agent);
    }

    // Remap index-based state to match potentially reordered heartbeats
    if (selectedId) {
      const cur = DATA.agents.find(a=>a.id===selectedId);
      if (cur) remapHbIndices(cur);
    }

    renderSidebar();
    updateDailyPill();
    updateBudget();

    // Restore from URL hash if present, otherwise use current state
    const { agent, hb } = parseHash();
    if (agent && !selectedId) {
      restoreFromHash();
    } else if (selectedId) {
      const a = DATA.agents.find(a=>a.id===selectedId);
      if (a) renderAgent(a);
    } else {
      document.getElementById('content').innerHTML = renderCrossAgentView();
    }
    el.className = '';
    txt.textContent = t('refreshed')+' '+new Date().toLocaleTimeString();
  } catch(e) {
    el.className = '';
    txt.textContent = '✕ '+e.message;
  }
}

// Initialize button texts
document.getElementById('display-mode-btn').textContent = displayMode === 'cost' ? 'Token' : 'Cost';
document.getElementById('theme-btn').textContent = theme === 'dark' ? '☀' : '☾';
document.getElementById('lang-btn').textContent = lang === 'en' ? '中' : 'EN';
document.getElementById('reset-toggle-btn').textContent = t('resetFiles');
document.getElementById('reset-toggle-btn').style.opacity = includeReset ? 1 : 0.5;
document.getElementById('sidebar-head').textContent = '🦞 ' + t('agents');
document.getElementById('refresh-text').textContent = t('autoRefresh');
document.getElementById('refresh-interval').value = refreshMs;
document.querySelector('#content .empty').textContent = t('selectAgent');
document.getElementById('sidebar-toggle').title = t('toggleSidebar');
document.getElementById('back-btn').title = t('backToOverview');
document.getElementById('agent-title').textContent = t('openclawTrace');

fetchData();
refreshTimer = setInterval(fetchData, refreshMs);

// Handle browser back/forward
window.addEventListener('popstate', () => {
  if (!DATA) return;
  const { agent } = parseHash();
  if (agent) {
    selectedId = agent;
    document.getElementById('back-btn').style.display = '';
    restoreFromHash();
  } else {
    goHome(true);
  }
});
</script>
</body>
</html>`;
