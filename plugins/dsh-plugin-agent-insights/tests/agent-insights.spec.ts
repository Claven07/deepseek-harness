import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentInsights from '../src/index.js'

/** Boot Cordis context with SessionStore, SystemPrompt, ToolRuntime and AgentInsights plugin mounted. */
async function createHarness(config?: { maxToolHistoryPerSession?: number; logSummaryOnDisposed?: boolean }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentInsights, config)
  return ctx
}

describe('dsh-plugin-agent-insights', () => {
  it('tracks tool execution metrics: successful, failed, durations, and slowest tool', async () => {
    const ctx = await createHarness()
    const session = ctx.sessions.create(SessionId('test-session-1'))
    const mockAgent = { session } as unknown as Agent

    // Register a fast successful tool
    ctx.tools.register(defineContentToolFixture({
      name: 'fast_tool',
      description: 'fast',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'fast ok' }]
      },
    }))

    // Register a slower tool
    ctx.tools.register(defineContentToolFixture({
      name: 'slow_tool',
      description: 'slow',
      parameters: {},
      async execute() {
        await new Promise(r => setTimeout(r, 20))
        return [{ type: 'text', text: 'slow ok' }]
      },
    }))

    // Register a tool that throws an error
    ctx.tools.register(defineContentToolFixture({
      name: 'error_tool',
      description: 'error',
      parameters: {},
      async execute() {
        throw new Error('boom')
      },
    }))

    // Execute fast tool
    const fastResult = await ctx.tools.execute({
      callId: ToolCallId('call-1'),
      name: 'fast_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: mockAgent,
    })
    expect(fastResult.isError).toBe(false)

    // Execute slow tool
    const slowResult = await ctx.tools.execute({
      callId: ToolCallId('call-2'),
      name: 'slow_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: mockAgent,
    })
    expect(slowResult.isError).toBe(false)

    // Execute error tool
    const errResult = await ctx.tools.execute({
      callId: ToolCallId('call-3'),
      name: 'error_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: mockAgent,
    })
    expect(errResult.isError).toBe(true)

    const metrics = ctx.agentInsights.getMetrics(session)
    expect(metrics.sessionId).toBe('test-session-1')
    expect(metrics.totalToolCalls).toBe(3)
    expect(metrics.successfulToolCalls).toBe(2)
    expect(metrics.failedToolCalls).toBe(1)
    expect(metrics.toolExecutions).toHaveLength(3)

    // Check individual execution durations
    const slowExec = metrics.toolExecutions.find(e => e.name === 'slow_tool')
    expect(slowExec).toBeDefined()
    expect(slowExec!.durationMs).toBeGreaterThanOrEqual(15)
    expect(slowExec!.isError).toBe(false)

    const errExec = metrics.toolExecutions.find(e => e.name === 'error_tool')
    expect(errExec).toBeDefined()
    expect(errExec!.isError).toBe(true)
    expect(errExec!.errorMessage).toContain('boom')

    // Slowest tool check
    expect(metrics.slowestTool?.name).toBe('slow_tool')
    expect(ctx.agentInsights.getSlowestTool(session)?.name).toBe('slow_tool')
    expect(ctx.agentInsights.getSlowestTool()?.name).toBe('slow_tool')
  })

  it('tracks agent metrics: LLM requests and failed requests via waterfalls', async () => {
    const ctx = await createHarness()
    const session = ctx.sessions.create(SessionId('test-session-2'))
    const mockAgent = { session } as unknown as Agent

    // Trigger agent/request waterfall
    const callConfig = await ctx.waterfall(
      'agent/request',
      { agent: mockAgent, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ provider: 'deepseek', model: 'deepseek-chat' }),
    )
    expect(callConfig.model).toBe('deepseek-chat')

    // Trigger agent/request-error waterfall
    const errorAction = await ctx.waterfall(
      'agent/request-error',
      {
        agent: mockAgent,
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: { code: 'RATE_LIMIT', message: 'too many requests' },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      },
      () => Promise.resolve(undefined),
    )
    expect(errorAction).toBeUndefined()

    const metrics = ctx.agentInsights.getMetrics(session)
    expect(metrics.totalLlmRequests).toBe(1)
    expect(metrics.failedLlmRequests).toBe(1)
  })

  it('tracks session metrics: steps, start time, and duration via session/event', async () => {
    const ctx = await createHarness()
    const session = ctx.sessions.create(SessionId('test-session-3'))

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })

    const metrics = ctx.agentInsights.getMetrics(session)
    expect(metrics.totalSteps).toBe(1)
    expect(metrics.sessionStartTime).toBeGreaterThan(0)
    expect(metrics.sessionDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('isolates metrics across different sessions', async () => {
    const ctx = await createHarness()
    const sessionA = ctx.sessions.create(SessionId('session-a'))
    const sessionB = ctx.sessions.create(SessionId('session-b'))

    const agentA = { session: sessionA } as unknown as Agent
    const agentB = { session: sessionB } as unknown as Agent

    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'hi' }] },
    }))

    // Execute tool on session A only
    await ctx.tools.execute({
      callId: ToolCallId('a-1'),
      name: 'echo',
      arguments: {},
      signal: new AbortController().signal,
      agent: agentA,
    })

    const metricsA = ctx.agentInsights.getMetrics(sessionA)
    const metricsB = ctx.agentInsights.getMetrics(sessionB)

    expect(metricsA.totalToolCalls).toBe(1)
    expect(metricsB.totalToolCalls).toBe(0)
  })

  it('supports reset() and contains errors without interrupting execution', async () => {
    const ctx = await createHarness()
    const session = ctx.sessions.create(SessionId('test-session-4'))
    const mockAgent = { session } as unknown as Agent

    ctx.tools.register(defineContentToolFixture({
      name: 'ok_tool',
      description: 'ok',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'done' }] },
    }))

    await ctx.tools.execute({
      callId: ToolCallId('c-4'),
      name: 'ok_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: mockAgent,
    })

    expect(ctx.agentInsights.getMetrics(session).totalToolCalls).toBe(1)

    // Reset session
    ctx.agentInsights.reset(session)
    expect(ctx.agentInsights.getMetrics(session).totalToolCalls).toBe(0)
  })

  it('cleans up session metrics upon session/disposed without leaking memory', async () => {
    const infoSpy = vi.fn()
    const ctx = await createHarness({ logSummaryOnDisposed: true })
    ctx.logger.info = infoSpy

    const session = ctx.sessions.create(SessionId('test-disposed-session'))
    const mockAgent = { session } as unknown as Agent

    ctx.tools.register(defineContentToolFixture({
      name: 'disp_tool',
      description: 'test',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))

    await ctx.tools.execute({
      callId: ToolCallId('disp-1'),
      name: 'disp_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: mockAgent,
    })

    expect(ctx.agentInsights.getMetrics(session).totalToolCalls).toBe(1)
    expect(ctx.agentInsights.getSlowestTool(session)?.name).toBe('disp_tool')

    // Emit session/disposed
    ctx.emit('session/disposed', session)

    // Verify summary log was written to logger
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('[agent-insights] Session "test-disposed-session" completed:'),
    )

    // Verify session metrics were deleted from internal WeakMap
    expect(ctx.agentInsights.getSlowestTool(session)).toBeUndefined()
    // Querying freshly will return initialized zero metrics
    expect(ctx.agentInsights.getMetrics(session).totalToolCalls).toBe(0)
  })

  it('tracks global slowest tool across multiple sessions without retaining session references', async () => {
    const ctx = await createHarness()
    const session1 = ctx.sessions.create(SessionId('s-1'))
    const session2 = ctx.sessions.create(SessionId('s-2'))

    ctx.tools.register(defineContentToolFixture({
      name: 'quick',
      description: 'quick',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'quick' }] },
    }))

    ctx.tools.register(defineContentToolFixture({
      name: 'heavy',
      description: 'heavy',
      parameters: {},
      async execute() {
        await new Promise(r => setTimeout(r, 15))
        return [{ type: 'text', text: 'heavy' }]
      },
    }))

    await ctx.tools.execute({
      callId: ToolCallId('m-1'),
      name: 'quick',
      arguments: {},
      signal: new AbortController().signal,
      agent: { session: session1 } as unknown as Agent,
    })

    await ctx.tools.execute({
      callId: ToolCallId('m-2'),
      name: 'heavy',
      arguments: {},
      signal: new AbortController().signal,
      agent: { session: session2 } as unknown as Agent,
    })

    // Cross-session query returns 'heavy'
    expect(ctx.agentInsights.getSlowestTool()?.name).toBe('heavy')
    expect(ctx.agentInsights.getSlowestTool(session1)?.name).toBe('quick')
    expect(ctx.agentInsights.getSlowestTool(session2)?.name).toBe('heavy')

    // Disposing session2 cleans up session2's metrics, but global slowest remains recorded
    ctx.emit('session/disposed', session2)
    expect(ctx.agentInsights.getSlowestTool(session2)).toBeUndefined()
    expect(ctx.agentInsights.getSlowestTool()?.name).toBe('heavy')

    // Global reset clears global slowest
    ctx.agentInsights.reset()
    expect(ctx.agentInsights.getSlowestTool()).toBeUndefined()
  })

  it('respects logSummaryOnDisposed: false', async () => {
    const infoSpy = vi.fn()
    const ctx = await createHarness({ logSummaryOnDisposed: false })
    ctx.logger.info = infoSpy

    const session = ctx.sessions.create(SessionId('silent-session'))
    ctx.emit('session/disposed', session)

    expect(infoSpy).not.toHaveBeenCalled()
  })
})
