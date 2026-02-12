# OpenClaw Token Dashboard

**Real-time token usage analytics and cost optimization for OpenClaw multi-agent systems**

An extension for OpenClaw that provides comprehensive visibility into LLM token consumption, costs, and performance across all your agents.

![Dashboard Preview](https://img.shields.io/badge/OpenClaw-Extension-blue)

### Main Dashboard View
<img width="1911" height="524" alt="image" src="https://github.com/user-attachments/assets/48b6a3ce-ddf9-493c-ae3b-c0778629f225" />

*Overview of agent performance with cost and context growth charts. Shows sidebar with all agents, stats cards, and expandable heartbeat rows.*

### Detailed Heartbeat Analysis
<img width="1884" height="716" alt="image" src="https://github.com/user-attachments/assets/d1e6ec2c-8956-4f49-86da-711fce27075f" />

*Expanded heartbeat view showing cost per step, tool usage breakdown, cost breakdown, and detailed step-by-step execution with full tool call/result inspection.*

## Features

- 📊 **Real-time monitoring** - Live agent status, auto-refresh, cross-agent overview
- 💰 **Budget tracking** - Daily/monthly limits with projected costs and alerts
- 📈 **Historical analysis** - 7-day trends, per-heartbeat drill-down, context growth
- ⚡ **Optimization tools** - Cache hit rates, waste detection, actionable hints
- 🔍 **A/B comparison** - Side-by-side heartbeat comparison with delta calculations
- 🎛️ **Collapsible sidebar** - Toggle agent list for more screen space
- 📊 **Rich charts** - Cost, context, and tool usage visualizations
- 🔍 **Step inspection** - Full tool call/result details with expandable views
- 📤 **API access** - Programmatic access to all metrics via REST API

## Installation

### Prerequisites
- **OpenClaw** installed and configured at `~/.openclaw`
- **Node.js** v14+ (already required by OpenClaw)

### Setup

1. **Clone this repository:**
   ```bash
   git clone https://github.com/Tell-Me-Mo/openclaw-token-dashboard.git
   cd openclaw-token-dashboard
   ```

2. **Copy the dashboard to your OpenClaw installation:**
   ```bash
   mkdir -p ~/.openclaw/canvas
   cp token-dash.js ~/.openclaw/canvas/
   cp budget.json ~/.openclaw/canvas/        # Optional: default budget config
   cp dashboard-helper.sh ~/.openclaw/canvas/ # Optional: bash helper functions
   cp API.md ~/.openclaw/canvas/              # Optional: API documentation
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

- **Sidebar Toggle** - Click ☰ button to hide/show the agent sidebar for more screen space
- **Sidebar** - Click any agent to view its details
- **Overview** - Default view showing all agents and 7-day trend
- **Agent View** - Session cost, heartbeats, cache stats, and full drill-down
- **Compare Mode** - Click "Compare" button in header → select 2 heartbeats → view delta
- **API Buttons** - Each heartbeat has 📋 API and ⚠ API buttons to copy URLs for programmatic access

### API Access for Agents

The dashboard provides REST API endpoints that agents can use for self-improvement and optimization:

```bash
# Source helper functions
source ~/.openclaw/canvas/dashboard-helper.sh

# Check if budget allows running
if dashboard_check_budget; then
  echo "Budget OK, running agent..."
else
  echo "Budget exceeded, skipping"
  exit 1
fi

# Get latest heartbeat data
latest=$(dashboard_latest_hb "promo-assistant-reddit")
cost=$(echo $latest | jq -r '.totalCost')
errors=$(echo $latest | jq -r '.errorCount')

# Get only error steps from previous run
errors_only=$(dashboard_latest_errors_only "promo-assistant-reddit")
```

**Available API endpoints:**
- `/api/agents` - List all agents with stats
- `/api/agent/:id` - Get specific agent details
- `/api/latest?agent=X` - Get latest heartbeat
- `/api/heartbeat?agent=X&hb=N` - Get specific heartbeat by index
- `/api/heartbeats?agent=X&errors=true` - Query heartbeats with filters
- `/api/budget` - Get current budget status
- `/api/daily?days=N` - Get daily cost breakdown
- `/api/stats` - Overall system statistics

**Error filtering:**
Add `&errors_only=true` to any heartbeat endpoint to get only steps with errors. Perfect for debugging and self-correction loops.

See [API.md](API.md) and [ERRORS_ONLY_FEATURE.md](ERRORS_ONLY_FEATURE.md) for complete documentation.

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

Contributions welcome! Please open an issue or PR at https://github.com/Tell-Me-Mo/openclaw-token-dashboard

## License

MIT License - see LICENSE file for details

## Acknowledgments

Built for the OpenClaw multi-agent framework. Token optimization insights based on community research from Reddit, Twitter, and HackerNews discussions about LLM cost management.

---

**Need help?** Open an issue or reach out in the OpenClaw community.
