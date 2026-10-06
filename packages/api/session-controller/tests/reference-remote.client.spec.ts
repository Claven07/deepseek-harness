/** Immutable asserted transport and explicit rejection of unsupported Remote/subagent paths. */
import { expect, it, vi, onTestFinished } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '../src/types.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'
import { Session } from '../src/client/sessions/session.ts'

function fixture(child = false, missing = false) {
  const ordinary = vi.fn<SessionRemotes['session']['prompt']>()
  const asserted = vi.fn<SessionRemotes['session']['promptWithReferences']>()
    .mockResolvedValue({ ok: true, value: { accepted: true } })
  const subagent = vi.fn<SessionRemotes['subagents']['prompt']>()
  const stub: {
    session: Partial<SessionRemotes['session']>
    commands: Partial<SessionRemotes['commands']>
    subagents: Partial<SessionRemotes['subagents']>
    $stream: SessionRemotes['$stream']
  } = { session: { prompt: ordinary, ...missing ? {} : { promptWithReferences: asserted } },
    commands: { execute: vi.fn() }, subagents: { prompt: subagent }, $stream: vi.fn(),
  }
  const remote = stub as SessionRemotes
  const session = new Session('reference-client' as SessionId, remote, child ? {
    address: { parentSessionId: 'parent' as SessionId, childSessionId: 'reference-client' as SessionId, mode: 'continuable' },
    parentAvailable: true,
  } : {})
  onTestFinished(async () => { await session.dispose() })
  return { session, ordinary, asserted, subagent }
}

const assertions = () => ({ text: 'Alpha', referenceSpans: [{ start: 0, end: 5 }] })

it('copies and freezes the final text, blocks, and spans before transport', async () => {
  const built = fixture()
  const spans = assertions()
  const content = [{ type: 'text' as const, text: 'Alpha' }]
  const pending = built.session.promptWithReferences(content, 'queue', spans, 'one' as SessionRequestId)
  content[0]!.text = 'later'
  spans.referenceSpans[0]!.end = 1
  await expect(pending).resolves.toEqual({ ok: true, value: { accepted: true } })
  const request = built.asserted.mock.calls[0]?.[0]
  expect(request?.content).toEqual([{ type: 'text', text: 'Alpha' }])
  expect(request?.referenceAssertions).toEqual(assertions())
  expect(Object.isFrozen(request)).toBe(true)
  expect(Object.isFrozen(request?.referenceAssertions.referenceSpans[0])).toBe(true)
  expect(Object.isFrozen(request?.content[0])).toBe(true)
  expect(built.ordinary).not.toHaveBeenCalled()
})

it.each(['missing', 'remote-error', 'transport-error', 'subagent'] as const)('fails %s explicitly without ordinary/subagent fallback', async (failure) => {
  const built = fixture(failure === 'subagent', failure === 'missing')
  if (failure === 'remote-error') built.asserted.mockResolvedValue({ ok: false,
    error: new RemoteError('gateway/bad-request', 'unsupported endpoint', {}),
  })
  if (failure === 'transport-error') built.asserted.mockRejectedValue(new Error('private error text'))
  const result = await built.session.promptWithReferences([{ type: 'text', text: 'Alpha' }], 'queue', assertions(), 'one' as SessionRequestId)
  expect(result.ok).toBe(false)
  expect(built.ordinary).not.toHaveBeenCalled()
  expect(built.subagent).not.toHaveBeenCalled()
  if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('private error text')
})

it('ordinary prompt remains an independent transport with no assertion fields', async () => {
  const built = fixture()
  built.ordinary.mockResolvedValue({ ok: true, value: { accepted: true } })
  await built.session.prompt([{ type: 'text', text: 'Alpha' }], 'queue')
  expect(built.asserted).not.toHaveBeenCalled()
  expect(built.ordinary.mock.calls[0]?.[0]).not.toHaveProperty('referenceAssertions')
})
