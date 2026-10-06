/** Gateway rejects oversized asserted request fields before strict DTO parsing. */
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, bindTypertRemote, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { preflightAssertedRequest } from '../src/commands.ts'
import type { SessionPromptWithReferencesRequest } from '../src/types.ts'

const limits: ImageAttachmentLimits = {
  maxImageBytes: 3,
  maxImagesPerMessage: 3,
  maxMessageImageBytes: 4,
  maxImagePixels: 100,
  maxImageDimension: 100,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mediaType: z.string(), data: z.string(), name: z.string().optional() }),
  z.object({ type: z.literal('file'), receiptId: z.string() }),
])
const assertedRequestSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  mode: z.enum(['queue', 'steer']),
  content: z.array(contentPartSchema),
  clientTimeZone: z.string().optional(),
  referenceAssertions: z.object({
    text: z.string(),
    referenceSpans: z.array(z.object({ start: z.number(), end: z.number() })),
  }),
})
const ordinaryRequestSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  mode: z.enum(['queue', 'steer']),
  content: z.array(contentPartSchema),
  clientTimeZone: z.string().optional(),
})

class AssertedRouteFixture extends Service {
  readonly typertRemote = bindTypertRemote(this, 'sessionController', { namespace: 'session' })
  readonly calls: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'sessionController')
  }

  @Remote('promptWithReferences')
  promptWithReferences(request: SessionPromptWithReferencesRequest): { accepted: true } {
    void request
    this.calls.push('promptWithReferences')
    return { accepted: true }
  }

  @Remote('prompt')
  prompt(request: unknown): { accepted: true } {
    void request
    this.calls.push('prompt')
    return { accepted: true }
  }
}

async function fixture(registerPreflight = true) {
  const ctx = new Context()
  const registryFiber = ctx.plugin(TypertRegistry)
  await registryFiber
  const gatewayFiber = ctx.plugin(TypertGatewayService)
  await gatewayFiber
  const serviceFiber = ctx.plugin(AssertedRouteFixture)
  await serviceFiber
  let parseCount = 0
  const strictCodec: InvocationDescriptor['result'] = {
    mode: 'strict',
    typeSymbol: '@fixture/session#AssertedRequest',
    create: () => ({
      parse(value: unknown) {
        parseCount += 1
        return assertedRequestSchema.parse(value)
      },
    }),
  }
  const resultCodec: InvocationDescriptor['result'] = {
    mode: 'strict',
    typeSymbol: '@fixture/session#PromptResult',
    create: () => z.object({ accepted: z.literal(true) }),
  }
  const ordinaryCodec: InvocationDescriptor['result'] = {
    mode: 'strict',
    typeSymbol: '@fixture/session#OrdinaryRequest',
    create: () => ({
      parse(value: unknown) {
        parseCount += 1
        return ordinaryRequestSchema.parse(value)
      },
    }),
  }
  const removeDescriptors = ctx.typert.register({
    package: '@fixture/session-controller',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      {
        id: '@fixture/session-controller#session/promptWithReferences',
        service: 'sessionController',
        namespace: 'session',
        method: 'promptWithReferences',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: strictCodec }],
        result: resultCodec,
      },
      {
        id: '@fixture/session-controller#session/prompt',
        service: 'sessionController',
        namespace: 'session',
        method: 'prompt',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: ordinaryCodec }],
        result: resultCodec,
      },
    ],
  })
  let preflightCount = 0
  const removePreflight = registerPreflight
    ? ctx.typertGateway.registerAssertedRequestPreflight((request) => {
      preflightCount += 1
      preflightAssertedRequest(request, limits)
    })
    : () => {}
  onTestFinished(async () => {
    removePreflight()
    await removeDescriptors()
    await Promise.all([serviceFiber.dispose(), gatewayFiber.dispose(), registryFiber.dispose()])
  })
  const service = ctx.get('sessionController')
  if (!(service instanceof AssertedRouteFixture)) throw new Error('Asserted route fixture was not registered')
  return {
    ctx,
    service,
    get parseCount() { return parseCount },
    get preflightCount() { return preflightCount },
    removePreflight,
  }
}

function request(content: unknown[] = [{ type: 'text', text: 'Alpha' }]): Record<string, unknown> {
  return {
    requestId: brandString<SessionPromptWithReferencesRequest['requestId']>('request-one'),
    sessionId: brandString<SessionPromptWithReferencesRequest['sessionId']>('session-one'),
    mode: 'queue',
    content,
    referenceAssertions: { text: 'Alpha', referenceSpans: [{ start: 0, end: 5 }] },
  }
}

function invoke(ctx: Context, method: string, value: unknown): Promise<unknown> {
  return ctx.typertGateway.invoke({ namespace: 'session', method, args: { request: value } })
}

it.each([
  ['content count', () => request([
    { type: 'file', receiptId: 'r'.repeat(36) },
    { type: 'file', receiptId: 'r'.repeat(36) },
    { type: 'file', receiptId: 'r'.repeat(36) },
    { type: 'text', text: 'Alpha' },
    { type: 'file', receiptId: 'r'.repeat(36) },
  ])],
  ['span count', () => ({ ...request(), referenceAssertions: {
    text: 'Alpha', referenceSpans: Array.from({ length: 5 }, () => ({ start: 0, end: 1 })),
  } })],
  ['image count', () => request([
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
  ])],
  ['file count', () => request([
    { type: 'file', receiptId: 'r'.repeat(36) },
    { type: 'file', receiptId: 'r'.repeat(36) },
    { type: 'file', receiptId: 'r'.repeat(36) },
    { type: 'file', receiptId: 'r'.repeat(36) },
  ])],
  ['per-image bytes', () => request([
    { type: 'image', mediaType: 'image/png', data: 'AAAAAAAA' },
    { type: 'text', text: 'Alpha' },
  ])],
  ['aggregate image bytes', () => request([
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'text', text: 'Alpha' },
  ])],
  ['image metadata', () => request([
    { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'n'.repeat(256) },
    { type: 'text', text: 'Alpha' },
  ])],
  ['file metadata', () => request([
    { type: 'file', receiptId: 'r'.repeat(37) },
    { type: 'text', text: 'Alpha' },
  ])],
  ['nested malformed image data', () => request([
    { type: 'image', mediaType: 'image/png', data: { nested: new Array(0xffff_ffff) } },
    { type: 'text', text: 'Alpha' },
  ])],
] as const)('rejects oversized %s before generated codec parsing', async (_name, makeRequest) => {
  const built = await fixture()
  await expect(invoke(built.ctx, 'promptWithReferences', makeRequest())).rejects.toMatchObject({
    code: 'session/reference-rejected',
  })
  expect(built.preflightCount).toBe(1)
  expect(built.parseCount).toBe(0)
  expect(built.service.calls).toEqual([])
})

it('rejects a huge sparse content array without reading any entry or invoking the codec', async () => {
  const built = await fixture()
  let entryReads = 0
  const content = new Array(1_000_000)
  Object.defineProperty(content, '0', { enumerable: true, get: () => { entryReads += 1; return { type: 'text', text: 'Alpha' } } })
  await expect(invoke(built.ctx, 'promptWithReferences', request(content))).rejects.toMatchObject({
    code: 'session/reference-rejected',
  })
  expect(entryReads).toBe(0)
  expect(built.parseCount).toBe(0)
})

it('rejects oversized content before Gateway enumerates unrelated argument keys', async () => {
  const built = await fixture()
  let keyEnumerations = 0
  const content = new Array(1_000_000)
  const args = new Proxy({ request: request(content) }, {
    ownKeys() {
      keyEnumerations += 1
      throw new Error('argument enumeration should follow admission')
    },
  })
  await expect(built.ctx.typertGateway.invoke({
    namespace: 'session', method: 'promptWithReferences', args,
  })).rejects.toMatchObject({ code: 'session/reference-rejected' })
  expect(keyEnumerations).toBe(0)
  expect(built.parseCount).toBe(0)
})

it('rejects a sparse array within the count bound without invoking the codec', async () => {
  const built = await fixture()
  const content = new Array(2)
  content[1] = { type: 'text', text: 'Alpha' }
  await expect(invoke(built.ctx, 'promptWithReferences', request(content)).then(() => undefined))
    .rejects.toMatchObject({ code: 'session/reference-rejected' })
  expect(built.parseCount).toBe(0)
})

it('does not invoke accessors on malformed asserted objects', async () => {
  const built = await fixture()
  let reads = 0
  const assertions = { referenceSpans: [{ start: 0, end: 5 }] }
  Object.defineProperty(assertions, 'text', { enumerable: true, get: () => { reads += 1; return 'Alpha' } })
  await expect(invoke(built.ctx, 'promptWithReferences', { ...request(), referenceAssertions: assertions }))
    .rejects.toMatchObject({ code: 'session/reference-rejected' })
  expect(reads).toBe(0)
  expect(built.parseCount).toBe(0)
})

it.each([
  ['missing request', undefined],
  ['non-object request', null],
  ['wrong content array', { ...request(), content: { nested: new Array(0xffff_ffff) } }],
  ['wrong span array', { ...request(), referenceAssertions: { text: 'Alpha', referenceSpans: {} } }],
] as const)('rejects %s safely before generated codec parsing', async (_label, payload) => {
  const built = await fixture()
  await expect(invoke(built.ctx, 'promptWithReferences', payload)).rejects.toMatchObject({
    code: 'session/reference-rejected',
  })
  expect(built.parseCount).toBe(0)
})

it('admits configured count, byte, and metadata boundaries through strict parsing', async () => {
  const built = await fixture()
  const text = 'A B C D'
  const payload = {
    requestId: 'request-one',
    sessionId: 'session-one',
    mode: 'queue' as const,
    content: [
      { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'n'.repeat(255) },
      { type: 'image', mediaType: 'image/png', data: 'AA==' },
      { type: 'file', receiptId: 'r'.repeat(36) },
      { type: 'text', text },
    ],
    referenceAssertions: {
      text,
      referenceSpans: [
        { start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }, { start: 6, end: 7 },
      ],
    },
  }
  await expect(invoke(built.ctx, 'promptWithReferences', payload)).resolves.toEqual({ accepted: true })
  expect(built.parseCount).toBe(1)
  expect(built.service.calls).toEqual(['promptWithReferences'])
})

it('leaves ordinary prompt decoding outside the asserted preflight', async () => {
  const built = await fixture()
  const ordinary = { requestId: 'request-one', sessionId: 'session-one', mode: 'queue', content: [{ type: 'text', text: 'Alpha' }] }
  await expect(invoke(built.ctx, 'prompt', ordinary)).resolves.toEqual({ accepted: true })
  expect(built.parseCount).toBe(1)
  expect(built.preflightCount).toBe(0)
  expect(built.service.calls).toEqual(['prompt'])
})

it('fails closed if the asserted route preflight registration is absent', async () => {
  const built = await fixture(false)
  await expect(invoke(built.ctx, 'promptWithReferences', request())).rejects.toMatchObject({
    code: 'gateway/input-invalid',
    field: 'request',
  })
  expect(built.parseCount).toBe(0)
  expect(built.service.calls).toEqual([])
})

it('clears the registration only when its own disposer runs', async () => {
  const built = await fixture()
  const second = (): void => {}
  expect(() => built.ctx.typertGateway.registerAssertedRequestPreflight(second))
    .toThrow('asserted request preflight is already registered')
  built.removePreflight()
  await expect(invoke(built.ctx, 'promptWithReferences', request())).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  expect(built.parseCount).toBe(0)
})
