#!/usr/bin/env node
// OpenClaw Trace
// Repository: https://github.com/Tell-Me-Mo/openclaw-trace
// Usage: npx openclaw-trace
// Then open: http://localhost:3141
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = 3141;
const OC   = path.join(os.homedir(), '.openclaw');

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
  if (typeof msg.content === 'string') return msg.content.slice(0, 140);
  if (!Array.isArray(msg.content)) return '';
  return msg.content.filter(c => c.type === 'text').map(c => c.text || '').join('').slice(0, 140);
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
    isError: msg.isError || false,
  });
  step.resultTotalSize = (step.resultTotalSize || 0) + size;
}

function parseHeartbeats(entries) {
  const runs = [];
  let cur = null;

  for (const e of entries) {
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
              size: text.length, preview: text.slice(0, 500), isError: c.isError || false,
            });
            cur.steps[cur.steps.length - 1].resultTotalSize =
              (cur.steps[cur.steps.length - 1].resultTotalSize || 0) + text.length;
          }
        }
        continue;
      }

      if (cur?.steps?.length) runs.push(finalizeRun(cur));
      cur = {
        startTime:    e.timestamp || msg.timestamp || null,
        endTime:      null,
        durationMs:   null,
        trigger:      extractText(msg),
        steps:        [],
        totalCost:    0,
        totalOutput:  0,
        finalContext: 0,
        summary:      '',
      };
      continue;
    }

    if (msg.role === 'assistant' && cur) {
      const u     = msg.usage;
      const cost  = u?.cost?.total ?? 0;
      const text  = extractText(msg);
      const calls = extractToolCalls(msg);
      const ts    = e.timestamp || msg.timestamp || null;

      if (u && (u.totalTokens > 0 || u.output > 0)) {
        cur.steps.push({
          time:             ts,
          output:           u.output      || 0,
          cacheRead:        u.cacheRead   || 0,
          cacheWrite:       u.cacheWrite  || 0,
          totalTokens:      u.totalTokens || 0,
          cost,
          costInput:        u.cost?.input      ?? 0,
          costOutput:       u.cost?.output     ?? 0,
          costCacheRead:    u.cost?.cacheRead  ?? 0,
          costCacheWrite:   u.cost?.cacheWrite ?? 0,
          toolCalls:        calls,
          toolResults:      [],
          resultTotalSize:  0,
          text,
          model:            msg.model || '',
          durationMs:       null,
        });
        cur.totalCost    += cost;
        cur.totalOutput  += u.output || 0;
        cur.finalContext  = Math.max(cur.finalContext, u.totalTokens || 0);
        cur.endTime       = ts;
        if (text && calls.length === 0) cur.summary = text;
      } else if (u && u.totalTokens === 0 && u.output === 0 && (!msg.content || msg.content.length === 0)) {
        // API error — empty response (rate limit, overloaded, or transient failure)
        cur.apiErrors = (cur.apiErrors || 0) + 1;
        cur.endTime = ts;
      }
    }
  }
  if (cur?.steps?.length) runs.push(finalizeRun(cur));
  // Also push runs with only API errors (no successful steps)
  if (cur && !cur.steps.length && cur.apiErrors > 0) runs.push(finalizeRun(cur));
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

  return {
    ...hb,
    steps,
    ...(errorsOnly && { filteredToErrors: true, totalSteps: hb.steps?.length || 0 }),
  };
}

function loadAll() {
  const meta   = getAgentMeta();
  const agents = [];
  const dailyCosts = {}; // { "2026-02-11": cost }
  const dailyHbs   = {}; // { "2026-02-11": count }
  const dailyByAgent = {}; // { "2026-02-11": { agentId: cost } }

  for (const [id, info] of Object.entries(meta)) {
    const sessDir = path.join(OC, 'agents', id, 'sessions');
    const sessFile = path.join(sessDir, 'sessions.json');
    const sessions = readJSON(sessFile) || {};

    const heartbeats = [];
    let totalCost     = 0;
    let totalErrors   = 0;
    let lastTime      = 0;
    let model         = '';
    let contextTokens = 200000;
    let totalTokens   = 0;

    // Read ALL .jsonl files in sessions directory (not just registered ones)
    const allSessionFiles = [];
    try {
      const files = fs.readdirSync(sessDir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          allSessionFiles.push(path.join(sessDir, file));
        }
      }
    } catch (e) {
      // Directory doesn't exist or can't be read
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
      const hbs = parseHeartbeats(readJSONL(sessionFile));
      for (const hb of hbs) {
        totalCost   += hb.totalCost;
        totalErrors += hb.errorCount || 0;
        heartbeats.push(hb);

        // Daily rollup
        if (hb.startTime) {
          const d = new Date(hb.startTime);
          const dateKey = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
          dailyCosts[dateKey] = (dailyCosts[dateKey] || 0) + hb.totalCost;
          dailyHbs[dateKey]   = (dailyHbs[dateKey] || 0) + 1;
          if (!dailyByAgent[dateKey]) dailyByAgent[dateKey] = {};
          dailyByAgent[dateKey][id] = (dailyByAgent[dateKey][id] || 0) + hb.totalCost;
        }
      }
    }

    heartbeats.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    // Average cache hit rate
    const avgCacheHit = heartbeats.length
      ? heartbeats.reduce((sum, hb) => sum + (hb.cacheHitRate || 0), 0) / heartbeats.length
      : 0;

    agents.push({ ...info, model, contextTokens, totalTokens, totalCost, totalErrors, lastTime, heartbeats, avgCacheHit });
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
    if (cost > 0 || i < 2) dailySummary.push({ label, cost, hbs, date: key });
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
    trendData.push({ date: key, label, total: dailyCosts[key] || 0, byAgent: dailyByAgent[key] || {} });
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadAll()));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/agents - List all agents with summary stats
  if (url === '/api/agents') {
    try {
      const data = loadAll();
      const agents = data.agents.map(a => ({
        id: a.id,
        name: a.name,
        emoji: a.emoji,
        model: a.model,
        totalCost: a.totalCost,
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
      const data = loadAll();
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
      const data = loadAll();

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
      const data = loadAll();
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

      const data = loadAll();
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

  // GET /api/budget - Get budget status
  if (url === '/api/budget') {
    try {
      const data = loadAll();
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
      const data = loadAll();
      const today = new Date();
      const dailySummary = [];

      for (let i = 0; i < days; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

        let cost = 0, hbs = 0;
        const byAgent = {};
        for (const a of data.agents) {
          for (const hb of a.heartbeats || []) {
            if (hb.startTime && hb.startTime.startsWith(key)) {
              cost += hb.totalCost;
              hbs++;
              byAgent[a.id] = (byAgent[a.id] || 0) + hb.totalCost;
            }
          }
        }

        dailySummary.push({ date: key, cost, heartbeats: hbs, byAgent });
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
      const data = loadAll();
      const totalCost = data.agents.reduce((s, a) => s + (a.totalCost || 0), 0);
      const totalHbs = data.agents.reduce((s, a) => s + (a.heartbeats?.length || 0), 0);
      const totalErrors = data.agents.reduce((s, a) => s + (a.totalErrors || 0), 0);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalAgents: data.agents.length,
        totalCost,
        totalHeartbeats: totalHbs,
        totalErrors,
        avgCostPerHeartbeat: totalHbs > 0 ? totalCost / totalHbs : 0,
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
  --border:#1e2535;--border-light:#2a3245;--text:#e2e8f0;--muted:#64748b;--muted2:#475569;
  --blue:#60a5fa;--green:#4ade80;--orange:#fbbf24;
  --red:#f87171;--purple:#a78bfa;--accent:#3b82f6;--teal:#2dd4bf;
  --glow-blue:rgba(96,165,250,.08);--glow-green:rgba(74,222,128,.08);
  --radius:10px;--radius-sm:6px;
  --font-sans:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
  --font-mono:'SF Mono','Fira Code',ui-monospace,monospace;
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
.detail-call{flex:1;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px;font-size:11px}
.detail-call-head{font-size:11px;font-weight:600;color:var(--blue);margin-bottom:6px;display:flex;justify-content:space-between}
.detail-call-args{color:var(--muted);margin-bottom:8px;word-break:break-all;white-space:pre-wrap;max-height:80px;overflow-y:auto;font-family:var(--font-mono);font-size:10px}
.detail-result{border-top:1px solid var(--border);padding-top:6px;margin-top:4px}
.detail-result-head{font-size:10px;color:var(--muted);margin-bottom:3px;display:flex;gap:6px;align-items:center}
.detail-result-body{color:var(--text);white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;font-size:10px;opacity:.85;font-family:var(--font-mono)}
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
#refresh{position:fixed;bottom:12px;right:16px;font-size:10px;color:var(--muted);font-family:var(--font-mono)}
#refresh.spin{color:var(--blue)}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--border-light)}
.thinking-cell:hover{background:var(--surface2)22}

</style>
</head>
<body>

<div id="sidebar">
  <div id="sidebar-head">🦞 Agents</div>
  <div id="agent-list"></div>
</div>

<div id="main">
  <div id="topbar">
    <button id="sidebar-toggle" class="sidebar-toggle-btn" onclick="toggleSidebar()" title="Toggle sidebar">☰</button>
    <button id="back-btn" class="back-btn" onclick="goHome()" style="display:none" title="Back to overview">←</button>
    <span id="agent-title" style="cursor:pointer" onclick="if(selectedId)goHome()">OpenClaw Trace</span>
    <span id="pill-model" class="pill model" style="display:none"></span>
    <span id="pill-ctx"   class="pill"       style="display:none"></span>
    <div id="budget-wrap"                     style="display:none">
      <div id="budget-label"><span class="lbl"></span><span class="proj"></span></div>
      <div id="budget-track"><div id="budget-fill"></div></div>
    </div>
    <button id="compare-mode-btn" class="compare-mode-btn" onclick="toggleCompareMode()" style="display:none">Compare</button>
    <div id="daily-pill"><span class="amt"></span> <span class="m"></span></div>
  </div>
  <div id="content"><div class="empty">← select an agent</div></div>
</div>

<div id="refresh">● auto-refresh 5s</div>


<script>
let DATA = null;
let selectedId = null;
let openHbIdx  = null;
const expandedSteps = {};
let compareMode = false;
let compareHbs = []; // [hbIdx1, hbIdx2]
let agentOverviewOpen = true;

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
const fN  = n => (+n||0).toLocaleString();
const fT  = ts => ts ? new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
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
    return \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="#1e2535" stroke-width="1"/>
      <text x="\${padL - 6}" y="\${y + 3}" fill="#475569" font-size="9" text-anchor="end" font-family="var(--font-mono)">\${f$(v)}</text>\`;
  }).join('');

  const bars = vals.map((v, i) => {
    const bh = Math.max(2, Math.round((v / maxV) * chartH));
    const x = padL + i * (barW + gap) + gap / 2;
    const y = padT + chartH - bh;
    const opacity = 0.5 + 0.5 * (v / maxV);
    return \`<g>
      <rect x="\${x}" y="\${y}" width="\${barW}" height="\${bh}" fill="\${color}" rx="3" opacity="\${opacity.toFixed(2)}"><title>\${tipFn ? tipFn(v, i) : v}</title></rect>
      <text x="\${x + barW / 2}" y="\${y - 4}" fill="#94a3b8" font-size="8" text-anchor="middle" font-family="var(--font-mono)">\${f$(v)}</text>
      <text x="\${x + barW / 2}" y="\${h - 6}" fill="#475569" font-size="9" text-anchor="middle">#\${i + 1}</text>
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
    return \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="#1e2535" stroke-width="1"/>
      <text x="\${padL - 6}" y="\${y + 3}" fill="#475569" font-size="9" text-anchor="end" font-family="var(--font-mono)">\${fN(Math.round(v))}</text>\`;
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
      \${showLabel ? \`<text x="\${p.x}" y="\${p.y - 8}" fill="#94a3b8" font-size="9" text-anchor="middle" font-family="var(--font-mono)">\${fN(Math.round(p.v))}</text>\` : ''}
    \`;
  }).join('');

  // X-axis labels
  const xLabels = points.map((p, i) =>
    \`<text x="\${p.x}" y="\${h - 6}" fill="#475569" font-size="9" text-anchor="middle">#\${i + 1}</text>\`
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
  if (!entries.length) return '<div class="m" style="padding:20px;text-align:center;font-size:10px">No tools used</div>';

  const maxCount = Math.max(...entries.map(e => e[1]));
  const colors = {browser:'#60a5fa',read:'#2dd4bf',write:'#2dd4bf',edit:'#2dd4bf',bash:'#fbbf24',grep:'#a78bfa',glob:'#a78bfa'};

  return entries.map(([tool, count]) => {
    const pct = Math.round((count / maxCount) * 100);
    const color = colors[tool] || '#64748b';
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
    return '<div class="m" style="padding:20px;text-align:center;font-size:10px">No duration data</div>';
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
        <div style="width:\${pct}%;height:100%;background:#fbbf24;transition:width .3s"></div>
      </div>
    </div>\`;
  }).join('');
}

// ── Shared chart dimensions ──────────────────────────────────────────────────
const CHART_H = 180; // consistent height across all 3 charts

// ── Chart 1: Cost by Agent (horizontal bar) ─────────────────────────────────
function svgCostByAgent(agents) {
  const sorted = agents.filter(a => a.totalCost > 0).sort((a,b) => b.totalCost - a.totalCost);
  if (!sorted.length) return '<div class="m" style="padding:20px;text-align:center">No cost data</div>';
  const maxCost = sorted[0].totalCost;
  const totalCost = agents.reduce((s,x) => s + x.totalCost, 0);
  const n = sorted.length;
  const barH = Math.min(22, Math.floor((CHART_H - 4) / n) - 4);
  const gap = Math.min(4, Math.floor((CHART_H - n * barH) / Math.max(n - 1, 1)));
  const labelW = 80, chartW = 180, valW = 100;
  const totalW = labelW + chartW + valW;
  const bars = sorted.map((a, i) => {
    const y = i * (barH + gap) + 2;
    const w = Math.max(2, (a.totalCost / maxCost) * chartW);
    const share = totalCost > 0 ? ((a.totalCost / totalCost) * 100).toFixed(0) + '%' : '';
    return \`<g>
      <text x="\${labelW - 6}" y="\${y + barH/2 + 4}" fill="#e2e8f0" font-size="11" text-anchor="end">\${esc(a.emoji)} \${esc(a.name.replace(' Promo',''))}</text>
      <rect x="\${labelW}" y="\${y}" width="\${w.toFixed(1)}" height="\${barH}" rx="3" fill="#60a5fa" opacity="0.8"><title>\${a.emoji} \${a.name}: \${f$(a.totalCost)}</title></rect>
      <text x="\${labelW + w + 6}" y="\${y + barH/2 + 4}" fill="#94a3b8" font-size="10">\${f$(a.totalCost)} <tspan fill="#475569">\${share}</tspan></text>
    </g>\`;
  }).join('');
  return \`<svg width="100%" viewBox="0 0 \${totalW} \${CHART_H}" style="display:block">\${bars}</svg>\`;
}

// ── Chart 2: 7-Day Daily Spend (vertical bar) ──────────────────────────────
function svgDailySpend(trendData) {
  if (!trendData || trendData.length < 1) return '<div class="m" style="padding:20px;text-align:center">No trend data</div>';
  const W = 360, padL = 45, padR = 10, padT = 16, padB = 28;
  const chartW = W - padL - padR, chartH = CHART_H - padT - padB;
  const n = trendData.length;
  const maxV = Math.max(...trendData.map(d => d.total), 0.01);
  const barW = Math.min(36, Math.floor(chartW / n) - 8);
  const gap = (chartW - n * barW) / (n + 1);

  // Grid lines
  const ySteps = 3;
  const gridLines = Array.from({length: ySteps + 1}, (_, i) => {
    const v = maxV * (1 - i / ySteps);
    const y = padT + (i * chartH / ySteps);
    return \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="#1e2535" stroke-width="1"/>
      <text x="\${padL - 6}" y="\${y + 3}" fill="#475569" font-size="9" text-anchor="end">\${f$(v)}</text>\`;
  }).join('');

  const bars = trendData.map((d, i) => {
    const x = padL + gap + i * (barW + gap);
    const barH = Math.max(1, (d.total / maxV) * chartH);
    const y = padT + chartH - barH;
    const isToday = i === n - 1;
    const color = isToday ? '#60a5fa' : '#60a5fa';
    const opacity = isToday ? '0.9' : '0.45';
    return \`<g>
      <rect x="\${x}" y="\${y}" width="\${barW}" height="\${barH.toFixed(1)}" rx="3" fill="\${color}" opacity="\${opacity}"><title>\${esc(d.label)}: \${f$(d.total)}</title></rect>
      <text x="\${x + barW/2}" y="\${y - 4}" fill="#94a3b8" font-size="9" text-anchor="middle">\${f$(d.total)}</text>
      <text x="\${x + barW/2}" y="\${CHART_H - 6}" fill="#475569" font-size="9" text-anchor="middle">\${esc(d.label)}</text>
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
      hourCosts[h] += hb.totalCost || 0;
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
    const color = count > 0 ? '#60a5fa' : '#1e2535';
    const tip = \`\${String(h).padStart(2,'0')}:00 — \${count} heartbeats, \${f$(hourCosts[h])}\`;
    return \`<g>
      <rect x="\${x}" y="\${y}" width="\${barW}" height="\${barH.toFixed(1)}" rx="2" fill="\${color}" opacity="\${opacity.toFixed(2)}"><title>\${esc(tip)}</title></rect>
      \${count > 0 ? \`<text x="\${x + barW/2}" y="\${y - 3}" fill="#64748b" font-size="8" text-anchor="middle">\${count}</text>\` : ''}
      \${h % 3 === 0 ? \`<text x="\${x + barW/2}" y="\${CHART_H - 4}" fill="#475569" font-size="9" text-anchor="middle">\${String(h).padStart(2,'0')}</text>\` : ''}
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
    const cost = last ? f$(last.totalCost) : '—';
    const ago  = fAgo(a.lastTime);
    const hbn  = a.heartbeats?.length||0;
    const errBadge = a.totalErrors ? \`<span class="err-count">⚠\${a.totalErrors}</span>\` : '';

    // Live status dot
    const ageMs = a.lastTime ? Date.now() - a.lastTime : Infinity;
    const dotColor = ageMs < 900000 ? '#4ade80' : ageMs < 3600000 ? '#fbbf24' : '#1e2535'; // 15min green, 1hr yellow, else grey
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
  document.getElementById('agent-title').textContent = 'OpenClaw Trace';
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
    const avg = hbs ? a.totalCost / hbs : 0;
    const errBadge = a.totalErrors ? \`<span class="err-count">⚠\${a.totalErrors}</span>\` : '';
    const hbList = (a.heartbeats || []).slice().reverse();
    const dots = hbList.map(hb => {
      const errs = hb.errorCount || 0;
      const waste = (hb.wasteFlags || []).length;
      const cls = errs > 0 ? 'red' : waste > 0 ? 'yellow' : 'green';
      const t = hb.startTime ? new Date(hb.startTime).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) : '?';
      const tip = t + ' · ' + (errs ? errs+' err' : waste ? waste+' warn' : 'ok') + ' · ' + f$(hb.totalCost);
      return \`<span class="ht-dot \${cls}" title="\${esc(tip)}"></span>\`;
    }).join('');
    return \`<tr onclick="select('\${a.id}')">
      <td><div class="agent-cell">\${a.emoji} \${a.name} \${errBadge}</div></td>
      <td><div class="ht-dots">\${dots}</div></td>
      <td class="r">\${hbs}</td>
      <td class="r g">\${f$(avg)}</td>
      <td class="r g">\${f$(a.totalCost)}</td>
      <td class="m">\${fAgo(a.lastTime)}</td>
    </tr>\`;
  }).join('');

  return \`
    <div class="charts-row">
      <div class="chart-card">
        <div class="section-title">Cost by agent (session)</div>
        \${costChart}
      </div>
      <div class="chart-card">
        <div class="section-title">7-day spend</div>
        \${dailyChart}
      </div>
      <div class="chart-card">
        <div class="section-title">Activity by hour (today)</div>
        \${activityChart}
      </div>
    </div>
    <div class="section-title">All agents</div>
    <table class="cross-agent-tbl">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Health</th>
          <th class="r">Heartbeats</th>
          <th class="r">Avg $/hb</th>
          <th class="r">Session cost</th>
          <th>Last run</th>
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
      const t = hb.startTime ? new Date(hb.startTime).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) : '?';
      const tip = t + ' · ' + (errs ? errs+' err' : waste ? waste+' warn' : 'ok') + ' · ' + f\$(hb.totalCost);
      return \`<span class="ht-dot \${cls}" title="\${esc(tip)}"></span>\`;
    }).join('');
    const greens = hbs.filter(h=>!h.errorCount && !(h.wasteFlags||[]).length).length;
    const reds = hbs.filter(h=>h.errorCount>0).length;
    const summary = hbs.length + ' hb' + (reds ? ', ' + reds + ' err' : '');
    return \`<div class="ht-row">
      <div class="ht-agent" onclick="select('\${a.id}')">\${a.emoji} \${a.name}</div>
      <div class="ht-dots">\${dots}</div>
      <div class="ht-summary">\${summary}</div>
    </div>\`;
  }).filter(Boolean).join('');
  if (!rows) return '';
  return \`<div class="health-timeline">
    <div class="section-title">Heartbeat health timeline (today)</div>
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
  const agentBtns = [\`<span class="error-filter-btn \${errorFilterAgent==='all'?'active':''}" onclick="filterErrors('all')">All</span>\`]
    .concat(agentIds.map(id => {
      const a = agents.find(x=>x.id===id);
      return \`<span class="error-filter-btn \${errorFilterAgent===id?'active':''}" onclick="filterErrors('\${id}')">\${a?.emoji||''} \${a?.name||id}</span>\`;
    })).join('');

  // Count by type
  const typeCounts = {};
  for (const e of allErrors) { typeCounts[e.type||'tool'] = (typeCounts[e.type||'tool'] || 0) + 1; }
  const typeLabels = { api: 'API', browser: 'Browser', tool: 'Tool', system: 'System' };
  const typeColors = { api: 'var(--red)', browser: 'var(--orange)', tool: '#eab308', system: 'var(--muted)' };

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
      <span class="error-title">Error Log</span>
      \${hasErrors
        ? \`<span class="error-badge">\${allErrors.length} error\${allErrors.length>1?'s':''}</span><span class="error-type-counts">\${summaryBadges}</span>\`
        : \`<span class="error-ok-badge">No errors</span>\`}
      <span class="hb-arrow" id="error-arrow">\${expanded?'▾':'▸'}</span>
    </div>
    <div class="error-body \${expanded?'open':''}" id="error-body">
      \${hasErrors ? \`<div class="error-filter">\${typeBtns}</div><div class="error-filter">\${agentBtns}</div>\` : ''}
      \${items || '<div style="padding:10px 12px;color:var(--muted);font-size:10px">No errors today</div>'}
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
  const labels = { all: 'All', browser: 'Browser', file: 'Files', shell: 'Shell', error: 'Errors', other: 'Other' };
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
    <div class="section-title">Actions feed (today)</div>
    <div class="af-controls">\${filterBtns}</div>
    <div class="af-list">\${items || '<div style="padding:10px;color:var(--muted);font-size:10px">No actions recorded</div>'}</div>
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
  compareBtnEl.textContent = compareMode ? 'Exit Compare' : 'Compare';

  const el = document.getElementById('content');
  if (!a.heartbeats?.length) {
    el.innerHTML = '<div class="empty">No heartbeats recorded yet</div>';
    return;
  }

  const hbs   = a.heartbeats;
  const costs = hbs.slice().reverse().map(h=>h.totalCost);
  const ctxs  = hbs.slice().reverse().map(h=>h.finalContext);

  const cachePct = Math.round((a.avgCacheHit || 0) * 100);

  const overviewOpen = typeof agentOverviewOpen === 'undefined' || agentOverviewOpen;
  const ovState = overviewOpen ? 'expanded' : 'collapsed';
  const ovArrow = overviewOpen ? '▼' : '▶';

  el.innerHTML = \`
    <div class="agent-overview">
      <div class="agent-overview-toggle" onclick="toggleAgentOverview()">
        <span class="toggle-arrow">\${ovArrow}</span>
        <span class="section-title">Session overview</span>
        <span style="color:var(--muted);font-size:11px;margin-left:auto">\${f$(a.totalCost)} · \${hbs.length} hb · \${cachePct}% cache</span>
      </div>
      <div class="agent-overview-body \${ovState}" style="max-height:\${overviewOpen?'600px':'0'}">
        <div id="overview">
          <div class="stat-box"><div class="stat-label">Session cost</div><div class="stat-val green">\${f$(a.totalCost)}</div></div>
          <div class="stat-box"><div class="stat-label">Heartbeats</div><div class="stat-val blue">\${hbs.length}</div></div>
          <div class="stat-box"><div class="stat-label">Avg cost / hb</div><div class="stat-val orange">\${f$(a.totalCost/hbs.length)}</div></div>
          <div class="stat-box"><div class="stat-label">Cache hit rate</div><div class="stat-val \${cachePct>70?'green':cachePct>50?'blue':'orange'}">\${cachePct}%</div></div>
          <div class="stat-box" style="display:flex;align-items:center;justify-content:center"><button class="cleanup-btn" onclick="cleanupAgent('\${a.id}')" style="font-size:10px;padding:6px 12px">🗑 Cleanup heartbeats</button></div>
        </div>
        \${compareMode?\`
          <div class="compare-bar">
            <span class="compare-label">Compare mode:</span>
            <span class="compare-chip \${compareHbs.length>=1?'selected':''}">\${compareHbs[0]!==undefined?'#'+(hbs.length-compareHbs[0]):'Select 1st'}</span>
            <span class="m">vs</span>
            <span class="compare-chip \${compareHbs.length>=2?'selected':''}">\${compareHbs[1]!==undefined?'#'+(hbs.length-compareHbs[1]):'Select 2nd'}</span>
            \${compareHbs.length===2?\`<button class="compare-btn" onclick="clearCompare()">Clear</button>\`:''}
          </div>
        \`:''}
        \${compareHbs.length===2?renderComparison(hbs[compareHbs[0]],hbs[compareHbs[1]]):''}
        <div class="chart-row">
          <div class="chart-box">
            <div class="section-title">Cost per heartbeat</div>
            <div class="spark-wrap">\${svgBars(costs,130,'#4ade80',(v,i)=>'#'+(i+1)+' '+f$(v))}</div>
          </div>
          <div class="chart-box">
            <div class="section-title">Context growth over heartbeats</div>
            <div class="spark-wrap">\${svgLine(ctxs,130,'#a78bfa')}</div>
          </div>
        </div>
      </div>
    </div>
    \${hbs.map((hb,i)=>heartbeatRow(hb,i,hbs.length)).join('')}
  \`;
}

// ── Heartbeat row ──────────────────────────────────────────────────────────────
function heartbeatRow(hb, i, total) {
  const isOpen = openHbIdx===i;
  const errBadge = hb.errorCount ? \`<span class="err-count">⚠\${hb.errorCount}</span>\` : '';
  const markAllBtn = hb.errorCount ? \`<button class="mark-all-solved-btn" onclick="event.stopPropagation(); markAllErrorsSolved(\${i})" title="Mark all errors in this heartbeat as solved">✓ All</button>\` : '';
  const hbId = hb.startTime || i;
  const browserBadge = Object.keys(hb.browserBreakdown||{}).length
    ? \`<span class="hb-browser">\${Object.entries(hb.browserBreakdown).map(([k,v])=>k+'×'+v).join(' ')}</span>\`
    : '';

  const compareSelected = compareHbs.includes(i);
  const hbCls = compareSelected ? 'style="background:var(--blue)11"' : '';

  // API URLs
  const apiUrl = \`http://127.0.0.1:3141/api/heartbeat?agent=\${selectedId}&hb=\${i}\`;
  const apiUrlErrors = \`http://127.0.0.1:3141/api/heartbeat?agent=\${selectedId}&hb=\${i}&errors_only=true\`;

  return \`<div class="hb" id="hb\${i}" \${hbCls}>
    <div class="hb-head \${isOpen?'open':''}" onclick="toggleHb(\${i})" \${hbCls}>
      <span class="hb-num">#\${total-i}</span>
      <span class="hb-time">\${fT(hb.startTime)}</span>
      <span class="hb-cost">\${f$(hb.totalCost)}</span>
      <span class="hb-ctx">ctx \${fN(hb.finalContext)}</span>
      <span class="hb-dur">\${fD(hb.durationMs)}</span>
      <span class="hb-steps">\${hb.steps?.length||0} steps</span>
      \${errBadge}
      \${markAllBtn}
      \${browserBadge}
      <span class="hb-sum">\${esc(hb.summary||hb.trigger||'')}</span>
      <div class="hb-api-btns" onclick="event.stopPropagation()">
        <button class="api-btn" onclick="copyApiUrl('\${apiUrl}', this)" title="Copy API URL (all steps)">📋 API</button>
        <button class="api-btn" onclick="copyApiUrl('\${apiUrlErrors}', this)" title="Copy API URL (errors only)">⚠ API</button>
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
  if (!steps.length) return '<div class="empty">No steps</div>';

  const costs   = steps.map(s=>s.cost||0);
  const ctxs    = steps.map(s=>s.totalTokens||0);
  const avgCost = costs.reduce((a,b)=>a+b,0)/costs.length;

  const totIn  = steps.reduce((s,x)=>s+(x.costInput||0),0);
  const totOut = steps.reduce((s,x)=>s+(x.costOutput||0),0);
  const totCR  = steps.reduce((s,x)=>s+(x.costCacheRead||0),0);
  const totCW  = steps.reduce((s,x)=>s+(x.costCacheWrite||0),0);
  const totRes = steps.reduce((s,x)=>s+(x.resultTotalSize||0),0);
  const maxStep = Math.max(...costs, 1e-9);

  const open = expandedSteps[hbIdx] || new Set();

  // Waste hints
  const wasteHtml = (hb.wasteFlags && hb.wasteFlags.length) ? \`
    <div class="waste-hints">
      <div class="waste-title"><span class="waste-icon">⚠</span> Optimization hints</div>
      <div class="waste-list">
        \${hb.wasteFlags.map(w => \`<div class="waste-item"><span class="waste-icon">•</span><span>\${esc(w.msg)}</span></div>\`).join('')}
      </div>
    </div>
  \` : '';

  return \`
    \${wasteHtml}
    <div class="hb-stats-grid">
      <div class="stat-chart-card">
        <div class="stat-chart-title">💰 Cost per step</div>
        <div class="stat-chart-content">
          \${svgBars(costs,130,'#4ade80',(v,i)=>'step '+(i+1)+' '+f$(v))}
        </div>
      </div>
      <div class="stat-chart-card">
        <div class="stat-chart-title">🔧 Tool usage</div>
        <div class="stat-chart-content" style="display:block;overflow-y:auto;max-height:140px">
          \${svgToolBreakdown(steps)}
        </div>
      </div>
      <div class="stat-breakdown-card">
        <div class="stat-chart-title">📊 Cost breakdown</div>
        <div class="breakdown-table">
          <div class="breakdown-row"><span class="breakdown-label">Input</span><span class="breakdown-value g">\${f$(totIn)}</span></div>
          <div class="breakdown-row"><span class="breakdown-label">Output</span><span class="breakdown-value g">\${f$(totOut)}</span></div>
          <div class="breakdown-row"><span class="breakdown-label">Cache read</span><span class="breakdown-value g">\${f$(totCR)}</span></div>
          <div class="breakdown-row"><span class="breakdown-label">Cache write</span><span class="breakdown-value g">\${f$(totCW)}</span></div>
          <div class="breakdown-row"><span class="breakdown-label">Tool results</span><span class="breakdown-value b">\${fSz(totRes)}</span></div>
          <div class="breakdown-row breakdown-total">
            <span class="breakdown-label"><b>Total</b></span>
            <span class="breakdown-value g"><b>\${f$(hb.totalCost)}</b></span>
          </div>
        </div>
      </div>
    </div>
    <table class="tbl">
      <thead>
        <tr>
          <th>#</th>
          <th>Time</th>
          <th class="sortable" onclick="sortSteps(\${hbIdx},'dur')">Dur <span class="sort-arrow" id="sort-dur-\${hbIdx}"></span></th>
          <th class="sortable" onclick="sortSteps(\${hbIdx},'action')">Action <span class="sort-arrow" id="sort-action-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'result')">Result <span class="sort-arrow" id="sort-result-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'output')">Out tok <span class="sort-arrow" id="sort-output-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'cacheRead')">Cache R <span class="sort-arrow" id="sort-cacheRead-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'ctx')">Ctx <span class="sort-arrow" id="sort-ctx-\${hbIdx}"></span></th>
          <th class="r sortable" onclick="sortSteps(\${hbIdx},'cost')">Cost <span class="sort-arrow" id="sort-cost-\${hbIdx}"></span></th>
          <th>Thinking</th>
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
  const heat   = s.cost > avgCost*3 ? 'step-hot' : s.cost > avgCost*1.5 ? 'step-warm' : '';
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
  const errorBadge = hasError ? '<span class="err-badge" style="margin-left:4px">ERROR</span>' : '';

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

  const mainRow = \`<tr class="step-row \${heat} \${expanded}" onclick="toggleStep(\${hbIdx},\${si})">
    <td class="m">\${si+1}</td>
    <td class="m">\${fT(s.time)}</td>
    <td class="m">\${fD(s.durationMs)}</td>
    <td style="max-width:280px">\${actionCell}</td>
    <td class="r b">\${fSz(s.resultTotalSize)}</td>
    <td class="r o">\${fN(s.output)}</td>
    <td class="r p">\${fN(s.cacheRead)}</td>
    <td class="r p">\${fN(s.totalTokens)}</td>
    <td class="r g">
      <span class="cost-bar" style="width:\${Math.round((s.cost||0)/maxStep*36)}px"></span>\${f$(s.cost)}
    </td>
    <td class="m thinking-cell" style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px\${isTruncated?';cursor:pointer;text-decoration:underline dotted':''}"
        title="\${isTruncated?'Click row to see full text':''}">
      \${thinkingPreview}\${isTruncated?' <span style="color:var(--blue);font-weight:600">↓</span>':''}
    </td>
  </tr>\`;

  if (!isOpen) return mainRow;

  return mainRow + \`<tr class="step-detail"><td colspan="10">\${stepDetail(s, hbIdx, hbId, si)}</td></tr>\`;
}

// ── Step detail panel ─────────────────────────────────────────────────────────
function stepDetail(s, hbIdx, hbId, stepIdx) {
  const calls = s.toolCalls || [];
  const results = s.toolResults || [];
  const thinkingText = s.text || '';

  // Thinking text section (if present)
  const thinkingHtml = thinkingText ? \`
    <div class="thinking-section">
      <div class="thinking-label">💭 Thinking</div>
      <div class="thinking-text">\${esc(thinkingText)}</div>
    </div>
  \` : '';

  if (!calls.length && !results.length) {
    return \`<div class="step-detail-inner">
      \${thinkingHtml}
      \${!thinkingText ? '<div class="m" style="font-size:10px;padding:4px">No tool calls — model reasoning step</div>' : ''}
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
        errBadge = \`<span class="err-badge-solved" style="background:#444;color:#888">✓ SOLVED</span>\`;
      } else {
        errBadge = \`<span class="err-badge">ERROR</span> <button class="mark-solved-btn" onclick="markErrorSolved('\${selectedId}','\${hbId}',\${stepIdx},\${resultIdx})">Mark as solved</button>\`;
      }
    }

    resultHtml = \`<div class="detail-result">
      <div class="detail-result-head">
        <span class="m">result</span>
        <span class="b">\${fSz(result.size)}</span>
        \${errBadge}
      </div>
      <div class="detail-result-body \${hasError && !isSolved?'r2':''}">\${esc(result.preview)}\${result.size>(result.preview||'').length?'<span class="m"> …('+fSz(result.size)+' total)</span>':''}</div>
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
      <div class="compare-col-title">Session 1</div>
      <div class="compare-stat"><span class="lbl">Cost</span><span class="val">\${f$(hb1.totalCost)}</span></div>
      <div class="compare-stat"><span class="lbl">Steps</span><span class="val">\${hb1.steps?.length||0}</span></div>
      <div class="compare-stat"><span class="lbl">Context</span><span class="val">\${fN(hb1.finalContext)}</span></div>
      <div class="compare-stat"><span class="lbl">Cache hit</span><span class="val">\${Math.round((hb1.cacheHitRate||0)*100)}%</span></div>
      <div class="compare-stat"><span class="lbl">Duration</span><span class="val">\${fD(hb1.durationMs)}</span></div>
      <div class="compare-stat"><span class="lbl">Errors</span><span class="val">\${hb1.errorCount||0}</span></div>
    </div>
    <div class="compare-col">
      <div class="compare-col-title">Session 2 (delta)</div>
      <div class="compare-stat"><span class="lbl">Cost</span><span class="val">\${f$(hb2.totalCost)}\${delta(hb1.totalCost,hb2.totalCost,f$)}</span></div>
      <div class="compare-stat"><span class="lbl">Steps</span><span class="val">\${hb2.steps?.length||0}\${delta(hb1.steps?.length||0,hb2.steps?.length||0,v=>v)}</span></div>
      <div class="compare-stat"><span class="lbl">Context</span><span class="val">\${fN(hb2.finalContext)}\${delta(hb1.finalContext,hb2.finalContext,fN)}</span></div>
      <div class="compare-stat"><span class="lbl">Cache hit</span><span class="val">\${Math.round((hb2.cacheHitRate||0)*100)}%\${delta(Math.round((hb1.cacheHitRate||0)*100),Math.round((hb2.cacheHitRate||0)*100),v=>v+'%')}</span></div>
      <div class="compare-stat"><span class="lbl">Duration</span><span class="val">\${fD(hb2.durationMs)}</span></div>
      <div class="compare-stat"><span class="lbl">Errors</span><span class="val">\${hb2.errorCount||0}\${delta(hb1.errorCount||0,hb2.errorCount||0,v=>v)}</span></div>
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
  compareMode = false;
  compareHbs = [];
  if (!skipPush) history.pushState(null, '', window.location.pathname);
  renderSidebar();
  document.getElementById('back-btn').style.display = 'none';
  document.getElementById('agent-title').textContent = 'OpenClaw Trace';
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
      case 'cost': valA = a.cost || 0; valB = b.cost || 0; break;
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
  compareMode = false;
  compareHbs = [];
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
  if (compareMode) {
    // In compare mode: select heartbeats for comparison
    if (compareHbs.includes(i)) {
      compareHbs = compareHbs.filter(x => x !== i);
    } else if (compareHbs.length < 2) {
      compareHbs.push(i);
    }
    if (!DATA) return;
    const a = DATA.agents.find(a=>a.id===selectedId);
    if (a) renderAgent(a);
    return;
  }

  // Normal mode: toggle open/close
  openHbIdx = openHbIdx===i ? null : i;
  updateHash();
  if (!expandedSteps[i]) expandedSteps[i] = new Set();
  if (!DATA) return;
  const a = DATA.agents.find(a=>a.id===selectedId);
  if (a) renderAgent(a);
  if (openHbIdx !== null)
    setTimeout(()=>document.getElementById('hb'+i)?.scrollIntoView({behavior:'smooth',block:'nearest'}),50);
}

function toggleStep(hbIdx, stepIdx) {
  if (!expandedSteps[hbIdx]) expandedSteps[hbIdx] = new Set();
  const set = expandedSteps[hbIdx];
  if (set.has(stepIdx)) set.delete(stepIdx); else set.add(stepIdx);

  if (!DATA) return;
  const a    = DATA.agents.find(a=>a.id===selectedId);
  const hb   = a?.heartbeats?.[hbIdx];
  if (!hb) return;
  const hbId    = hb.startTime || hbIdx;
  const steps   = hb.steps||[];
  const costs   = steps.map(s=>s.cost||0);
  const avgCost = costs.reduce((a,b)=>a+b,0)/costs.length;
  const maxStep = Math.max(...costs,1e-9);
  const tbody = document.getElementById('steps-'+hbIdx);
  if (tbody) tbody.innerHTML = steps.map((s,si)=>stepRows(s,si,hbIdx,hbId,maxStep,avgCost,set)).join('');
}

// ── Cleanup heartbeats ───────────────────────────────────────────────────────
async function cleanupAgent(agentId) {
  const agent = DATA?.agents?.find(a => a.id === agentId);
  const name = agent ? agent.name : agentId;
  const hbCount = agent?.heartbeats?.length || 0;
  if (!confirm(\`Delete all \${hbCount} heartbeat sessions for \${name}?\\n\\nThis cannot be undone.\`)) return;
  try {
    const r = await fetch(\`/api/cleanup?agent=\${agentId}\`, { method: 'DELETE' });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    fetchData();
  } catch (e) {
    alert('Cleanup failed: ' + e.message);
  }
}

// ── Data fetching ──────────────────────────────────────────────────────────────
async function fetchData() {
  const el = document.getElementById('refresh');
  el.className = 'spin'; el.textContent = '⟳ loading…';
  try {
    const r = await fetch('/api/data');
    if (!r.ok) throw new Error('HTTP '+r.status);
    DATA = await r.json();

    // Recalculate error counts for all agents, excluding solved errors
    for (const agent of DATA.agents || []) {
      recalculateErrorCounts(agent);
    }

    renderSidebar();

    // Update daily pill
    const daily = DATA.dailySummary || [];
    const today = daily.find(d => d.label === 'Today');
    if (today && today.cost > 0) {
      const pill = document.getElementById('daily-pill');
      pill.querySelector('.amt').textContent = f$(today.cost);
      pill.querySelector('.m').textContent = 'today ('+today.hbs+' hb)';
      pill.style.display = '';
    }

    // Update budget bar
    const budget = DATA.budget || {};
    if (budget.daily && budget.todayCost !== undefined) {
      const pct = Math.min(100, (budget.todayCost / budget.daily) * 100);
      const cls = pct > 90 ? 'budget-over' : pct > 70 ? 'budget-warn' : 'budget-ok';
      const bWrap = document.getElementById('budget-wrap');
      bWrap.querySelector('.lbl').textContent = \`Budget: \${f$(budget.todayCost)} / \${f$(budget.daily)}\`;
      bWrap.querySelector('.proj').textContent = \`~\${f$(budget.projectedMonthly)}/mo\`;
      const bFill = document.getElementById('budget-fill');
      bFill.style.width = pct + '%';
      bFill.className = cls;
      bWrap.style.display = '';
    }

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
    el.textContent = '● refreshed '+new Date().toLocaleTimeString();
  } catch(e) {
    el.className = '';
    el.textContent = '✕ '+e.message;
  }
}

fetchData();
setInterval(fetchData, 5000);

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
