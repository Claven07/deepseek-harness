/**
 * Session-scoped observability metrics service for DeepSeek Harness.
 *
 * Tracks:
 * - Agent metrics: total agent steps, total LLM requests, failed LLM requests.
 * - Tool metrics: total tool calls, successful/failed calls, execution duration, slowest tool.
 * - Session metrics: session start time, total session duration.
 * - Lifecycle: automatic memory cleanup and summary logging on session disposal.
 *
 * @module dsh-plugin-agent-insights
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AgentInsightsConfig, SessionAgentInsights, ToolExecutionMetric } from './types.js'

export type * from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentInsights: AgentInsights
  }
}

export const DEFAULT_MAX_TOOL_HISTORY = 1000

export const Config: z<AgentInsightsConfig> = z.object({
  maxToolHistoryPerSession: z.number().default(DEFAULT_MAX_TOOL_HISTORY),
  logSummaryOnDisposed: z.boolean().default(true),
})

/**
 * AgentInsights service: provides session-scoped observability metrics for DeepSeek Harness.
 */
export class AgentInsights extends Service {
  static Config = Config

  private readonly maxToolHistory: number
  private readonly logSummary: boolean
  private sessionMetrics = new WeakMap<Session, SessionAgentInsights>()
  private globalSlowestTool?: ToolExecutionMetric

  constructor(ctx: Context, config: AgentInsightsConfig = {}) {
    super(ctx, 'agentInsights')
    this.maxToolHistory = config.maxToolHistoryPerSession ?? DEFAULT_MAX_TOOL_HISTORY
    this.logSummary = config.logSummaryOnDisposed ?? true

    // 1. Tool execution metrics: around-dispatch waterfall
    // Wrapped around `next()` to measure precise execution duration and outcome.
    ctx.on('tools/execute', async (exec: ToolDispatchExecution, next): Promise<ToolExecutionResult> => {
      const startTime = performance.now()
      let result: ToolExecutionResult | undefined
      let thrownError: unknown

      try {
        result = await next()
        return result
      } catch (err: unknown) {
        thrownError = err
        throw err
      } finally {
        try {
          const durationMs = performance.now() - startTime
          const isError = thrownError !== undefined || (result !== undefined && result.isError)
          const errorMessage = thrownError instanceof Error
            ? thrownError.message
            : (result !== undefined && result.isError && result.error.message.length > 0)
                ? result.error.message
                : undefined

          const metric: ToolExecutionMetric = {
            callId: String(exec.callId),
            name: exec.name,
            durationMs,
            isError: Boolean(isError),
            ...(errorMessage !== undefined ? { errorMessage } : {}),
          }

          const session = exec.agent?.session
          if (session) {
            this._recordToolExecution(session, metric)
          } else if (this.globalSlowestTool === undefined || metric.durationMs > this.globalSlowestTool.durationMs) {
            this.globalSlowestTool = metric
          }
        } catch (recordErr: unknown) {
          // Observability must NEVER crash the agent or tool dispatch
          ctx.logger.warn(`[agent-insights] Failed to record tool metric for "${exec.name}": ${String(recordErr)}`)
        }
      }
    })

    // 2. Agent LLM request attempt: waterfall hook
    ctx.on('agent/request', async (payload, next) => {
      try {
        const session = payload.agent.session
        if (session) {
          const stats = this._getOrCreateSession(session)
          stats.totalLlmRequests += 1
        }
      } catch (err: unknown) {
        ctx.logger.warn(`[agent-insights] Failed to record agent/request: ${String(err)}`)
      }
      return next()
    })

    // 3. Agent LLM request failure: waterfall hook
    ctx.on('agent/request-error', async (payload, next) => {
      try {
        const session = payload.agent.session
        if (session) {
          const stats = this._getOrCreateSession(session)
          stats.failedLlmRequests += 1
        }
      } catch (err: unknown) {
        ctx.logger.warn(`[agent-insights] Failed to record agent/request-error: ${String(err)}`)
      }
      return next()
    })

    // 4. Session lifecycle & step counting: emit event
    ctx.on('session/event', (session, event) => {
      try {
        const stats = this._getOrCreateSession(session)

        // Count closed steps
        if (event.type === 'step/end') {
          stats.totalSteps += 1
        }

        // Update elapsed session duration
        if (stats.sessionStartTime === 0) {
          stats.sessionStartTime = event.time
        }
        stats.sessionDurationMs = Math.max(0, event.time - stats.sessionStartTime)
      } catch (err: unknown) {
        ctx.logger.warn(`[agent-insights] Failed to process session/event: ${String(err)}`)
      }
    })

    // 5. Session termination & memory cleanup: paired disposal edge
    ctx.on('session/disposed', (session) => {
      try {
        const stats = this.sessionMetrics.get(session)
        if (stats !== undefined) {
          if (this.logSummary) {
            const liveDuration = stats.sessionStartTime > 0
              ? Math.max(stats.sessionDurationMs, Date.now() - stats.sessionStartTime)
              : stats.sessionDurationMs
            const slowest = stats.slowestTool !== undefined
              ? ` (slowest tool: ${stats.slowestTool.name} [${stats.slowestTool.durationMs.toFixed(1)}ms])`
              : ''
            ctx.logger.info(
              `[agent-insights] Session "${stats.sessionId}" completed: ` +
              `${stats.totalSteps} steps, ` +
              `${stats.totalLlmRequests} LLM requests (${stats.failedLlmRequests} failed), ` +
              `${stats.totalToolCalls} tool calls (${stats.failedToolCalls} failed), ` +
              `duration ${(liveDuration / 1000).toFixed(2)}s${slowest}`,
            )
          }
          // Explicit cleanup immediately upon disposal without waiting for GC
          this.sessionMetrics.delete(session)
        }
      } catch (err: unknown) {
        ctx.logger.warn(`[agent-insights] Failed to handle session/disposed: ${String(err)}`)
      }
    })
  }

  /**
   * Retrieve a snapshot of the observability metrics for a specific session.
   * @param session - The session to retrieve metrics for.
   * @returns Cloned metrics snapshot for the session.
   */
  getMetrics(session: Session): SessionAgentInsights {
    const stats = this._getOrCreateSession(session)
    const liveDuration = stats.sessionStartTime > 0
      ? Math.max(stats.sessionDurationMs, Date.now() - stats.sessionStartTime)
      : stats.sessionDurationMs

    return structuredClone({
      ...stats,
      sessionDurationMs: liveDuration,
    })
  }

  /**
   * Retrieve the slowest tool execution for a given session, or across all active sessions.
   * @param session - Optional session to filter by.
   * @returns The slowest tool execution metric, or undefined if no tools have run.
   */
  getSlowestTool(session?: Session): ToolExecutionMetric | undefined {
    if (session !== undefined) {
      return this.sessionMetrics.get(session)?.slowestTool
    }
    return this.globalSlowestTool
  }

  /**
   * Reset metrics for a specific session, or all tracked sessions.
   * @param session - Optional session to reset. If omitted, resets all.
   */
  reset(session?: Session): void {
    if (session !== undefined) {
      this.sessionMetrics.delete(session)
    } else {
      this.sessionMetrics = new WeakMap()
      this.globalSlowestTool = undefined
    }
  }

  private _recordToolExecution(session: Session, metric: ToolExecutionMetric): void {
    const stats = this._getOrCreateSession(session)
    stats.totalToolCalls += 1
    if (metric.isError) {
      stats.failedToolCalls += 1
    } else {
      stats.successfulToolCalls += 1
    }

    stats.toolExecutions.push(metric)
    if (stats.toolExecutions.length > this.maxToolHistory) {
      stats.toolExecutions.shift()
    }

    if (stats.slowestTool === undefined || metric.durationMs > stats.slowestTool.durationMs) {
      stats.slowestTool = metric
    }

    if (this.globalSlowestTool === undefined || metric.durationMs > this.globalSlowestTool.durationMs) {
      this.globalSlowestTool = metric
    }
  }

  private _getOrCreateSession(session: Session): SessionAgentInsights {
    const existing = this.sessionMetrics.get(session)
    if (existing !== undefined) return existing

    const initialTime = session.header?.createdAt ?? Date.now()

    const created: SessionAgentInsights = {
      sessionId: String(session.id),
      sessionStartTime: initialTime,
      sessionDurationMs: 0,
      totalSteps: 0,
      totalLlmRequests: 0,
      failedLlmRequests: 0,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      toolExecutions: [],
      slowestTool: undefined,
    }
    this.sessionMetrics.set(session, created)
    return created
  }
}

export default AgentInsights
