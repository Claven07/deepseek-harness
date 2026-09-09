# dsh-plugin-agent-insights

Session-scoped observability metrics plugin for the DeepSeek Harness ecosystem.

## Overview

`dsh-plugin-agent-insights` provides non-invasive, session-scoped performance and observability tracking for DeepSeek Harness without modifying any core packages. It tracks:

1. **Agent metrics**:
   - Total agent steps closed (`totalSteps`)
   - Total model requests attempted (`totalLlmRequests`)
   - Failed model requests (`failedLlmRequests`)

2. **Tool metrics**:
   - Total tool calls dispatched (`totalToolCalls`)
   - Successful tool calls (`successfulToolCalls`)
   - Failed tool calls (`failedToolCalls`)
   - Execution duration per tool call in milliseconds (`durationMs`)
   - Identification of the slowest tool call (`slowestTool`)

3. **Session metrics**:
   - Session start timestamp (`sessionStartTime`)
   - Total session duration (`sessionDurationMs`)

4. **Lifecycle & Memory Management**:
   - Leak-free session metrics stored via `WeakMap<Session, SessionAgentInsights>`.
   - Authoritative automatic cleanup on `session/disposed`.
   - Formatted summary output to the logger upon session disposal.

## Architecture & Lifecycle Integration

The plugin registers as a Cordis `Service` on `ctx.agentInsights` and hooks into the following official DeepSeek Harness lifecycle points:

- `tools/execute` (around-dispatch waterfall): Measures high-precision tool dispatch duration with `performance.now()` and captures normalized success or failure.
- `agent/request` (waterfall): Observes LLM request attempts and target provider/model before delegating via `next()`.
- `agent/request-error` (waterfall): Observes failed model call attempts before delegating via `next()`.
- `session/event` (emit feed): Listens to durable session events like `step/end` and timestamps to aggregate steps and track session duration.
- `session/disposed` (lifecycle edge): Listens to session termination to log formatted summary metrics and explicitly evict entries from the internal `WeakMap`, guaranteeing zero memory leaks across long-running server processes.

All hook callbacks safely delegate execution and contain internal bookkeeping errors, guaranteeing that the observability layer will never crash the agent loop or fail a tool invocation.

## Installation & Configuration

### In a Cordis configuration (`cordis.yml` / `cordis.patch.yml`)

Add `dsh-plugin-agent-insights` to your profile plugin list:

```yaml
- insert:
    - id: agent-insights
      name: dsh-plugin-agent-insights
      config:
        maxToolHistoryPerSession: 1000
        logSummaryOnDisposed: true
```

When installed via `dsh plugin --profile <name> add dsh-plugin-agent-insights`, the plugin's exported `cordis.patch.yml` bundle layer is automatically linked into the profile.

### Programmatic Usage

Mount the plugin onto your Cordis `Context`:

```typescript
import { Context } from '@deepseek-ai/cordis'
import AgentInsights from 'dsh-plugin-agent-insights'

const ctx = new Context()
await ctx.plugin(AgentInsights, {
  maxToolHistoryPerSession: 500,
  logSummaryOnDisposed: true,
})

// Retrieve metrics for an active session
const metrics = ctx.agentInsights.getMetrics(session)
console.log(`Steps: ${metrics.totalSteps}`)
console.log(`Tool calls: ${metrics.totalToolCalls} (${metrics.successfulToolCalls} ok, ${metrics.failedToolCalls} failed)`)
console.log(`Slowest tool: ${metrics.slowestTool?.name} (${metrics.slowestTool?.durationMs.toFixed(2)}ms)`)
console.log(`Session duration: ${metrics.sessionDurationMs}ms`)
```

## Public API (`ctx.agentInsights`)

- **`getMetrics(session: Session): SessionAgentInsights`**: Returns a deep clone of the metrics collected for the specified session.
- **`getSlowestTool(session?: Session): ToolExecutionMetric | undefined`**: Returns the single slowest tool execution record for a specific session, or across all active sessions.
- **`reset(session?: Session): void`**: Clears recorded metrics for a specific session, or all sessions.

## Testing & Building

```bash
pnpm run build          # Compile TypeScript to lib/
pnpm run typecheck      # Validate types without emitting
pnpm run test           # Run Vitest test suite
pnpm run prepublishOnly # Clean, typecheck, test, and build before publish
```
