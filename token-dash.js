#!/usr/bin/env node
// OpenClaw Token Dashboard
// Usage: node ~/.openclaw/canvas/token-dash.js
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
      }
    }
  }
  if (cur?.steps?.length) runs.push(finalizeRun(cur));
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

  // Error count
  r.errorCount = r.steps.reduce((sum, s) =>
    sum + (s.toolResults?.filter(tr => tr.isError).length || 0), 0);

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

function loadAll() {
  const meta   = getAgentMeta();
  const agents = [];
  const dailyCosts = {}; // { "2026-02-11": cost }
  const dailyHbs   = {}; // { "2026-02-11": count }
  const dailyByAgent = {}; // { "2026-02-11": { agentId: cost } }

  for (const [id, info] of Object.entries(meta)) {
    const sessFile = path.join(OC, 'agents', id, 'sessions', 'sessions.json');
    const sessions = readJSON(sessFile) || {};

    const heartbeats = [];
    let totalCost     = 0;
    let totalErrors   = 0;
    let lastTime      = 0;
    let model         = '';
    let contextTokens = 200000;
    let totalTokens   = 0;

    for (const sess of Object.values(sessions)) {
      if (!sess.sessionFile) continue;
      model         = sess.model         || model;
      contextTokens = sess.contextTokens || contextTokens;
      totalTokens   = Math.max(totalTokens, sess.totalTokens || 0);
      lastTime      = Math.max(lastTime, sess.updatedAt || 0);
      const hbs = parseHeartbeats(readJSONL(sess.sessionFile));
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

  return { agents, dailySummary, budget: { ...budget, todayCost, projectedMonthly, avg7 }, trendData };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

http.createServer((req, res) => {
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

  if (url === '/api/export') {
    try {
      const format = params.get('format') || 'json';
      const days = parseInt(params.get('days') || '7', 10);
      const data = loadAll();
      const cutoff = Date.now() - (days * 86400000);

      // Flatten all heartbeats
      const rows = [];
      for (const a of data.agents) {
        for (const hb of a.heartbeats || []) {
          if (hb.startTime && new Date(hb.startTime).getTime() >= cutoff) {
            rows.push({
              agent: a.name,
              date: new Date(hb.startTime).toISOString().split('T')[0],
              time: new Date(hb.startTime).toISOString(),
              cost: hb.totalCost,
              steps: hb.steps?.length || 0,
              errors: hb.errorCount || 0,
              cacheHitPct: Math.round((hb.cacheHitRate || 0) * 100),
              context: hb.finalContext || 0,
              durationMs: hb.durationMs || 0,
            });
          }
        }
      }

      if (format === 'csv') {
        const header = 'agent,date,time,cost,steps,errors,cacheHitPct,context,durationMs\n';
        const csv = header + rows.map(r =>
          `${r.agent},${r.date},${r.time},${r.cost},${r.steps},${r.errors},${r.cacheHitPct},${r.context},${r.durationMs}`
        ).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="openclaw-tokens-${days}d.csv"` });
        res.end(csv);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows, null, 2));
      }
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
}).listen(PORT, () => {
  console.log(`\n  🦞 Token Dashboard → http://localhost:${PORT}\n`);
});

// ── Frontend ──────────────────────────────────────────────────────────────────

const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--surface:#161b22;--surface2:#21262d;--surface3:#2d333b;
  --border:#30363d;--text:#e6edf3;--muted:#8b949e;
  --blue:#58a6ff;--green:#3fb950;--orange:#e3b341;
  --red:#f85149;--purple:#bc8cff;--accent:#1f6feb;--teal:#39d353;
}
body{background:var(--bg);color:var(--text);font:12px/1.5 'SF Mono',ui-monospace,monospace;display:flex;height:100vh;overflow:hidden}

/* ── Sidebar ── */
#sidebar{width:210px;border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0;display:flex;flex-direction:column}
#sidebar-head{padding:10px 12px;border-bottom:1px solid var(--border);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.agent-row{padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border)44;transition:background .12s}
.agent-row:hover{background:var(--surface2)}
.agent-row.active{background:var(--accent)20;border-left:2px solid var(--blue);padding-left:10px}
.agent-name{font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px}
.agent-sub{font-size:10px;color:var(--muted);margin-top:1px;display:flex;gap:6px}
.agent-cost{color:var(--green)}
.no-data{color:var(--border)}
.err-count{background:var(--red)22;color:var(--red);font-size:9px;padding:1px 4px;border-radius:3px;font-weight:600}

/* ── Main ── */
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}

/* ── Topbar ── */
#topbar{padding:9px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0}
#agent-title{font-size:13px;font-weight:600;white-space:nowrap}
.pill{font-size:10px;padding:2px 7px;border-radius:10px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);white-space:nowrap}
.pill.model{color:var(--blue)}
.pill.pct-low{color:var(--green)}.pill.pct-med{color:var(--orange)}.pill.pct-high{color:var(--red)}
#ctx-wrap{flex:1;max-width:180px;min-width:60px}
#ctx-label{font-size:9px;color:var(--muted);margin-bottom:2px}
#ctx-track{height:3px;background:var(--border);border-radius:2px}
#ctx-fill{height:3px;border-radius:2px;background:var(--purple);transition:width .3s}
#daily-pill{margin-left:auto;font-size:10px;color:var(--green);background:var(--surface2);padding:3px 8px;border-radius:10px;border:1px solid var(--border);display:none}
#daily-pill .amt{font-weight:600}
.export-btn{font-size:10px;padding:3px 8px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);color:var(--blue);cursor:pointer;transition:background .12s;text-decoration:none;display:inline-block}
.export-btn:hover{background:var(--surface3)}
#budget-wrap{flex:1;max-width:220px;min-width:120px;display:none}
#budget-label{font-size:9px;color:var(--muted);margin-bottom:2px;display:flex;justify-content:space-between}
#budget-track{height:6px;background:var(--border);border-radius:3px;overflow:hidden}
#budget-fill{height:6px;border-radius:3px;transition:width .3s,background .3s}
.budget-ok{background:var(--green)}.budget-warn{background:var(--orange)}.budget-over{background:var(--red)}

/* ── Content ── */
#content{flex:1;overflow-y:auto;padding:12px 14px}

/* ── Overview ── */
#overview{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.stat-box{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;flex:1;min-width:100px}
.stat-label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.stat-val{font-size:16px;font-weight:600;margin-top:2px}
.stat-val.green{color:var(--green)}.stat-val.purple{color:var(--purple)}.stat-val.blue{color:var(--blue)}.stat-val.orange{color:var(--orange)}

/* ── Cross-agent table ── */
.cross-agent-tbl{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px}
.cross-agent-tbl th{padding:6px 10px;text-align:left;color:var(--muted);font-weight:600;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.cross-agent-tbl td{padding:6px 10px;border-bottom:1px solid var(--border)33}
.cross-agent-tbl tbody tr{cursor:pointer;transition:background .12s}
.cross-agent-tbl tbody tr:hover{background:var(--surface2)}
.cross-agent-tbl .r{text-align:right;font-variant-numeric:tabular-nums}
.cross-agent-tbl .agent-cell{font-weight:600;display:flex;align-items:center;gap:6px}

/* ── Daily summary ── */
.daily-summary{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.daily-chip{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:10px}
.daily-chip-label{color:var(--muted);font-size:9px;margin-bottom:2px}
.daily-chip-val{color:var(--green);font-weight:600;font-size:13px}
.daily-chip-sub{color:var(--muted);font-size:9px;margin-top:1px}

/* ── Charts ── */
.section-title{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
.spark-wrap{overflow-x:auto;margin-bottom:16px}
.chart-row{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
.chart-box{flex:1;min-width:160px}

/* ── Heartbeat list ── */
.hb{border:1px solid var(--border);border-radius:6px;margin-bottom:7px;overflow:hidden}
.hb-head{padding:8px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;background:var(--surface);transition:background .12s;user-select:none}
.hb-head:hover,.hb-head.open{background:var(--surface2)}
.hb-num{font-size:10px;color:var(--muted);min-width:22px}
.hb-time{font-size:10px;color:var(--muted);min-width:50px}
.hb-cost{font-size:11px;font-weight:600;color:var(--green);min-width:56px}
.hb-ctx{font-size:10px;color:var(--purple);min-width:80px}
.hb-dur{font-size:10px;color:var(--muted);min-width:36px}
.hb-steps{font-size:10px;color:var(--muted);min-width:44px}
.hb-browser{font-size:9px;color:var(--blue);background:var(--blue)11;border:1px solid var(--blue)33;border-radius:10px;padding:1px 6px;white-space:nowrap}
.hb-cache{font-size:9px;border-radius:10px;padding:1px 6px;white-space:nowrap;font-weight:600}
.cache-good{color:var(--green);background:var(--green)11;border:1px solid var(--green)33}
.cache-ok{color:var(--blue);background:var(--blue)11;border:1px solid var(--blue)33}
.cache-low{color:var(--orange);background:var(--orange)11;border:1px solid var(--orange)33}
.hb-sum{font-size:10px;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb-arrow{font-size:9px;color:var(--muted)}

/* ── Heartbeat body ── */
.hb-body{display:none;padding:10px 12px 12px;background:var(--bg);border-top:1px solid var(--border)}
.hb-body.open{display:block}

/* ── Tool frequency bar ── */
.tool-freq{font-size:10px;color:var(--muted);margin-bottom:10px;padding:6px 8px;background:var(--surface);border-radius:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tool-freq-label{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.06em;margin-right:4px}
.tf-chip{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1px 7px;font-size:10px;white-space:nowrap}
.tf-chip.t-browser{color:var(--blue);border-color:var(--blue)33}
.tf-chip.t-read,.tf-chip.t-write,.tf-chip.t-edit{color:var(--teal);border-color:var(--teal)33}
.tf-chip.t-bash{color:var(--orange);border-color:var(--orange)33}
.tf-chip.t-other{color:var(--muted)}

/* ── Step table ── */
.tbl{width:100%;border-collapse:collapse;font-size:11px}
.tbl th{padding:3px 8px;text-align:left;color:var(--muted);font-weight:normal;border-bottom:1px solid var(--border);white-space:nowrap;font-size:10px}
.tbl td{padding:3px 8px;border-bottom:1px solid var(--border)33;vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl .r{text-align:right;font-variant-numeric:tabular-nums}
.tbl .g{color:var(--green)}.tbl .b{color:var(--blue)}.tbl .p{color:var(--purple)}.tbl .o{color:var(--orange)}.tbl .m{color:var(--muted)}.tbl .r2{color:var(--red)}
.cost-bar{display:inline-block;height:5px;background:var(--green);border-radius:2px;vertical-align:middle;margin-right:3px;opacity:.8}

/* ── Step row heat colors ── */
.step-row{cursor:pointer;transition:background .1s}
.step-row:hover{background:var(--surface2) !important}
.step-warm{background:rgba(227,179,65,.06)}
.step-hot{background:rgba(248,81,73,.08)}
.step-row.expanded{background:var(--surface2)}

/* ── Step detail panel ── */
.step-detail td{padding:0 !important;border-bottom:1px solid var(--border) !important}
.step-detail-inner{padding:8px 10px;background:var(--surface3);display:flex;gap:12px;flex-wrap:wrap}
.detail-call{flex:1;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:6px 8px;font-size:10px}
.detail-call-head{font-size:10px;font-weight:600;color:var(--blue);margin-bottom:4px;display:flex;justify-content:space-between}
.detail-call-args{color:var(--muted);margin-bottom:6px;word-break:break-all;white-space:pre-wrap;max-height:80px;overflow-y:auto}
.detail-result{border-top:1px solid var(--border);padding-top:4px;margin-top:2px}
.detail-result-head{font-size:9px;color:var(--muted);margin-bottom:2px;display:flex;gap:6px;align-items:center}
.detail-result-body{color:var(--text);white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;font-size:10px;opacity:.8}
.err-badge{color:var(--red);font-size:9px;background:rgba(248,81,73,.1);padding:1px 5px;border-radius:3px}

/* ── Waste warnings ── */
.waste-hints{background:var(--surface);border:1px solid var(--orange)44;border-radius:6px;padding:8px 10px;margin-bottom:10px}
.waste-title{font-size:10px;color:var(--orange);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px}
.waste-list{font-size:10px;color:var(--muted);line-height:1.4}
.waste-item{margin-bottom:2px;display:flex;gap:6px}
.waste-icon{color:var(--orange)}

/* ── Comparison ── */
.compare-bar{background:var(--surface);border:1px solid var(--blue)44;border-radius:6px;padding:8px 12px;margin-bottom:10px;display:flex;align-items:center;gap:10px}
.compare-label{font-size:10px;color:var(--blue);font-weight:600}
.compare-chip{font-size:10px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:2px 8px;color:var(--muted)}
.compare-chip.selected{border-color:var(--blue);color:var(--blue)}
.compare-btn{font-size:10px;padding:3px 8px;border-radius:6px;background:var(--blue)22;border:1px solid var(--blue)44;color:var(--blue);cursor:pointer;transition:background .12s}
.compare-btn:hover{background:var(--blue)33}
.compare-view{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.compare-col{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px}
.compare-col-title{font-size:10px;font-weight:600;color:var(--blue);margin-bottom:8px}
.compare-stat{font-size:10px;padding:4px 0;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)33}
.compare-stat:last-child{border-bottom:none}
.compare-stat .lbl{color:var(--muted)}
.compare-stat .val{color:var(--text);font-weight:600}
.compare-delta{font-size:9px;margin-left:6px}
.delta-pos{color:var(--green)}.delta-neg{color:var(--red)}.delta-zero{color:var(--muted)}

/* ── Misc ── */
.empty{padding:40px;text-align:center;color:var(--muted);font-size:11px}
#refresh{position:fixed;bottom:10px;right:12px;font-size:10px;color:var(--muted)}
#refresh.spin{color:var(--blue)}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>

<div id="sidebar">
  <div id="sidebar-head">🦞 Agents</div>
  <div id="agent-list"></div>
</div>

<div id="main">
  <div id="topbar">
    <span id="agent-title">Token Dashboard</span>
    <span id="pill-model" class="pill model" style="display:none"></span>
    <span id="pill-ctx"   class="pill"       style="display:none"></span>
    <div  id="ctx-wrap"                       style="display:none">
      <div id="ctx-label"></div>
      <div id="ctx-track"><div id="ctx-fill"></div></div>
    </div>
    <div id="budget-wrap"                     style="display:none">
      <div id="budget-label"><span class="lbl"></span><span class="proj"></span></div>
      <div id="budget-track"><div id="budget-fill"></div></div>
    </div>
    <a href="/api/export?format=csv&days=7" class="export-btn" download>↓ CSV</a>
    <a href="/api/export?format=json&days=7" class="export-btn" download>↓ JSON</a>
    <div id="daily-pill"><span class="amt"></span> <span class="m"></span></div>
  </div>
  <div id="content"><div class="empty">← select an agent</div></div>
</div>

<div id="refresh">● auto-refresh 30s</div>

<script>
let DATA = null;
let selectedId = null;
let openHbIdx  = null;
const expandedSteps = {};
let compareMode = false;
let compareHbs = []; // [hbIdx1, hbIdx2]

// ── Formatters ────────────────────────────────────────────────────────────────
const f$  = n => '$' + (+n||0).toFixed(4);
const fN  = n => (+n||0).toLocaleString();
const fT  = ts => ts ? new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
const fD  = ms => { if(!ms) return '—'; const s=Math.round(ms/1000); return s<60?s+'s':s<3600?Math.floor(s/60)+'m':Math.floor(s/3600)+'h'; };
const fAgo= ms => {
  if(!ms) return '';
  const s = Math.round((Date.now()-ms)/1000);
  return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':s<86400?Math.floor(s/3600)+'h ago':Math.floor(s/86400)+'d ago';
};
const fModel = m => (m||'').replace('claude-','').replace(/-2025\\d{4}$/,'');
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fSz = n => { if(!n) return '—'; if(n>=1000000) return (n/1000000).toFixed(1)+'M'; if(n>=1000) return (n/1000).toFixed(1)+'k'; return n+'c'; };

// ── SVG helpers ──────────────────────────────────────────────────────────────
function svgBars(vals, h, color, tipFn) {
  if (!vals.length) return '<svg></svg>';
  const maxV = Math.max(...vals, 1e-9);
  const barW = Math.max(6, Math.min(30, Math.floor(560/vals.length)-2));
  const gap  = 2;
  const W    = vals.length*(barW+gap);
  const bars = vals.map((v,i) => {
    const bh = Math.max(1, Math.round((v/maxV)*(h-14)));
    const x  = i*(barW+gap);
    const y  = h-bh-14;
    return \`<rect x="\${x}" y="\${y}" width="\${barW}" height="\${bh}" fill="\${color}" rx="1" opacity=".85"><title>\${tipFn?tipFn(v,i):v}</title></rect>\`;
  }).join('');
  return \`<svg width="\${W}" height="\${h}" style="display:block">\${bars}</svg>\`;
}

function svgLine(vals, h, color) {
  const n = vals.length;
  if (n < 2) return '<svg></svg>';
  const maxV = Math.max(...vals, 1);
  const W    = Math.max(n*8, 80);
  const pts  = vals.map((v,i) => {
    const x = Math.round(i*(W-4)/(n-1))+2;
    const y = Math.round((1-v/maxV)*(h-6))+3;
    return x+','+y;
  }).join(' ');
  return \`<svg width="\${W}" height="\${h}" style="display:block">
    <polyline points="\${pts}" fill="none" stroke="\${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>\`;
}

function svgTrendChart(trendData, agents) {
  const n = trendData.length;
  if (n < 2) return '<div class="m" style="padding:20px;text-align:center">Not enough data</div>';

  const W = 600, H = 140, padL = 40, padR = 10, padT = 20, padB = 30;
  const chartW = W - padL - padR, chartH = H - padT - padB;

  const maxV = Math.max(...trendData.map(d => d.total), 0.01);
  const agentColors = ['#58a6ff','#3fb950','#e3b341','#f85149','#bc8cff','#39d353','#ff7b72','#ffa657','#79c0ff'];

  // Build lines per agent
  const agentIds = [...new Set(trendData.flatMap(d => Object.keys(d.byAgent)))];
  const lines = agentIds.slice(0,9).map((aid,idx) => {
    const vals = trendData.map(d => d.byAgent[aid] || 0);
    const pts = vals.map((v,i) => {
      const x = padL + (i * chartW / (n-1));
      const y = padT + chartH - (v / maxV * chartH);
      return x.toFixed(1)+','+y.toFixed(1);
    }).join(' ');
    const agent = agents.find(a => a.id === aid);
    const color = agentColors[idx % agentColors.length];
    return { pts, color, name: agent?.name || aid, emoji: agent?.emoji || '' };
  });

  // Total line
  const totalPts = trendData.map((d,i) => {
    const x = padL + (i * chartW / (n-1));
    const y = padT + chartH - (d.total / maxV * chartH);
    return x.toFixed(1)+','+y.toFixed(1);
  }).join(' ');

  // X-axis labels
  const xLabels = trendData.map((d,i) => {
    const x = padL + (i * chartW / (n-1));
    return \`<text x="\${x}" y="\${H-8}" fill="#8b949e" font-size="9" text-anchor="middle">\${esc(d.label)}</text>\`;
  }).join('');

  // Y-axis labels
  const ySteps = 3;
  const yLabels = Array.from({length:ySteps+1}, (_,i) => {
    const v = maxV * (1 - i/ySteps);
    const y = padT + (i * chartH / ySteps);
    return \`<text x="\${padL-5}" y="\${y+3}" fill="#8b949e" font-size="9" text-anchor="end">\${f$(v)}</text>
      <line x1="\${padL}" y1="\${y}" x2="\${W-padR}" y2="\${y}" stroke="#30363d" stroke-width="1" opacity="0.3"/>
    \`;
  }).join('');

  const agentLines = lines.map(l =>
    \`<polyline points="\${l.pts}" fill="none" stroke="\${l.color}" stroke-width="1.5" opacity="0.7"><title>\${esc(l.name)}</title></polyline>\`
  ).join('');

  const legend = lines.map((l,i) =>
    \`<g transform="translate(\${10 + (i%3)*90}, \${H + 5 + Math.floor(i/3)*14})">
      <circle cx="5" cy="5" r="3" fill="\${l.color}"/>
      <text x="12" y="8" fill="#e6edf3" font-size="9">\${esc(l.emoji)} \${esc(l.name.slice(0,8))}</text>
    </g>\`
  ).join('');

  return \`<svg width="\${W}" height="\${H+30}" style="display:block">
    \${yLabels}
    \${agentLines}
    <polyline points="\${totalPts}" fill="none" stroke="#e6edf3" stroke-width="2" opacity="0.9"><title>Total</title></polyline>
    \${xLabels}
    \${legend}
  </svg>\`;
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
    const dotColor = ageMs < 900000 ? '#3fb950' : ageMs < 3600000 ? '#e3b341' : '#30363d'; // 15min green, 1hr yellow, else grey
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
  const agents = DATA.agents || [];
  const daily  = DATA.dailySummary || [];

  const totalSessionCost = agents.reduce((s,a) => s + (a.totalCost||0), 0);
  const totalHbs = agents.reduce((s,a) => s + (a.heartbeats?.length||0), 0);

  const trendData = DATA.trendData || [];
  const trendChart = trendData.length ? svgTrendChart(trendData, agents) : '';

  const rows = agents.map(a => {
    const hbs = a.heartbeats?.length || 0;
    const avg = hbs ? a.totalCost / hbs : 0;
    const errBadge = a.totalErrors ? \`<span class="err-count">⚠\${a.totalErrors}</span>\` : '';
    return \`<tr onclick="select('\${a.id}')">
      <td><div class="agent-cell">\${a.emoji} \${a.name} \${errBadge}</div></td>
      <td class="r">\${hbs}</td>
      <td class="r g">\${f$(avg)}</td>
      <td class="r g">\${f$(a.totalCost)}</td>
      <td class="m">\${fAgo(a.lastTime)}</td>
    </tr>\`;
  }).join('');

  return \`
    <div class="section-title">7-day cost trend</div>
    <div style="margin-bottom:20px;overflow-x:auto">\${trendChart}</div>
    <div class="section-title">All agents</div>
    <table class="cross-agent-tbl">
      <thead>
        <tr>
          <th>Agent</th>
          <th class="r">Heartbeats</th>
          <th class="r">Avg $/hb</th>
          <th class="r">Session cost</th>
          <th>Last run</th>
        </tr>
      </thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

// ── Agent view ────────────────────────────────────────────────────────────────
function renderAgent(a) {
  document.getElementById('agent-title').textContent = a.emoji+' '+a.name;

  const mEl = document.getElementById('pill-model');
  mEl.textContent = fModel(a.model);
  mEl.style.display = a.model ? '' : 'none';

  const pct    = a.contextTokens ? Math.round(a.totalTokens/a.contextTokens*100) : 0;
  const pctCls = pct>80?'pct-high':pct>50?'pct-med':'pct-low';
  const cEl = document.getElementById('pill-ctx');
  cEl.textContent = fN(a.totalTokens)+' / '+fN(a.contextTokens)+' ctx';
  cEl.className   = 'pill '+pctCls;
  cEl.style.display = '';

  const wEl = document.getElementById('ctx-wrap');
  wEl.style.display = '';
  document.getElementById('ctx-label').textContent = pct+'% context used';
  document.getElementById('ctx-fill').style.width  = Math.min(pct,100)+'%';

  const el = document.getElementById('content');
  if (!a.heartbeats?.length) {
    el.innerHTML = '<div class="empty">No heartbeats recorded yet</div>';
    return;
  }

  const hbs   = a.heartbeats;
  const costs = hbs.slice().reverse().map(h=>h.totalCost);
  const ctxs  = hbs.slice().reverse().map(h=>h.finalContext);

  const cachePct = Math.round((a.avgCacheHit || 0) * 100);

  el.innerHTML = \`
    <div id="overview">
      <div class="stat-box"><div class="stat-label">Session cost</div><div class="stat-val green">\${f$(a.totalCost)}</div></div>
      <div class="stat-box"><div class="stat-label">Heartbeats</div><div class="stat-val blue">\${hbs.length}</div></div>
      <div class="stat-box"><div class="stat-label">Avg cost / hb</div><div class="stat-val orange">\${f$(a.totalCost/hbs.length)}</div></div>
      <div class="stat-box"><div class="stat-label">Context</div><div class="stat-val purple">\${pct}%</div></div>
      <div class="stat-box"><div class="stat-label">Cache hit rate</div><div class="stat-val \${cachePct>70?'green':cachePct>50?'blue':'orange'}">\${cachePct}%</div></div>
    </div>
    <div class="compare-bar">
      <span class="compare-label">Compare:</span>
      <span class="compare-chip \${compareMode&&compareHbs.length>=1?'selected':''}">\${compareHbs[0]!==undefined?'#'+(hbs.length-compareHbs[0]):'Select 1st'}</span>
      <span class="m">vs</span>
      <span class="compare-chip \${compareMode&&compareHbs.length>=2?'selected':''}">\${compareHbs[1]!==undefined?'#'+(hbs.length-compareHbs[1]):'Select 2nd'}</span>
      <button class="compare-btn" onclick="toggleCompareMode()">\${compareMode?'Exit':'Enter'} compare mode</button>
      \${compareHbs.length===2?\`<button class="compare-btn" onclick="clearCompare()">Clear</button>\`:''}
    </div>
    \${compareHbs.length===2?renderComparison(hbs[compareHbs[0]],hbs[compareHbs[1]]):''}
    <div class="chart-row">
      <div class="chart-box">
        <div class="section-title">Cost per heartbeat</div>
        <div class="spark-wrap">\${svgBars(costs,52,'#3fb950',(v,i)=>'#'+(i+1)+' '+f$(v))}</div>
      </div>
      <div class="chart-box">
        <div class="section-title">Context growth over heartbeats</div>
        <div class="spark-wrap">\${svgLine(ctxs,52,'#bc8cff')}</div>
      </div>
    </div>
    \${hbs.map((hb,i)=>heartbeatRow(hb,i,hbs.length)).join('')}
  \`;
}

// ── Heartbeat row ──────────────────────────────────────────────────────────────
function heartbeatRow(hb, i, total) {
  const isOpen = openHbIdx===i;
  const errBadge = hb.errorCount ? \`<span class="err-count">⚠\${hb.errorCount}</span>\` : '';
  const browserBadge = Object.keys(hb.browserBreakdown||{}).length
    ? \`<span class="hb-browser">\${Object.entries(hb.browserBreakdown).map(([k,v])=>k+'×'+v).join(' ')}</span>\`
    : '';

  const cachePct = Math.round((hb.cacheHitRate || 0) * 100);
  const cacheCls = cachePct > 70 ? 'cache-good' : cachePct > 50 ? 'cache-ok' : 'cache-low';
  const cacheBadge = cachePct > 0 ? \`<span class="hb-cache \${cacheCls}">Cache \${cachePct}%</span>\` : '';

  const compareSelected = compareHbs.includes(i);
  const hbCls = compareSelected ? 'style="background:var(--blue)11"' : '';

  return \`<div class="hb" id="hb\${i}" \${hbCls}>
    <div class="hb-head \${isOpen?'open':''}" onclick="toggleHb(\${i})" \${hbCls}>
      <span class="hb-num">#\${total-i}</span>
      <span class="hb-time">\${fT(hb.startTime)}</span>
      <span class="hb-cost">\${f$(hb.totalCost)}</span>
      <span class="hb-ctx">ctx \${fN(hb.finalContext)}</span>
      <span class="hb-dur">\${fD(hb.durationMs)}</span>
      <span class="hb-steps">\${hb.steps?.length||0} steps</span>
      \${browserBadge}
      \${cacheBadge}
      \${errBadge}
      <span class="hb-sum">\${esc(hb.summary||hb.trigger||'')}</span>
      <span class="hb-arrow">\${isOpen?'▲':'▼'}</span>
    </div>
    <div class="hb-body \${isOpen?'open':''}">\${isOpen?heartbeatBody(hb,i):''}</div>
  </div>\`;
}

// ── Heartbeat body ──────────────────────────────────────────────────────────────
function heartbeatBody(hb, hbIdx) {
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
    <div class="chart-row" style="margin-bottom:10px">
      <div class="chart-box">
        <div class="section-title">Cost per step</div>
        \${svgBars(costs,44,'#3fb950',(v,i)=>'step '+(i+1)+' '+f$(v))}
      </div>
      <div class="chart-box">
        <div class="section-title">Context growth</div>
        \${svgLine(ctxs,44,'#bc8cff')}
      </div>
      <div class="chart-box" style="min-width:160px">
        <div class="section-title">Cost breakdown</div>
        <table class="tbl" style="font-size:10px">
          <tr><td class="m">Input</td><td class="r g">\${f$(totIn)}</td></tr>
          <tr><td class="m">Output</td><td class="r g">\${f$(totOut)}</td></tr>
          <tr><td class="m">Cache read</td><td class="r g">\${f$(totCR)}</td></tr>
          <tr><td class="m">Cache write</td><td class="r g">\${f$(totCW)}</td></tr>
          <tr><td class="m">Tool results</td><td class="r b">\${fSz(totRes)}</td></tr>
          <tr style="border-top:1px solid var(--border)">
            <td class="m" style="padding-top:4px"><b>Total</b></td>
            <td class="r g" style="padding-top:4px"><b>\${f$(hb.totalCost)}</b></td>
          </tr>
        </table>
      </div>
    </div>
    \${toolFreqBar(steps)}
    <table class="tbl">
      <thead>
        <tr>
          <th>#</th>
          <th>Time</th>
          <th>Dur</th>
          <th>Action</th>
          <th class="r">Result</th>
          <th class="r">Out tok</th>
          <th class="r">Cache R</th>
          <th class="r">Ctx</th>
          <th class="r">Cost</th>
          <th>Thinking</th>
        </tr>
      </thead>
      <tbody id="steps-\${hbIdx}">
        \${steps.map((s,si) => stepRows(s, si, hbIdx, maxStep, avgCost, open)).join('')}
      </tbody>
    </table>
  \`;
}

// ── Step rows (main row + optional detail row) ────────────────────────────────
function stepRows(s, si, hbIdx, maxStep, avgCost, open) {
  const isOpen = open.has(si);
  const heat   = s.cost > avgCost*3 ? 'step-hot' : s.cost > avgCost*1.5 ? 'step-warm' : '';
  const expanded = isOpen ? 'expanded' : '';

  let actionCell = '—';
  if (s.toolCalls?.length) {
    const descs = s.toolCalls.map(tc => {
      const d = esc(describeCall(tc.name, tc.args));
      const cls = toolChipClass(tc.name);
      return \`<span class="tf-chip \${cls}" style="font-size:9px;padding:0 4px">\${d}</span>\`;
    });
    actionCell = descs.slice(0,3).join(' ') + (descs.length>3 ? \` <span class="m">+\${descs.length-3}</span>\` : '');
  }

  const mainRow = \`<tr class="step-row \${heat} \${expanded}" onclick="toggleStep(\${hbIdx},\${si})">
    <td class="m">\${si+1}</td>
    <td class="m">\${fT(s.time)}</td>
    <td class="m">\${fD(s.durationMs)}</td>
    <td>\${actionCell}</td>
    <td class="r b">\${fSz(s.resultTotalSize)}</td>
    <td class="r o">\${fN(s.output)}</td>
    <td class="r p">\${fN(s.cacheRead)}</td>
    <td class="r p">\${fN(s.totalTokens)}</td>
    <td class="r g">
      <span class="cost-bar" style="width:\${Math.round((s.cost||0)/maxStep*36)}px"></span>\${f$(s.cost)}
    </td>
    <td class="m" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px">\${esc((s.text||'').slice(0,80))}</td>
  </tr>\`;

  if (!isOpen) return mainRow;

  return mainRow + \`<tr class="step-detail"><td colspan="10">\${stepDetail(s)}</td></tr>\`;
}

// ── Step detail panel ─────────────────────────────────────────────────────────
function stepDetail(s) {
  const calls = s.toolCalls || [];
  const results = s.toolResults || [];

  if (!calls.length && !results.length) {
    return \`<div class="step-detail-inner"><div class="m" style="font-size:10px;padding:4px">No tool calls — model reasoning step</div></div>\`;
  }

  const resultByCallId = {};
  const unmatchedResults = [];
  for (const r of results) {
    if (r.callId && calls.find(c => c.id === r.callId)) {
      resultByCallId[r.callId] = r;
    } else {
      unmatchedResults.push(r);
    }
  }

  const cards = calls.map((tc, i) => {
    const result = resultByCallId[tc.id] || unmatchedResults.shift();
    return detailCard(tc, result);
  });

  for (const r of unmatchedResults) {
    cards.push(detailCard(null, r));
  }

  return \`<div class="step-detail-inner">\${cards.join('')}</div>\`;
}

function detailCard(tc, result) {
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
    const errBadge = result.isError ? '<span class="err-badge">ERROR</span>' : '';
    resultHtml = \`<div class="detail-result">
      <div class="detail-result-head">
        <span class="m">result</span>
        <span class="b">\${fSz(result.size)}</span>
        \${errBadge}
      </div>
      <div class="detail-result-body \${result.isError?'r2':''}">\${esc(result.preview)}\${result.size>(result.preview||'').length?'<span class="m"> …('+fSz(result.size)+' total)</span>':''}</div>
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

// ── Interactions ──────────────────────────────────────────────────────────────
function select(id) {
  selectedId = id;
  openHbIdx  = null;
  compareMode = false;
  compareHbs = [];
  renderSidebar();
  if (!DATA) return;
  const a = DATA.agents.find(a=>a.id===id);
  if (a) renderAgent(a);
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
  const steps   = hb.steps||[];
  const costs   = steps.map(s=>s.cost||0);
  const avgCost = costs.reduce((a,b)=>a+b,0)/costs.length;
  const maxStep = Math.max(...costs,1e-9);
  const tbody = document.getElementById('steps-'+hbIdx);
  if (tbody) tbody.innerHTML = steps.map((s,si)=>stepRows(s,si,hbIdx,maxStep,avgCost,set)).join('');
}

// ── Data fetching ──────────────────────────────────────────────────────────────
async function fetchData() {
  const el = document.getElementById('refresh');
  el.className = 'spin'; el.textContent = '⟳ loading…';
  try {
    const r = await fetch('/api/data');
    if (!r.ok) throw new Error('HTTP '+r.status);
    DATA = await r.json();
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

    if (selectedId) {
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
setInterval(fetchData, 30000);
</script>
</body>
</html>`;
