# OpenClaw Token Dashboard

**Real-time token usage analytics and cost optimization for OpenClaw multi-agent systems**

An extension for [OpenClaw](https://github.com/yourusername/openclaw) that provides comprehensive visibility into LLM token consumption, costs, and performance across all your agents.

![Dashboard Preview](https://img.shields.io/badge/OpenClaw-Extension-blue)

## Features

### 📊 Real-Time Monitoring
- **Live status indicators** - Green/yellow/grey dots show agent activity at a glance
- **Auto-refresh** - Updates every 30 seconds without manual reload
- **Cross-agent overview** - Compare performance across all 10+ platform agents

### 💰 Budget Management
- **Daily/monthly budget tracking** - Set spending limits and track progress
- **Projected costs** - Forecasts monthly spend based on 7-day average
- **Budget alerts** - Color-coded warnings (green/yellow/red) when approaching limits

### 📈 Historical Analysis
- **7-day cost trend chart** - Multi-line graph showing per-agent breakdown
- **Per-heartbeat drill-down** - Inspect every API call with full token/cost details
- **Context growth tracking** - Visualize how context size evolves over time

### ⚡ Optimization Tools
- **Cache hit rate visualization** - See cache efficiency per-heartbeat and per-agent
- **Token waste detection** - Automatic flags for runaway loops, large results, bloated context, low cache hits
- **Optimization hints** - Actionable suggestions to reduce costs

### 🔍 A/B Comparison
- **Side-by-side session comparison** - Select 2 heartbeats to compare
- **Delta calculations** - See exact improvements in cost, steps, cache%, context
- **Perfect for validating prompt optimizations**

### 📤 Data Export
- **CSV export** - Download full history for spreadsheet analysis
- **JSON export** - Programmatic access for custom analytics
- **Configurable date ranges** - Export last 7, 30, or 90 days

## Installation

### Prerequisites
- **OpenClaw** installed and configured at `~/.openclaw`
- **Node.js** v14+ (already required by OpenClaw)

### Setup

1. **Clone this repository:**
   ```bash
   git clone https://github.com/yourusername/openclaw-token-dashboard.git
   cd openclaw-token-dashboard
   ```

2. **Copy the dashboard to your OpenClaw installation:**
   ```bash
   mkdir -p ~/.openclaw/canvas
   cp token-dash.js ~/.openclaw/canvas/
   cp budget.json ~/.openclaw/canvas/  # Optional: default budget config
   ```

3. **Create budget configuration (optional):**
   ```bash
   cat > ~/.openclaw/canvas/budget.json <<EOF
   {
     "daily": 5.00,
     "monthly": 100.00
   }
   EOF
   ```

## Usage

### Start the Dashboard

```bash
node ~/.openclaw/canvas/token-dash.js
```

Output:
```
  🦞 Token Dashboard → http://localhost:3141
```

### Access the Dashboard

Open your browser to **http://localhost:3141**

### Navigation

- **Sidebar** - Click any agent to view its details
- **Overview** - Default view showing all agents and 7-day trend
- **Agent View** - Session cost, heartbeats, cache stats, and full drill-down
- **Compare Mode** - Click "Enter compare mode" → select 2 heartbeats → view delta

### Export Data

- **CSV**: Click "↓ CSV" button or visit `http://localhost:3141/api/export?format=csv&days=7`
- **JSON**: Click "↓ JSON" button or visit `http://localhost:3141/api/export?format=json&days=7`

Change `days=7` to any number for different date ranges.

## Configuration

### Budget Settings

Edit `~/.openclaw/canvas/budget.json`:

```json
{
  "daily": 10.00,     // Daily spending limit in USD
  "monthly": 200.00   // Monthly spending limit in USD
}
```

The dashboard calculates:
- **Daily progress**: Today's spend vs daily limit
- **Projected monthly**: (7-day average × 30) vs monthly limit

### Port Configuration

To change the default port (3141), edit `token-dash.js`:

```javascript
const PORT = 3141;  // Change to your preferred port
```

## Understanding the Metrics

### Live Status Dots
- 🟢 **Green**: Active (heartbeat < 15min ago)
- 🟡 **Yellow**: Idle (heartbeat < 1hr ago)
- ⚫ **Grey**: Inactive (heartbeat > 1hr ago)

### Cache Hit Rate
- **>70%**: Excellent (green) - prompt caching is working well
- **50-70%**: Good (blue) - normal for varied workloads
- **<50%**: Low (orange) - possible prompt drift or cold starts

### Waste Flags
- **Runaway loop**: >30 steps in one heartbeat
- **Low cache hit**: <50% cache efficiency (>5 steps)
- **Large result**: >10k char tool result (likely unscoped snapshot)
- **Bloated context**: >50k tokens in one step

## How It Works

The dashboard reads OpenClaw's session JSONL files from:
```
~/.openclaw/agents/*/sessions/sessions.json
~/.openclaw/agents/*/sessions/*.jsonl
```

It parses:
- Token usage (`input`, `output`, `cacheRead`, `cacheWrite`)
- Costs per step (from Claude API usage metadata)
- Tool calls (browser, read, write, bash, etc.)
- Errors and timing data

**No external dependencies** - pure Node.js stdlib + embedded HTML/CSS/JS.

## Troubleshooting

### Dashboard won't start
```bash
# Check if port 3141 is already in use
lsof -ti:3141

# Kill existing process
lsof -ti:3141 | xargs kill -9
```

### No data showing
- Ensure OpenClaw agents have run at least once
- Check `~/.openclaw/agents/*/sessions/` contains `.jsonl` files
- Verify `~/.openclaw/openclaw.json` exists with agent definitions

### Budget bar not showing
- Create `~/.openclaw/canvas/budget.json` with valid JSON
- Ensure at least one heartbeat exists for today

## Integration with OpenClaw

This dashboard is designed as a **drop-in extension** for OpenClaw. It:
- ✅ Reads existing OpenClaw session files (no schema changes)
- ✅ Works with all 10 platform agents (Threads, Twitter, Reddit, HN, PH, IH, Dev.to, LinkedIn, Medium, TikTok)
- ✅ Runs independently on a separate port (doesn't interfere with gateway)
- ✅ Auto-discovers agents from `openclaw.json`

### Using with OpenClaw Gateway

If you're running the OpenClaw gateway (`openclaw serve`), the dashboard runs alongside it:
- **Gateway**: `http://localhost:18789`
- **Dashboard**: `http://localhost:3141`

Both can run simultaneously with no conflicts.

## Development

The entire dashboard is a single `token-dash.js` file (~1350 lines):
- **Backend**: Node.js HTTP server + JSONL parser
- **Frontend**: Embedded HTML/CSS/JS (no build step)
- **Rendering**: Vanilla JS with SVG charts

To modify:
1. Edit `token-dash.js`
2. Restart the server
3. Refresh browser (auto-refresh will pick up data changes)

## Performance

- **Session file reads**: ~50ms for 10 agents with 100+ heartbeats each
- **Memory usage**: ~30MB RSS
- **Browser performance**: Handles 1000+ heartbeats smoothly

## Roadmap

Potential future enhancements:
- [ ] Webhook alerts when budget exceeds threshold
- [ ] Per-agent budget allocation
- [ ] Model comparison (Opus vs Sonnet vs Haiku costs)
- [ ] Browser extension for inline metrics
- [ ] Prometheus/Grafana exporter

## Contributing

Contributions welcome! Please open an issue or PR at https://github.com/yourusername/openclaw-token-dashboard

## License

MIT License - see LICENSE file for details

## Acknowledgments

Built for the OpenClaw multi-agent framework. Token optimization insights based on community research from Reddit, Twitter, and HackerNews discussions about LLM cost management.

---

**Need help?** Open an issue or reach out in the OpenClaw community.
