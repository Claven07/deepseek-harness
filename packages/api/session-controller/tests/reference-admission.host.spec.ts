/** Asserted Remote admission uses final binding and history rather than ordinary-prompt fallback. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import { expect, it, vi, onTestFinished } from 'vitest'
import { createSessionTestController } from './test-remote.ts'
import { ApiSessionAgentController } from '../src/agent.ts'
import type { SessionPromptWithReferencesRequest, SessionRequestId } from '../src/types.ts'
import type { ReferenceAssertionConsumption } from '../src/reference-assertions.ts'
import { ReferenceAssertionRegistry } from '../src/reference-assertions.ts'

async function fixture(gateway?: Pick<Context['typertGateway'], 'registerAssertedRequestPreflight'>) {
  const ctx = new Context()
  if (gateway !== undefined) ctx.provide('typertGateway', gateway as Context['typertGateway'])
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create('asserted-admission' as SessionId)
  const followup = vi.fn((message: UserMessage) => {
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    session.append('user/message', message, { surfaceOp: 'append' })
  })
  const stub: Pick<Agent, 'id' | 'session' | 'ctx' | 'status' | 'inbox' | 'followup' | 'steer' | 'cancel'> = {
    id: session.id, session, ctx, status: 'idle', inbox: createInboxStub(), followup, steer: followup, cancel: vi.fn(),
  }
  const agent = stub as Agent
  await ctx.agents.register(agent)
  const controller = createSessionTestController(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  const results: ReferenceAssertionConsumption[] = []
  const lease = controller.leaseReferenceAssertions((actualSession, actualAgent, event, consume) => {
    if (event.data.source.kind === 'user' && 'rpcId' in event.data.source) {
      results.push(consume(actualSession, actualAgent, event.data, event.data.source.rpcId))
    }
  })
  const payload: SessionPromptWithReferencesRequest = {
    sessionId: session.id, requestId: 'admission-one' as SessionRequestId, mode: 'queue',
    content: [{ type: 'text', text: 'Alpha' }], referenceAssertions: { text: 'Alpha', referenceSpans: [{ start: 0, end: 5 }] },
  }
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, session, controller, payload, followup, results, lease }
}

it('registers and disposes the configured bounded preflight with the Gateway', async () => {
  let preflight: ((request: unknown) => void) | undefined
  const disposePreflight = vi.fn()
  const register = vi.fn((validate: (request: unknown) => void) => {
    preflight = validate
    return disposePreflight
  })
  const built = await fixture({ registerAssertedRequestPreflight: register })
  expect(register).toHaveBeenCalledOnce()
  expect(preflight).toBeTypeOf('function')
  const oversized = new Array(built.ctx.attachments.imageLimits.maxImagesPerMessage + 2)
  expect(() => preflight?.({ ...built.payload, content: oversized }))
    .toThrow(expect.objectContaining({ code: 'session/reference-rejected' }))
  await built.ctx.fiber.dispose()
  expect(disposePreflight).toHaveBeenCalledOnce()
})

it('stages before synchronous committed-message callbacks and shares immutable concurrent requests', async () => {
  const built = await fixture()
  const request = Object.freeze({ ...built.payload, referenceAssertions: Object.freeze(built.payload.referenceAssertions) })
  const signal = new AbortController().signal
  const first = built.controller.promptWithReferences(request, signal)
  const second = built.controller.promptWithReferences(request, signal)
  expect(second).toBe(first)
  await expect(first).resolves.toEqual({ accepted: true })
  expect(built.followup).toHaveBeenCalledOnce()
  expect(built.results).toEqual([{ kind: 'asserted', assertions: request.referenceAssertions }])
  await built.controller.promptWithReferences(request, signal)
  expect(built.followup).toHaveBeenCalledOnce()
  expect(JSON.stringify(built.followup.mock.calls)).not.toContain('referenceAssertions')
})

it.each(['wrong-text', 'multiple-text', 'text-not-last', 'empty-spans', 'event-limit'] as const)('rejects %s before enqueue', async (failure) => {
  const built = await fixture()
  const request = failure === 'wrong-text' ? { ...built.payload, referenceAssertions: { ...built.payload.referenceAssertions, text: 'Beta' } }
    : failure === 'multiple-text' ? { ...built.payload, content: [{ type: 'text' as const, text: 'Al' }, { type: 'text' as const, text: 'pha' }] }
      : failure === 'text-not-last' ? { ...built.payload, content: [...built.payload.content, { type: 'image' as const, mediaType: 'image/png' as const, data: 'ignored' }] }
        : failure === 'empty-spans' ? { ...built.payload, referenceAssertions: { text: 'Alpha', referenceSpans: [] } }
          : { ...built.payload, content: [{ type: 'text' as const, text: 'A'.repeat(1_201) }],
            referenceAssertions: { text: 'A'.repeat(1_201), referenceSpans: [{ start: 0, end: 1_201 }] } }
  expect(() => built.controller.promptWithReferences(request, new AbortController().signal))
    .toThrowError(expect.objectContaining({ code: 'session/reference-rejected', details: {} }))
  expect(built.followup).not.toHaveBeenCalled()
})

it('rejects excess attachment count before cloning or fingerprinting the request', async () => {
  const built = await fixture()
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const clone = vi.spyOn(globalThis, 'structuredClone')
  onTestFinished(() => { reserve.mockRestore(); clone.mockRestore() })
  const content = [
    ...Array.from({ length: built.ctx.attachments.imageLimits.maxImagesPerMessage + 1 }, () => ({
      type: 'file' as const, receiptId: 'r'.repeat(36) as FileUploadReceiptId,
    })),
    { type: 'text' as const, text: 'Alpha' },
  ]
  expect(() => built.controller.promptWithReferences({ ...built.payload, content }, new AbortController().signal))
    .toThrowError(expect.objectContaining({ code: 'session/reference-rejected' }))
  expect(clone).not.toHaveBeenCalled()
  expect(reserve).not.toHaveBeenCalled()
})

it('rejects a per-image byte excess before cloning or fingerprinting', async () => {
  const built = await fixture()
  Object.defineProperty(built.ctx.attachments, 'imageLimits', {
    configurable: true,
    value: { ...built.ctx.attachments.imageLimits, maxImageBytes: 3, maxImagesPerMessage: 2, maxMessageImageBytes: 6 },
  })
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const clone = vi.spyOn(globalThis, 'structuredClone')
  onTestFinished(() => { reserve.mockRestore(); clone.mockRestore() })
  const content = [
    { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAAAA==' },
    { type: 'text' as const, text: 'Alpha' },
  ]
  expect(() => built.controller.promptWithReferences({ ...built.payload, content }, new AbortController().signal))
    .toThrowError(expect.objectContaining({ code: 'session/reference-rejected' }))
  expect(clone).not.toHaveBeenCalled()
  expect(reserve).not.toHaveBeenCalled()
})

it('rejects attachment metadata beyond its stored display-name bound before fingerprinting', async () => {
  const built = await fixture()
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const clone = vi.spyOn(globalThis, 'structuredClone')
  onTestFinished(() => { reserve.mockRestore(); clone.mockRestore() })
  const content = [
    { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA', name: 'n'.repeat(256) },
    { type: 'text' as const, text: 'Alpha' },
  ]
  expect(() => built.controller.promptWithReferences({ ...built.payload, content }, new AbortController().signal))
    .toThrowError(expect.objectContaining({ code: 'session/reference-rejected' }))
  expect(clone).not.toHaveBeenCalled()
  expect(reserve).not.toHaveBeenCalled()
})

it('rejects aggregate byte excess before cloning or fingerprinting', async () => {
  const built = await fixture()
  Object.defineProperty(built.ctx.attachments, 'imageLimits', {
    configurable: true,
    value: { ...built.ctx.attachments.imageLimits, maxImageBytes: 4, maxImagesPerMessage: 2, maxMessageImageBytes: 6 },
  })
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const clone = vi.spyOn(globalThis, 'structuredClone')
  onTestFinished(() => { reserve.mockRestore(); clone.mockRestore() })
  const content = [
    { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAAAA==' },
    { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAAAA==' },
    { type: 'text' as const, text: 'Alpha' },
  ]
  expect(() => built.controller.promptWithReferences({ ...built.payload, content }, new AbortController().signal))
    .toThrowError(expect.objectContaining({ code: 'session/reference-rejected' }))
  expect(clone).not.toHaveBeenCalled()
  expect(reserve).not.toHaveBeenCalled()
})

it('bounds excess sparse content without visiting its entries', async () => {
  const built = await fixture()
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
    throw new Error('unexpected full request clone')
  })
  onTestFinished(() => { reserve.mockRestore(); clone.mockRestore() })
  const content = new Array<SessionPromptWithReferencesRequest['content'][number]>(0xffff_ffff)
  expect(() => built.controller.promptWithReferences({ ...built.payload, content }, new AbortController().signal))
    .toThrowError(expect.objectContaining({ code: 'session/reference-rejected' }))
  expect(clone).not.toHaveBeenCalled()
  expect(reserve).not.toHaveBeenCalled()
})

it('fails closed on nested malformed attachment data without traversing or cloning it', async () => {
  const built = await fixture()
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const clone = vi.spyOn(globalThis, 'structuredClone')
  onTestFinished(() => { reserve.mockRestore(); clone.mockRestore() })
  const data = { nested: new Array(0xffff_ffff) }
  const content = [
    { type: 'image', mediaType: 'image/png', data },
    { type: 'text', text: 'Alpha' },
  ]
  expect(() => built.controller.promptWithReferences({ ...built.payload, content } as never, new AbortController().signal))
    .toThrowError(expect.objectContaining({ code: 'session/reference-rejected' }))
  expect(clone).not.toHaveBeenCalled()
  expect(reserve).not.toHaveBeenCalled()
})

it('allows configured image and attachment count boundaries through fingerprint admission', async () => {
  const built = await fixture()
  Object.defineProperty(built.ctx.attachments, 'imageLimits', {
    configurable: true,
    value: { ...built.ctx.attachments.imageLimits, maxImageBytes: 3, maxImagesPerMessage: 1, maxMessageImageBytes: 3 },
  })
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const clone = vi.spyOn(globalThis, 'structuredClone')
  onTestFinished(() => { reserve.mockRestore(); clone.mockRestore() })
  const request = { ...built.payload, content: [
    { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA', name: 'n'.repeat(255) },
    { type: 'text' as const, text: 'Alpha' },
  ] }
  await expect(built.controller.promptWithReferences(request, new AbortController().signal)).rejects.toMatchObject({
    code: 'session/reference-rejected',
  })
  expect(clone).not.toHaveBeenCalled()
  expect(reserve).toHaveBeenCalledOnce()
})

it('allows the configured total attachment count through fingerprint admission', async () => {
  const built = await fixture()
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const clone = vi.spyOn(globalThis, 'structuredClone')
  onTestFinished(() => { reserve.mockRestore(); clone.mockRestore() })
  const content = [
    ...Array.from({ length: built.ctx.attachments.imageLimits.maxImagesPerMessage }, () => ({
      type: 'file' as const, receiptId: 'r'.repeat(36) as FileUploadReceiptId,
    })),
    { type: 'text' as const, text: 'Alpha' },
  ]
  await expect(built.controller.promptWithReferences({ ...built.payload, content }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'session/reference-rejected' })
  expect(clone).not.toHaveBeenCalled()
  expect(reserve).toHaveBeenCalledOnce()
})

it.each(['committed', 'removed-inbox'] as const)('does not recreate assertions from %s acceptance history', async (history) => {
  const built = await fixture()
  const old = createUserMessage({ content: [{ type: 'text', text: 'Alpha' }], source: { kind: 'user', rpcId: built.payload.requestId } })
  if (history === 'committed') built.session.append('user/message', old, { surfaceOp: 'append' })
  else {
    built.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [old] })
    built.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
  }
  await expect(built.controller.promptWithReferences(built.payload, new AbortController().signal)).rejects.toMatchObject({ message: 'identity-history' })
  expect(built.followup).not.toHaveBeenCalled()
})

it('cancel before enqueue releases intent, while cancel after enqueue does not withdraw the message', async () => {
  const built = await fixture()
  const abort = new AbortController()
  abort.abort()
  expect(() => built.controller.promptWithReferences(built.payload, abort.signal)).toThrow()
  const later = new AbortController()
  await built.controller.promptWithReferences(built.payload, later.signal)
  later.abort()
  expect(built.followup).toHaveBeenCalledOnce()
  expect(built.results[0]?.kind).toBe('asserted')
})

it.each(['cancel', 'consumer', 'producer', 'agent'] as const)('settles %s disposal while attachment admission is in flight', async (reason) => {
  const built = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof built.ctx.attachments.admitPromptContent>>>()
  const admit = vi.spyOn(built.ctx.attachments, 'admitPromptContent').mockImplementation(() => {
    entered.resolve(undefined)
    return pending.promise
  })
  const abort = new AbortController()
  const attempt = built.controller.promptWithReferences(built.payload, abort.signal)
  const rejected = expect(attempt).rejects.toMatchObject({ code: 'session/reference-rejected', details: {} })
  await entered.promise
  if (reason === 'cancel') abort.abort(new Error('private abort reason'))
  else if (reason === 'consumer') built.lease[Symbol.dispose]()
  else if (reason === 'agent') built.ctx.emit('agent/disposed', { agent: built.ctx.agents.get(built.session.id)! })
  else await built.ctx.fiber.dispose()
  await rejected
  expect(built.followup).not.toHaveBeenCalled()
  pending.resolve([{ type: 'text', text: 'Alpha' }])
  await pending.promise
  admit.mockRestore()
})

it('cancels queued image admission immediately without executing its callback or blocking later work', async () => {
  const built = await fixture()
  const agents = new ApiSessionAgentController(built.ctx)
  const agent = built.ctx.agents.get(built.session.id)!
  const pending = Promise.withResolvers<undefined>()
  const prior = agents.serializeImageAdmission(agent, () => pending.promise)
  const canceled = vi.fn(async () => 1)
  for (let index = 0; index < 8; index++) {
    const abort = new AbortController()
    const queued = agents.serializeReferenceImageAdmission(agent, canceled, abort.signal)
    const rejected = expect(queued).rejects.toMatchObject({ message: 'canceled', details: {} })
    abort.abort(new Error('private cancellation reason'))
    await rejected
  }
  expect(canceled).not.toHaveBeenCalled()
  const next = agents.serializeImageAdmission(agent, async () => 2)
  pending.resolve(undefined)
  await prior
  await expect(next).resolves.toBe(2)
  expect(canceled).not.toHaveBeenCalled()
})

it.each(['restore', 'fork'] as const)('never recreates intent from %s seed events', async (kind) => {
  const built = await fixture()
  const old = createUserMessage({ content: [{ type: 'text', text: 'Alpha' }],
    source: { kind: 'user', rpcId: built.payload.requestId } })
  const event = built.session.append('user/message', old, { surfaceOp: 'append' })
  const calls = built.results.length
  const seeded = built.ctx.sessions.create(`seeded-${kind}` as SessionId, {
    seed: [event], ...(kind === 'fork' ? {
      meta: { isSeeded: true, parentSession: built.session.id }, inheritedEventCount: SessionLogOffset(1),
    } : {}),
  })
  const owner = built.ctx.agents.get(built.session.id)!
  await built.ctx.agents.register({ ...owner, id: seeded.id, session: seeded })
  expect(built.results).toHaveLength(calls)
  await expect(built.controller.promptWithReferences({ ...built.payload, sessionId: seeded.id }, new AbortController().signal))
    .rejects.toMatchObject({ message: 'identity-history', details: {} })
  expect(built.followup).not.toHaveBeenCalled()
})

it('rejects ordinary acceptance after the event cut without relying on consumer consumption', async () => {
  const built = await fixture()
  built.lease[Symbol.dispose]()
  const lease = built.controller.leaseReferenceAssertions(() => {})
  onTestFinished(() => { lease[Symbol.dispose]() })
  const observe = built.ctx.sessionQuery.observeSession.bind(built.ctx.sessionQuery)
  let cuts = 0
  const observed = vi.spyOn(built.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
    const cut = await observe(...args)
    if (++cuts === 2) {
      const ordinary = createUserMessage({ content: [{ type: 'text', text: 'Alpha' }],
        source: { kind: 'user', rpcId: built.payload.requestId } })
      built.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [ordinary] })
    }
    return cut
  })
  await expect(built.controller.promptWithReferences(built.payload, new AbortController().signal))
    .rejects.toMatchObject({ code: 'session/reference-rejected', details: {} })
  expect(built.followup).not.toHaveBeenCalled()
  observed.mockRestore()
})

it('ordinary admission preserves content and source without registry admission or observation work', async () => {
  const built = await fixture()
  const reserve = vi.spyOn(ReferenceAssertionRegistry.prototype, 'reserve')
  const stage = vi.spyOn(ReferenceAssertionRegistry.prototype, 'stage')
  const observe = vi.spyOn(built.ctx.sessionQuery, 'observeSession')
  onTestFinished(() => { reserve.mockRestore(); stage.mockRestore(); observe.mockRestore() })
  const content = [{ type: 'text' as const, text: '  Use Alpha instead of Beta  ' }]
  await expect(built.controller.prompt({
    sessionId: built.session.id, requestId: 'ordinary' as SessionRequestId,
    mode: 'queue', content, clientTimeZone: 'UTC',
  }, new AbortController().signal)).resolves.toEqual({ accepted: true })
  expect(built.followup).toHaveBeenCalledOnce()
  const message = built.followup.mock.calls[0]![0]
  expect(message.content).toEqual(content)
  expect(message.source).toEqual({ kind: 'user', rpcId: 'ordinary', clientTimeZone: 'UTC' })
  expect(message).not.toHaveProperty('referenceAssertions')
  expect(built.results).toEqual([{ kind: 'absent' }])
  expect(reserve).not.toHaveBeenCalled()
  expect(stage).not.toHaveBeenCalled()
  expect(observe).not.toHaveBeenCalled()
})

it('hands off caller intent without a grammar or privacy approval', async () => {
  const built = await fixture()
  const text = 'maybe Alpha; api_key=fixture-only'
  const assertions = { text, referenceSpans: [{ start: 6, end: 11 }] }
  await built.controller.promptWithReferences({ ...built.payload,
    content: [{ type: 'text', text }], referenceAssertions: assertions,
  }, new AbortController().signal)
  expect(built.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text }])
  expect(built.results).toEqual([{ kind: 'asserted', assertions }])
  expect(Object.keys(built.results[0]!)).toEqual(['kind', 'assertions'])
  expect(Object.keys(assertions)).toEqual(['text', 'referenceSpans'])
})
