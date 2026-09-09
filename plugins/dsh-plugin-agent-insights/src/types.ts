/**
 * Pure type definitions for the Agent Insights domain.
 *
 * @module dsh-plugin-agent-insights/types
 */

/** Metric recorded for a single tool dispatch attempt. */
export interface ToolExecutionMetric {
  /** Unique call id of the tool execution. */
  callId: string
  /** Dispatched tool name. */
  name: string
  /** Execution duration in milliseconds. */
  durationMs: number
  /** Whether the tool execution resulted in an error or threw an exception. */
  isError: boolean
  /** Optional error message if the tool failed. */
  errorMessage?: string | undefined
}

/** Observability metrics collected for one specific Session. */
export interface SessionAgentInsights {
  /** Session identifier. */
  sessionId: string
  /** Timestamp (epoch ms) when the session was first observed. */
  sessionStartTime: number
  /** Total elapsed duration of the session in milliseconds. */
  sessionDurationMs: number
  /** Total closed agent steps (from 'step/end' session events). */
  totalSteps: number
  /** Total LLM model requests attempted (from 'agent/request' waterfall). */
  totalLlmRequests: number
  /** Total LLM model request failures (from 'agent/request-error' waterfall). */
  failedLlmRequests: number
  /** Total tool calls dispatched. */
  totalToolCalls: number
  /** Total tool calls that succeeded without error. */
  successfulToolCalls: number
  /** Total tool calls that failed or threw. */
  failedToolCalls: number
  /** Chronological history of tool execution metrics for this session. */
  toolExecutions: ToolExecutionMetric[]
  /** Slowest tool execution observed in this session. */
  slowestTool?: ToolExecutionMetric | undefined
}

/** Configuration options for the AgentInsights plugin. */
export interface AgentInsightsConfig {
  /** Maximum number of tool execution records to retain per session in memory (default: 1000). */
  maxToolHistoryPerSession?: number
  /** Whether to log a formatted session summary to logger upon session disposal (default: true). */
  logSummaryOnDisposed?: boolean
}