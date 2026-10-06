/** Bounded, Host-only, one-time reference intent; nothing here enters a Session log. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionPromptValue, SessionPromptWithReferencesRequest, SessionReferenceAssertions, SessionRequestId,
} from './types.ts'

/** One-time handoff outcomes. Invalid and consumed outcomes must suppress M6 extraction. */
export type ReferenceAssertionConsumption =
  | { readonly kind: 'absent' | 'invalid' | 'already-consumed' }
  | { readonly kind: 'asserted'; readonly assertions: SessionReferenceAssertions }

/** Synchronous consumption restricted to the current committed live user-message callback. */
export type ConsumeReferenceAssertions = (
  session: Session,
  agent: Agent,
  message: UserMessage,
  requestId: SessionRequestId,
) => ReferenceAssertionConsumption

/** Host adapter callback; consume synchronously before any asynchronous or downstream work. */
export type ReferenceAssertionConsumer = (
  session: Session,
  agent: Agent,
  event: SessionEvent<'user/message'>,
  consume: ConsumeReferenceAssertions,
) => void

interface Entry {
  readonly session: Session
  readonly requestId: SessionRequestId
  readonly fingerprint: string
  readonly generation: number
  readonly result: Promise<SessionPromptValue>
  readonly controller: AbortController
  state: 'admitting' | 'pending' | 'claimed' | 'consumed' | 'retired' | 'denied'
  agent?: Agent
  message?: UserMessage
  messageId?: UserMessage['id']
  assertions?: SessionReferenceAssertions
  turn?: number
}

const admissionCategories = [
  'count', 'range', 'surrogate', 'atom', 'overlap', 'limit', 'consumer-unavailable',
  'identity-conflict', 'identity-retired', 'capacity', 'admission-failed', 'owner-unavailable',
  'unsupported-route', 'time-zone', 'text-binding', 'identity-history', 'attachment-invalid',
  'canceled', 'message-identity',
] as const

/** Fixed categories deliberately omit prompt, span, source, and identity values.
 * @param category - fixed admission failure category.
 * @returns a Remote failure with no caller data.
 */
export function referenceAdmissionError(category: typeof admissionCategories[number]): RemoteError {
  return new RemoteError('session/reference-rejected', category, {})
}

/** Private producer owner; terminal admission receipts share the explicit capacity bound. */
export class ReferenceAssertionRegistry {
  private readonly entries = new Map<Session, Map<SessionRequestId, Entry>>()
  private readonly moving = new Set<Entry>()
  private readonly byMessage = new Map<UserMessage['id'], Entry>()
  private readonly reservations = new WeakMap<SessionPromptWithReferencesRequest, Entry>()
  private consumer: ReferenceAssertionConsumer | undefined
  private generation = 0
  private disposed = false

  /** @param ctx - Host event and ownership services. @param capacity - maximum live and terminal admission entries. */
  constructor(private readonly ctx: Context, private readonly capacity: number) {
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const entry = this.find(agent, message)
      if (entry?.state !== 'pending') return
      entry.state = 'claimed'
      entry.turn = turn
    })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const entry = this.find(agent, message)
      if (entry !== undefined && !this.moving.has(entry)) this.retire(entry)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message') this.publish(session, event)
      else if (event.type === 'agent/inbox/spliced') {
        for (const message of event.data.inserted) {
          const source = message.source
          const entry = source.kind === 'user' && 'rpcId' in source
            ? this.entries.get(session)?.get(source.rpcId) : undefined
          if (entry?.state === 'admitting') this.retire(entry)
        }
      }
      else if (event.type === 'turn/end') {
        for (const entry of this.entries.get(session)?.values() ?? []) {
          if (entry.state === 'claimed' && entry.turn === event.data.turn) this.retire(entry)
        }
      }
    })
    ctx.on('session/disposed', (session) => { this.removeSession(session) })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const entry of [...this.entries.get(agent.session)?.values() ?? []]) {
        if (entry.agent === agent || entry.agent === undefined) { this.retire(entry); this.deleteEntry(entry) }
      }
    })
    ctx.effect(() => () => {
      this.disposed = true
      this.generation++
      this.consumer = undefined
      for (const session of this.entries.keys()) this.removeSession(session)
      this.moving.clear()
    }, 'session-controller.reference-assertions')
  }

  /**
   * Give one Host adapter a synchronous lease. Disposal revokes pending and in-flight intent.
   * @param consumer - live committed-message callback; errors cannot rearm consumed intent.
   * @returns an idempotent lease disposer.
   */
  lease(consumer: ReferenceAssertionConsumer): Disposable {
    if (this.disposed || this.consumer !== undefined) throw referenceAdmissionError('consumer-unavailable')
    this.consumer = consumer
    this.generation++
    let closed = false
    return { [Symbol.dispose]: () => {
      if (closed) return
      closed = true
      this.consumer = undefined
      this.generation++
      for (const entries of this.entries.values()) for (const entry of entries.values()) {
        if (entry.state === 'admitting' || entry.state === 'pending' || entry.state === 'claimed') this.retire(entry)
      }
    } }
  }

  /**
   * Reserve actual Session and request identity before invoking asynchronous admission.
   * @param session - attached Session instance, never an id-only binding.
   * @param request - immutable request snapshot.
   * @param admit - admission after the synchronous reservation exists.
   * @param signal - caller cancellation before enqueue.
   * @returns the shared admission receipt for identical concurrent attempts.
   */
  reserve(
    session: Session,
    request: SessionPromptWithReferencesRequest,
    admit: (signal: AbortSignal) => Promise<SessionPromptValue>,
    signal?: AbortSignal,
  ): Promise<SessionPromptValue> {
    const fingerprint = createHash('sha256').update(JSON.stringify(request, (_key, value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
      const record = value as Record<string, unknown>
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))
    })).digest('hex')
    const existing = this.entries.get(session)?.get(request.requestId)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw referenceAdmissionError('identity-conflict')
      if (existing.state === 'retired' || existing.state === 'denied') throw referenceAdmissionError('identity-retired')
      return existing.result
    }
    if (this.disposed || this.consumer === undefined) throw referenceAdmissionError('consumer-unavailable')
    if (signal?.aborted === true) throw referenceAdmissionError('canceled')
    this.makeRoom()
    const controller = new AbortController()
    const result = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw referenceAdmissionError('canceled')
      return admit(controller.signal)
    }).catch((error: unknown) => {
      if (this.entries.get(session)?.get(request.requestId) === entry) {
        this.retire(entry)
        entry.state = 'denied'
      }
      const failure = remoteErrorOf(error)
      const category = failure?.code === 'session/reference-rejected'
        ? admissionCategories.find(value => value === failure.message) : undefined
      throw referenceAdmissionError(category ?? 'admission-failed')
    })
    const entry: Entry = {
      session, requestId: request.requestId, fingerprint, generation: this.generation,
      result, controller, state: 'admitting',
    }
    let entries = this.entries.get(session)
    if (entries === undefined) {
      entries = new Map()
      this.entries.set(session, entries)
    }
    entries.set(request.requestId, entry)
    this.reservations.set(request, entry)
    const cancel = (): void => { if (entry.state === 'admitting') this.retire(entry) }
    signal?.addEventListener('abort', cancel, { once: true })
    const detach = (): void => { signal?.removeEventListener('abort', cancel) }
    void result.then(detach, detach)
    return result
  }

  /**
   * Stage intent before any Inbox insertion or synchronous callback.
   * @param session - original reservation owner.
   * @param agent - exact current Agent instance.
   * @param request - reserved immutable request.
   * @param message - final admitted message, without assertion fields.
   */
  stage(session: Session, agent: Agent, request: SessionPromptWithReferencesRequest, message: UserMessage): void {
    const entry = this.entries.get(session)?.get(request.requestId)
    if (entry?.state !== 'admitting' || this.reservations.get(request) !== entry || entry.controller.signal.aborted
      || entry.generation !== this.generation || this.consumer === undefined
      || this.disposed || agent.session !== session || this.ctx.sessions.get(session.id) !== session
      || this.ctx.agents.get(agent.id) !== agent) throw referenceAdmissionError('owner-unavailable')
    if (this.byMessage.has(message.id)) throw referenceAdmissionError('message-identity')
    entry.agent = agent
    entry.message = message
    entry.messageId = message.id
    this.byMessage.set(message.id, entry)
    entry.assertions = request.referenceAssertions
    entry.state = 'pending'
  }

  /**
   * Revoke intent when a queued occurrence is edited or removed.
   * @param agent - queue owner.
   * @param message - occurrence whose edit or removal revokes intent.
   */
  revoke(agent: Agent, message: UserMessage): void {
    const entry = this.find(agent, message)
    if (entry !== undefined) this.retire(entry)
  }

  /**
   * Move the same batch through remove/steer notifications; never recreate removed intent.
   * @param agent - queue owner.
   * @param message - unchanged queued occurrence.
   * @param move - synchronous queue move.
   */
  move(agent: Agent, message: UserMessage, move: () => void): void {
    const entry = this.find(agent, message)
    if (entry === undefined || (entry.state !== 'pending' && entry.state !== 'claimed')) { move(); return }
    this.moving.add(entry)
    try { move() } catch (error) { this.retire(entry); throw error } finally { this.moving.delete(entry) }
  }

  /**
   * Retire intent owned by the active turn, preserving queued, unclaimed intent.
   * @param agent - cancellation owner.
   */
  cancelActive(agent: Agent): void {
    for (const entry of this.entries.get(agent.session)?.values() ?? []) {
      if (entry.agent === agent && entry.state === 'claimed') this.retire(entry)
    }
  }

  private find(agent: Agent, message: UserMessage): Entry | undefined {
    const entry = this.byMessage.get(message.id)
    return entry?.agent === agent && entry.session === agent.session ? entry : undefined
  }

  private publish(session: Session, event: SessionEvent<'user/message'>): void {
    const source = event.data.source
    const correlated = source.kind === 'user' && 'rpcId' in source ? this.entries.get(session)?.get(source.rpcId) : undefined
    const entry = this.byMessage.get(event.data.id) ?? correlated
    if (entry?.state === 'admitting') this.retire(entry)
    const agent = this.ctx.agents.get(session.id) ?? entry?.agent
    if (this.consumer === undefined || agent === undefined) return
    let active = true
    let called = false
    const consume: ConsumeReferenceAssertions = (actualSession, actualAgent, message, requestId) => {
      if (called) return { kind: 'already-consumed' }
      called = true
      if (!active) return { kind: 'invalid' }
      if (entry === undefined) return { kind: 'absent' }
      if (entry.state === 'consumed') return { kind: 'already-consumed' }
      const assertions = entry.assertions
      const valid = assertions !== undefined && (entry.state === 'pending' || entry.state === 'claimed')
        && session === actualSession && session === entry.session && agent === actualAgent
        && agent === entry.agent && agent.session === session
        && this.ctx.sessions.get(session.id) === session && this.ctx.agents.get(agent.id) === agent
        && event.surfaceOp === 'append' && message === event.data && message.id === entry.messageId && requestId === entry.requestId
        && source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
        && finalText(message.content) === assertions.text
      this.retire(entry)
      if (!valid || assertions === undefined) return { kind: 'invalid' }
      entry.state = 'consumed'
      return { kind: 'asserted', assertions }
    }
    try { this.invokeConsumer(this.consumer, session, agent, event, consume) } catch (_error) {
      // Adapter failures never rearm intent or expose its values to diagnostics.
    } finally {
      active = false
      if (entry !== undefined && (entry.state === 'pending' || entry.state === 'claimed')) this.retire(entry)
    }
  }

  private invokeConsumer(
    consumer: ReferenceAssertionConsumer, session: Session, agent: Agent,
    event: SessionEvent<'user/message'>, consume: ConsumeReferenceAssertions,
  ): void {
    const returned: unknown = consumer(session, agent, event, consume)
    if (returned !== undefined) void Promise.resolve(returned).catch((_error: unknown) => {
      // Accidental async callbacks cannot expose assertion data through unhandled rejection diagnostics.
    })
  }

  private retire(entry: Entry): void {
    const admitting = entry.state === 'admitting'
    entry.state = 'retired'
    delete entry.assertions
    delete entry.message
    delete entry.turn
    if (admitting) entry.controller.abort()
  }

  private removeSession(session: Session): void {
    for (const entry of [...this.entries.get(session)?.values() ?? []]) { this.retire(entry); this.deleteEntry(entry) }
    this.entries.delete(session)
  }

  private deleteEntry(entry: Entry): void {
    const entries = this.entries.get(entry.session)
    if (entries?.get(entry.requestId) === entry) entries.delete(entry.requestId)
    if (entries?.size === 0) this.entries.delete(entry.session)
    if (entry.messageId !== undefined && this.byMessage.get(entry.messageId) === entry) this.byMessage.delete(entry.messageId)
  }

  private makeRoom(): void {
    let size = 0
    for (const entries of this.entries.values()) size += entries.size
    if (size < this.capacity) return
    for (const entries of this.entries.values()) for (const entry of entries.values()) {
      if (entry.state === 'consumed' || entry.state === 'retired' || entry.state === 'denied') {
        this.deleteEntry(entry)
        return
      }
    }
    throw referenceAdmissionError('capacity')
  }
}

/**
 * Require exactly one final text block; attachment admission cannot silently rebind intent.
 * @param content - final admitted or submitted content.
 * @returns exact final text, or undefined for an unsupported block arrangement.
 */
export function finalText(content: readonly { readonly type: string; readonly text?: string }[]): string | undefined {
  const last = content.at(-1)
  return last?.type === 'text' && content.filter(block => block.type === 'text').length === 1 ? last.text : undefined
}
