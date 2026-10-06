/** One-time live handoff, bounded receipts, and owner-specific revocation. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, vi, onTestFinished } from 'vitest'
import { ReferenceAssertionRegistry } from '../src/reference-assertions.ts'
import type { ConsumeReferenceAssertions, ReferenceAssertionConsumer, ReferenceAssertionConsumption } from '../src/reference-assertions.ts'
import type { SessionPromptWithReferencesRequest, SessionRequestId } from '../src/types.ts'

async function fixture(capacity = 8) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create('reference-test' as SessionId)
  const agent = { id: session.id, session, ctx, status: 'idle' } as Agent
  ctx.provide('agents', { get: (id: SessionId) => id === session.id ? agent : undefined } as never)
  const registry = new ReferenceAssertionRegistry(ctx, capacity)
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, session, agent, registry }
}

function request(session: Session, id = 'one'): SessionPromptWithReferencesRequest {
  return Object.freeze({ sessionId: session.id, requestId: id as SessionRequestId, mode: 'queue',
    content: Object.freeze([Object.freeze({ type: 'text' as const, text: 'Alpha' })]),
    referenceAssertions: Object.freeze({ text: 'Alpha', referenceSpans: Object.freeze([Object.freeze({ start: 0, end: 5 })]) }),
  })
}

async function stage(
  built: Awaited<ReturnType<typeof fixture>>, payload = request(built.session),
) {
  const message = createUserMessage({ content: [{ type: 'text', text: 'Alpha' }],
    source: { kind: 'user', rpcId: payload.requestId } })
  await built.registry.reserve(built.session, payload, async () => {
    built.registry.stage(built.session, built.agent, payload, message)
    return { accepted: true }
  })
  return message
}

function commit(session: Session, message: UserMessage) {
  return session.append('user/message', message, { surfaceOp: 'append' })
}

it('consumes once during the committed callback and cannot recover after it returns', async () => {
  const built = await fixture()
  const outcomes: ReferenceAssertionConsumption[] = []
  let late: ConsumeReferenceAssertions | undefined
  let published: SessionEvent<'user/message'> | undefined
  built.registry.lease((session, agent, event, consume) => {
    late = consume
    published = event
    outcomes.push(consume(session, agent, event.data, 'one' as SessionRequestId))
    outcomes.push(consume(session, agent, event.data, 'one' as SessionRequestId))
  })
  const message = await stage(built)
  const event = commit(built.session, message)
  expect(published).toBe(event)
  expect(outcomes).toEqual([
    { kind: 'asserted', assertions: request(built.session).referenceAssertions }, { kind: 'already-consumed' },
  ])
  expect(late?.(built.session, built.agent, event.data, 'one' as SessionRequestId)).toEqual({ kind: 'already-consumed' })
  expect(JSON.stringify(event)).not.toContain('referenceSpans')
  expect(Object.isFrozen(outcomes[0])).toBe(false)
  if (outcomes[0]?.kind === 'asserted') expect(Object.isFrozen(outcomes[0].assertions.referenceSpans)).toBe(true)
})

it('unmarked identical content reports absent and creates no batch', async () => {
  const built = await fixture()
  let result: ReferenceAssertionConsumption | undefined
  built.registry.lease((session, agent, event, consume) => {
    result = consume(session, agent, event.data, 'ordinary' as SessionRequestId)
  })
  commit(built.session, createUserMessage({ content: [{ type: 'text', text: 'Alpha' }],
    source: { kind: 'user', rpcId: 'ordinary' as SessionRequestId } }))
  expect(result).toEqual({ kind: 'absent' })
})

it.each(['session', 'agent', 'request', 'message', 'text', 'blocks'] as const)('rejects wrong %s binding without rearming', async (kind) => {
  const built = await fixture()
  const results: ReferenceAssertionConsumption[] = []
  built.registry.lease((session, agent, event, consume) => {
    const wrongMessage = kind === 'message' ? { ...event.data, id: MessageId('wrong-message') } : event.data
    results.push(consume(kind === 'session' ? { ...session } as Session : session,
      kind === 'agent' ? { ...agent } : agent, wrongMessage,
      (kind === 'request' ? 'wrong' : 'one') as SessionRequestId))
    results.push(consume(session, agent, event.data, 'one' as SessionRequestId))
  })
  const message = await stage(built)
  const changed = kind === 'text' ? freezeMessage<UserMessage>({ ...message, content: [{ type: 'text', text: 'Beta' }] })
    : kind === 'blocks' ? freezeMessage<UserMessage>({ ...message, content: [{ type: 'text', text: 'Al' }, { type: 'text', text: 'pha' }] })
      : message
  commit(built.session, changed)
  expect(results).toEqual([{ kind: 'invalid' }, { kind: 'already-consumed' }])
})

it.each(['before-consume', 'after-consume'] as const)('callback failure %s never rearms', async (failure) => {
  const built = await fixture()
  let saved: ConsumeReferenceAssertions | undefined
  built.registry.lease((session, agent, event, consume) => {
    saved = consume
    if (failure === 'after-consume') consume(session, agent, event.data, 'one' as SessionRequestId)
    throw new Error('private downstream text')
  })
  const message = await stage(built)
  const event = commit(built.session, message)
  const second = saved?.(built.session, built.agent, event.data, 'one' as SessionRequestId)
  expect(second?.kind).toBe(failure === 'after-consume' ? 'already-consumed' : 'invalid')
})

it('shares concurrent admission, rejects conflicts, and reuses a lost acknowledgement without staging again', async () => {
  const built = await fixture()
  built.registry.lease(() => {})
  const gate = Promise.withResolvers<undefined>()
  const admit = vi.fn(async () => { await gate.promise; return { accepted: true as const } })
  const payload = request(built.session)
  const first = built.registry.reserve(built.session, payload, admit)
  const concurrent = built.registry.reserve(built.session, payload, admit)
  expect(concurrent).toBe(first)
  expect(() => built.registry.reserve(built.session, { ...payload, mode: 'steer' }, admit)).toThrow('identity-conflict')
  gate.resolve(undefined)
  await first
  expect(built.registry.reserve(built.session, payload, admit)).toBe(first)
  expect(admit).toHaveBeenCalledOnce()
})

it.each(['edit', 'remove'] as const)('queue %s revokes even identical content', async (operation) => {
  const built = await fixture()
  let result: ReferenceAssertionConsumption | undefined
  built.registry.lease((session, agent, event, consume) => { result = consume(session, agent, event.data, 'one' as SessionRequestId) })
  const message = await stage(built)
  if (operation === 'edit') built.registry.revoke(built.agent, message)
  else built.ctx.emit('agent/inbox/discarded', { agent: built.agent, message })
  commit(built.session, message)
  expect(result).toEqual({ kind: 'invalid' })
  expect(() => built.registry.reserve(built.session, request(built.session), async () => ({ accepted: true }))).toThrow('identity-retired')
})

it('queue steer retains the same unconsumed batch through removal notification', async () => {
  const built = await fixture()
  let result: ReferenceAssertionConsumption | undefined
  built.registry.lease((session, agent, event, consume) => { result = consume(session, agent, event.data, 'one' as SessionRequestId) })
  const message = await stage(built)
  built.registry.move(built.agent, message, () => {
    built.ctx.emit('agent/inbox/discarded', { agent: built.agent, message })
    built.ctx.emit('agent/inbox/claimed', { agent: built.agent, message, turn: 1 })
    commit(built.session, message)
  })
  expect(result?.kind).toBe('asserted')
})

it('active cancellation leaves unaffected queued intent available', async () => {
  const built = await fixture()
  const results: ReferenceAssertionConsumption[] = []
  built.registry.lease((session, agent, event, consume) => {
    if (event.data.source.kind === 'user' && 'rpcId' in event.data.source) {
      results.push(consume(session, agent, event.data, event.data.source.rpcId))
    }
  })
  const active = await stage(built)
  const queued = await stage(built, request(built.session, 'queued'))
  built.ctx.emit('agent/inbox/claimed', { agent: built.agent, message: active, turn: 1 })
  built.registry.cancelActive(built.agent)
  commit(built.session, active)
  commit(built.session, queued)
  expect(results.map(result => result.kind)).toEqual(['invalid', 'asserted'])
})

it.each(['turn', 'session', 'agent', 'consumer', 'producer'] as const)('purges on %s lifecycle retirement', async (lifecycle) => {
  const built = await fixture()
  const callback = vi.fn<ReferenceAssertionConsumer>()
  const lease = built.registry.lease(callback)
  const message = await stage(built)
  built.ctx.emit('agent/inbox/claimed', { agent: built.agent, message, turn: 1 })
  if (lifecycle === 'turn') built.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  else if (lifecycle === 'session') built.ctx.emit('session/disposed', built.session)
  else if (lifecycle === 'agent') built.ctx.emit('agent/disposed', { agent: built.agent })
  else if (lifecycle === 'consumer') lease[Symbol.dispose]()
  else await built.ctx.fiber.dispose()
  if (lifecycle !== 'producer') {
    const event = commit(built.session, message)
    const last = callback.mock.calls.at(-1)
    if (last !== undefined) expect(last[3](built.session, built.agent, event.data, 'one' as SessionRequestId).kind).not.toBe('asserted')
  }
})

it('rejects capacity without evicting live intent; terminal receipts remain bounded', async () => {
  const built = await fixture(1)
  built.registry.lease((session, agent, event, consume) => { consume(session, agent, event.data, 'one' as SessionRequestId) })
  const message = await stage(built)
  expect(() => built.registry.reserve(built.session, request(built.session, 'two'), async () => ({ accepted: true }))).toThrow('capacity')
  commit(built.session, message)
  await expect(built.registry.reserve(built.session, request(built.session, 'two'), async () => ({ accepted: true })))
    .resolves.toEqual({ accepted: true })
})

it('consumer disposal during admission prevents late staging', async () => {
  const built = await fixture()
  const lease = built.registry.lease(() => {})
  const gate = Promise.withResolvers<undefined>()
  const payload = request(built.session)
  const message = createUserMessage({ content: [{ type: 'text', text: 'Alpha' }], source: { kind: 'user', rpcId: payload.requestId } })
  const admitted = built.registry.reserve(built.session, payload, async () => {
    await gate.promise
    built.registry.stage(built.session, built.agent, payload, message)
    return { accepted: true }
  })
  lease[Symbol.dispose]()
  gate.resolve(undefined)
  await expect(admitted).rejects.toMatchObject({ code: 'session/reference-rejected', message: 'canceled', details: {} })
})

it.each(['source', 'session'] as const)('published wrong %s reports invalid, never absent', async (mismatch) => {
  const built = await fixture()
  let result: ReferenceAssertionConsumption | undefined
  built.registry.lease((session, agent, event, consume) => {
    result = consume(session, agent, event.data, 'one' as SessionRequestId)
  })
  const message = await stage(built)
  if (mismatch === 'source') commit(built.session, { ...message, source: { kind: 'user', rpcId: 'other' as SessionRequestId } })
  else commit(built.ctx.sessions.create('other-session' as SessionId), message)
  expect(result).toEqual({ kind: 'invalid' })
})

it('allows reentrant consumption while preventing reentrant duplicate admission', async () => {
  const built = await fixture(1)
  let retry: Promise<{ accepted: true }> | undefined
  const payload = request(built.session)
  const admitted = vi.fn(async () => ({ accepted: true as const }))
  built.registry.lease((session, agent, event, consume) => {
    expect(consume(session, agent, event.data, payload.requestId).kind).toBe('asserted')
    retry = built.registry.reserve(session, payload, admitted)
    expect(consume(session, agent, event.data, payload.requestId).kind).toBe('already-consumed')
  })
  const message = await stage(built, payload)
  commit(built.session, message)
  await expect(retry).resolves.toEqual({ accepted: true })
  expect(admitted).not.toHaveBeenCalled()
})

it('contains accidental async consumer failures and refuses consumption after await', async () => {
  const built = await fixture()
  const attempted = Promise.withResolvers<ReferenceAssertionConsumption>()
  built.registry.lease(async (session, agent, event, consume) => {
    await Promise.resolve()
    attempted.resolve(consume(session, agent, event.data, 'one' as SessionRequestId))
    throw new Error('private downstream error')
  })
  commit(built.session, await stage(built))
  await expect(attempted.promise).resolves.toEqual({ kind: 'invalid' })
})

it.each(['private diagnostic', 'canceled'])('remints downstream failures without private details (%s)', async (diagnostic) => {
  const built = await fixture()
  built.registry.lease(() => {})
  await expect(built.registry.reserve(built.session, request(built.session), async () => {
    throw new RemoteError('session/reference-rejected', diagnostic, { privateText: 'Alpha' } as never)
  })).rejects.toMatchObject({
    code: 'session/reference-rejected', message: diagnostic === 'canceled' ? 'canceled' : 'admission-failed', details: {},
  })
})

it('a rejected owning turn purges its batch while manual resend requires a new identity', async () => {
  const built = await fixture()
  const results: ReferenceAssertionConsumption[] = []
  built.registry.lease((session, agent, event, consume) => {
    if (event.data.source.kind === 'user' && 'rpcId' in event.data.source) {
      results.push(consume(session, agent, event.data, event.data.source.rpcId))
    }
  })
  const rejected = await stage(built)
  built.ctx.emit('agent/inbox/claimed', { agent: built.agent, message: rejected, turn: 1 })
  built.session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
  commit(built.session, rejected)
  expect(results).toEqual([{ kind: 'invalid' }])
  expect(() => built.registry.reserve(built.session, request(built.session), async () => ({ accepted: true })))
    .toThrow('identity-retired')
  commit(built.session, await stage(built, request(built.session, 'manual-resend')))
  expect(results.map(result => result.kind)).toEqual(['invalid', 'asserted'])
})

it('a failed downstream admission cannot recover the consumed batch', async () => {
  const built = await fixture()
  const results: ReferenceAssertionConsumption[] = []
  const downstream = vi.fn(() => { throw new Error('downstream admission rejected') })
  built.registry.lease((session, agent, event, consume) => {
    const result = consume(session, agent, event.data, 'one' as SessionRequestId)
    results.push(result)
    if (result.kind === 'asserted') downstream()
  })
  const message = await stage(built)
  commit(built.session, message)
  commit(built.session, message)
  expect(results.map(result => result.kind)).toEqual(['asserted', 'already-consumed'])
  expect(downstream).toHaveBeenCalledOnce()
})
