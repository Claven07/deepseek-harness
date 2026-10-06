/** Session commands whose activation policy is explicit at each Remote method. */

import { modelAvailable } from './catalog.ts'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentAdmissionPart, FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import {
  ReasoningEffortId, assistantStreamChunks, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import { ReferenceAssertionRegistry, finalText, referenceAdmissionError } from './reference-assertions.ts'
import { validateReferenceSpans } from './reference-validation.ts'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  inspectApiSession,
} from './agent.ts'
import type {
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptWithReferencesRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  SessionRequestId,
} from './types.ts'

interface SessionReadState {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

type PromptContentCandidate =
  | SessionPromptRequest['content'][number]
  | Extract<SessionUpdateQueueRequest['action'], { readonly kind: 'edit' }>['content'][number]

function hasPromptContent(content: readonly PromptContentCandidate[]): boolean {
  return content.some(part => part.type !== 'text' || part.text.trim().length > 0)
}

/** Reject malformed or over-limit asserted requests without copying or traversing unknown fields.
 * @param input - raw asserted request value from the Gateway parameter boundary.
 * @param limits - active image and attachment limits owned by the Session Controller.
 * @returns nothing when the known request fields fit the bounded admission checks.
 */
export function preflightAssertedRequest(input: unknown, limits: ImageAttachmentLimits): void {
  try {
    const request = assertedRecord(input, 'attachment-invalid')
    const rawContent = assertedArray(assertedField(request, 'content', 'attachment-invalid'), 1, limits.maxImagesPerMessage + 1, 'attachment-invalid')
    const rawAssertions = assertedRecord(assertedField(request, 'referenceAssertions', 'text-binding'), 'text-binding')
    const text = assertedField(rawAssertions, 'text', 'text-binding')
    if (typeof text !== 'string') throw referenceAdmissionError('text-binding')
    if (text.length > 1_200) throw referenceAdmissionError('limit')
    const rawSpans = assertedArray(assertedField(rawAssertions, 'referenceSpans', 'count'), 1, 4, 'count')
    validateRawReferenceSpanStructure(rawSpans.items, rawSpans.length)

    let textCount = 0
    let finalTextValue: string | undefined
    let imageCount = 0
    let attachmentCount = 0
    let totalImageBytes = 0
    for (let index = 0; index < rawContent.length; index += 1) {
      const part = assertedRecord(assertedArrayItem(rawContent.items, index, 'attachment-invalid'), 'attachment-invalid')
      const type = assertedField(part, 'type', 'attachment-invalid')
      if (type === 'text') {
        const value = assertedField(part, 'text', 'text-binding')
        if (typeof value !== 'string') throw referenceAdmissionError('text-binding')
        if (value.length > 1_200) throw referenceAdmissionError('limit')
        textCount += 1
        if (index === rawContent.length - 1) finalTextValue = value
        continue
      }
      if (type === 'image') {
        imageCount += 1
        attachmentCount += 1
        if (imageCount > limits.maxImagesPerMessage || attachmentCount > limits.maxImagesPerMessage) {
          throw referenceAdmissionError('attachment-invalid')
        }
        const mediaType = assertedField(part, 'mediaType', 'attachment-invalid')
        if (mediaType !== 'image/png' && mediaType !== 'image/jpeg'
          && mediaType !== 'image/webp' && mediaType !== 'image/gif') {
          throw referenceAdmissionError('attachment-invalid')
        }
        if (!limits.mediaTypes.includes(mediaType)) throw referenceAdmissionError('attachment-invalid')
        const data = assertedField(part, 'data', 'attachment-invalid')
        if (typeof data !== 'string' || data.length % 4 !== 0) throw referenceAdmissionError('attachment-invalid')
        const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
        const decodedBytes = (data.length / 4) * 3 - padding
        if (decodedBytes > limits.maxImageBytes) throw referenceAdmissionError('attachment-invalid')
        totalImageBytes += decodedBytes
        if (totalImageBytes > limits.maxMessageImageBytes) throw referenceAdmissionError('attachment-invalid')
        const name = assertedField(part, 'name', 'attachment-invalid')
        if (name !== undefined && (typeof name !== 'string' || name.length > 255)) {
          throw referenceAdmissionError('attachment-invalid')
        }
        continue
      }
      if (type === 'file') {
        attachmentCount += 1
        const receiptId = assertedField(part, 'receiptId', 'attachment-invalid')
        if (attachmentCount > limits.maxImagesPerMessage
          || typeof receiptId !== 'string' || receiptId.length > 36) {
          throw referenceAdmissionError('attachment-invalid')
        }
        continue
      }
      throw referenceAdmissionError('attachment-invalid')
    }
    if (textCount !== 1 || finalTextValue === undefined || finalTextValue.length !== text.length || finalTextValue !== text) {
      throw referenceAdmissionError('text-binding')
    }

    if (typeof assertedField(request, 'requestId', 'attachment-invalid') !== 'string'
      || typeof assertedField(request, 'sessionId', 'attachment-invalid') !== 'string') {
      throw referenceAdmissionError('attachment-invalid')
    }
    const mode = assertedField(request, 'mode', 'attachment-invalid')
    if (mode !== 'queue' && mode !== 'steer') throw referenceAdmissionError('attachment-invalid')
    const clientTimeZone = assertedField(request, 'clientTimeZone', 'time-zone')
    if (clientTimeZone !== undefined && typeof clientTimeZone !== 'string') throw referenceAdmissionError('time-zone')
  } catch (error) {
    if (remoteErrorOf(error)?.code === 'session/reference-rejected') throw error
    throw referenceAdmissionError('attachment-invalid')
  }
}

/** Check only the bounded span DTO fields; semantic span validation remains controller-owned. */
function validateRawReferenceSpanStructure(spans: readonly unknown[], spanCount: number): void {
  for (let index = 0; index < spanCount; index += 1) {
    const span = assertedRecord(assertedArrayItem(spans, index, 'range'), 'range')
    const start = assertedField(span, 'start', 'range')
    const end = assertedField(span, 'end', 'range')
    if (typeof start !== 'number' || typeof end !== 'number') throw referenceAdmissionError('range')
  }
}

function assertedRecord(value: unknown, category: 'attachment-invalid' | 'text-binding' | 'range'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw referenceAdmissionError(category)
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== null && prototype !== Object.prototype) throw referenceAdmissionError(category)
  return value as Record<string, unknown>
}

function assertedArray(
  value: unknown,
  minimum: number,
  maximum: number,
  category: 'attachment-invalid' | 'count',
): { readonly items: readonly unknown[]; readonly length: number } {
  if (!Array.isArray(value)) throw referenceAdmissionError(category)
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'number'
    || !Number.isSafeInteger(descriptor.value) || descriptor.value < minimum || descriptor.value > maximum) {
    throw referenceAdmissionError(category)
  }
  return { items: value, length: descriptor.value }
}

function assertedArrayItem(
  value: readonly unknown[],
  index: number,
  category: 'attachment-invalid' | 'count' | 'range',
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw referenceAdmissionError(category)
  }
  return descriptor.value
}

function assertedField(
  value: Record<string, unknown>,
  key: string,
  category: 'attachment-invalid' | 'count' | 'text-binding' | 'range' | 'time-zone',
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  if (!descriptor.enumerable || !('value' in descriptor)) throw referenceAdmissionError(category)
  return descriptor.value
}

/** Copy only validated asserted fields into the immutable controller snapshot. */
function snapshotAssertedRequest(
  input: SessionPromptWithReferencesRequest,
  limits: ImageAttachmentLimits,
): SessionPromptWithReferencesRequest {
  preflightAssertedRequest(input, limits)
  const text = input.referenceAssertions.text
  const spans: { start: number; end: number }[] = []
  for (const span of input.referenceAssertions.referenceSpans) spans.push({ start: span.start, end: span.end })
  const invalid = validateReferenceSpans(text, spans)
  if (invalid !== undefined) throw referenceAdmissionError(invalid)
  const content: SessionPromptWithReferencesRequest['content'][number][] = []
  for (const part of input.content) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text })
    else if (part.type === 'image') content.push({
      type: 'image', mediaType: part.mediaType, data: part.data,
      ...(part.name === undefined ? {} : { name: part.name }),
    })
    else content.push({ type: 'file', receiptId: part.receiptId })
  }
  return deepFreeze({
    requestId: input.requestId,
    sessionId: input.sessionId,
    mode: input.mode,
    content,
    ...(input.clientTimeZone === undefined ? {} : { clientTimeZone: input.clientTimeZone }),
    referenceAssertions: { text, referenceSpans: spans },
  })
}

/**
 * Resolve the omitted-`atSeq` default to the latest completed-turn prefix,
 * including standalone events before the next turn begins.
 */
function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   * @param referenceAssertions - transient asserted admission owner when this controller is Host-owned.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
    private readonly referenceAssertions?: ReferenceAssertionRegistry,
  ) {}

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    const sessionId = request.sessionId ?? brandString<SessionId>(`session-${randomUUID()}`)
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    let adopted: Agent
    try {
      adopted = await this.agents.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== undefined,
        request.agentPreset,
      )
    } catch (error) {
      this.rejectCreation(sessionId, error)
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    }
    const agentPreset = this.agents.presetForSession(adopted.session)
    return { sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) }
  }

  /**
   * Validate and install one Session-local model selection; save the default in the background.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session, without waiting for default persistence.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        await this.requireModel(request)
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        })
        const selected: AgentModelSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort }),
        }
        this.agents.selectForNextRequest(agent, selected)
        void this.ctx.agentDefaultModel.saveSelection(selected).catch((error: unknown) => {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        })
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from an exact event prefix. An explicit
   * `atSeq` is the inclusive cut; an omitted value selects the latest
   * completed-turn prefix. An open cut receives synthetic fork closers.
   * @param request - source Session and optional exact event boundary.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    let atSeq: ReturnType<typeof SessionSeq> | undefined
    try {
      atSeq = request.atSeq === undefined ? undefined : SessionSeq(request.atSeq)
    } catch {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative safe integer', {})
    }
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    using source = observed
    const boundary = atSeq ?? latestCompletedPrefixBoundary(source.events)
    if (boundary === undefined || source.events[boundary]?.seq !== boundary) {
      throw new RemoteError(
        'session/fork-unavailable',
        request.atSeq === undefined
          ? `session "${request.sessionId}" has no completed turn to fork from`
          : `event ${String(request.atSeq)} does not exist in session "${request.sessionId}" (last seq: ${String(source.events.at(-1)?.seq ?? 'none')})`,
        { sessionId: request.sessionId },
      )
    }
    const seed = buildForkSeed(source.events, boundary)
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: SessionLogOffset(boundary + 1),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.header.id,
          isSeeded: true,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Reject empty content, then admit one prompt after Agent and attachment validation.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest): Promise<SessionPromptValue> {
    if (!hasPromptContent(request.content)) {
      throw new RemoteError(
        'gateway/bad-request',
        'prompt content must include non-whitespace text or an attachment',
        {},
      )
    }
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const agent = await this.resolveAgent(request.sessionId)
    if (hasPromptRequest(agent, request.requestId)) return { accepted: true }
    const source: MessageSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }
    const hasImage = request.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        if (hasImage) {
          const current = this.agents.selectionFor(agent).current
          const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model)
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
            throw new RemoteError(
              'session/attachment-invalid',
              `Model "${current.model}" does not support image input.`,
              { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
            )
          }
        }
        const admission = resolvePromptFileReceipts(
          request.content,
          receiptId => this.ctx.fileUploads.resolve(agent, receiptId),
        )
        const content = await this.ctx.attachments.admitPromptContent(admission.content)
        const message: UserMessage = createUserMessage({ content, source })
        if (this.ctx.agents.get(agent.id) !== agent) {
          throw new RemoteError(
            'session/not-found',
            `session "${agent.id}" was disposed during prompt admission`,
            { sessionId: agent.id },
          )
        }
        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
        binding.commit()
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  private async requireModel(selection: Pick<AgentModelSelection, 'provider' | 'model'>): Promise<void> {
    if (!await modelAvailable(this.ctx, selection)) {
      throw new RemoteError('session/model-unavailable', 'Select an available model before sending a message.',
        { provider: selection.provider, model: selection.model })
    }
  }

  /**
   * Reserve intent before async admission, then stage it before synchronous Inbox callbacks.
   * @param input - final asserted request; no assertion-bearing object reaches message construction.
   * @param signal - caller cancellation before enqueue.
   * @returns one shared receipt for identical concurrent requests.
   */
  promptWithReferences(input: SessionPromptWithReferencesRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    if (signal.aborted) throw referenceAdmissionError('canceled')
    let request: SessionPromptWithReferencesRequest
    try {
      request = snapshotAssertedRequest(input, this.ctx.attachments.imageLimits)
    } catch (error) {
      if (remoteErrorOf(error)?.code === 'session/reference-rejected') throw error
      throw referenceAdmissionError('attachment-invalid')
    }
    const text = finalText(request.content)
    if (text === undefined || text !== request.referenceAssertions.text) throw referenceAdmissionError('text-binding')
    const clientTimeZone = request.clientTimeZone === undefined ? undefined : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) throw referenceAdmissionError('time-zone')
    const session = this.ctx.sessions.get(request.sessionId)
    const registry = this.referenceAssertions
    if (session === undefined || registry === undefined) throw referenceAdmissionError('owner-unavailable')
    return registry.reserve(session, request, async (admissionSignal) => {
      const agent = await waitReferenceAdmission(this.resolveAgent(request.sessionId), admissionSignal)
      if (agent.session !== session || hasApiSessionSubagentOwner(this.ctx, session, agent)) {
        throw referenceAdmissionError('unsupported-route')
      }
      const checkAcceptance = async (): Promise<void> => {
        using observation = await this.ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none', signal: admissionSignal })
        if (admissionSignal.aborted) throw referenceAdmissionError('canceled')
        if (observation.source !== 'live' || this.ctx.sessions.get(session.id) !== session
          || this.ctx.agents.get(agent.id) !== agent) throw referenceAdmissionError('owner-unavailable')
        const matches = (message: UserMessage): boolean => message.source.kind === 'user'
          && 'rpcId' in message.source && message.source.rpcId === request.requestId
        if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)
          || observation.events.some(event => event.type === 'user/message' ? matches(event.data)
            : event.type === 'agent/inbox/spliced' && event.data.inserted.some(matches))) {
          // A historical acceptance proves that another assertion batch must not be staged;
          // it does not prove equality of transient assertions lost on restore or eviction.
          throw referenceAdmissionError('identity-history')
        }
      }
      await checkAcceptance()
      const hasImage = request.content.some(part => part.type === 'image')
      const admit = async (): Promise<SessionPromptValue> => {
        if (hasImage) {
          const current = this.agents.selectionFor(agent).current
          const model = await waitReferenceAdmission(this.ctx.llm.resolveModelInfo(current.provider, current.model), admissionSignal)
          if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
            throw referenceAdmissionError('attachment-invalid')
          }
        }
        const admission = resolvePromptFileReceipts(request.content, receiptId => this.ctx.fileUploads.resolve(agent, receiptId))
        const content = await waitReferenceAdmission(this.ctx.attachments.admitPromptContent(admission.content), admissionSignal)
        if (finalText(content) !== text) throw referenceAdmissionError('text-binding')
        const message = createUserMessage({ content, source: {
          kind: 'user', rpcId: request.requestId, ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
        } })
        await checkAcceptance()
        if (admissionSignal.aborted) throw referenceAdmissionError('canceled')
        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)
        registry.stage(session, agent, request, message)
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
        binding.commit()
        return { accepted: true }
      }
      return hasImage ? this.agents.serializeReferenceImageAdmission(agent, admit, admissionSignal) : admit()
    }, signal)
  }

  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    let source: SessionReadState
    try {
      source = await this.readSessionState(request.sessionId)
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const ref = referencedImage(source.events, String(request.attachmentId))
    if (ref === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Image is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one pending Inbox occurrence, restoring an ordinary cold Agent when needed.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  async updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    if (request.action.kind === 'edit') {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote callers can submit untyped JSON.
      if (request.action.content.some(block => block.type !== 'text')) {
        throw new RemoteError(
          'session/attachment-invalid',
          'queue edits accept text content only',
          { reason: 'QUEUE_EDIT_NON_TEXT' },
        )
      }
      if (!hasPromptContent(request.action.content)) {
        throw new RemoteError(
          'gateway/bad-request',
          'queue edit content must include non-whitespace text',
          {},
        )
      }
    }
    let agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      const found = await this.agents.resolveAgent(request.sessionId)
      if ('error' in found) {
        if (found.error.code !== 'session/not-found') throw found.error
        throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
      }
      agent = found.agent
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      const identity = this.ctx.sessionProjections
        .snapshot(agent.session, ['subagent'])
        .values.subagent
      if (identity?.mode !== 'continuable'
        || !agent.session.isOwnSeq(identity.seq)) {
        throw apiSessionSubagentOwnershipError(request.sessionId)
      }
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    switch (request.action.kind) {
      case 'edit':
        this.referenceAssertions?.revoke(agent, message)
        agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
          ...message,
          content: [...request.action.content],
        }))
        break
      case 'remove': {
        this.referenceAssertions?.revoke(agent, message)
        agent.inbox.remove(request.itemId)
        const source = message.source
        if (source.kind === 'user' && 'rpcId' in source) {
          this.ctx.fileUploads.retirePrompt(agent, source.rpcId)
        }
        break
      }
      case 'steer':
        if (this.referenceAssertions === undefined) {
          agent.inbox.remove(request.itemId)
          agent.steer(message)
        } else this.referenceAssertions.move(agent, message, () => {
          agent.inbox.remove(request.itemId)
          agent.steer(message)
        })
        break
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(request.action, 'queue action')
    }
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    this.referenceAssertions?.cancelActive(agent)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  private rejectCreation(sessionId: SessionId, error: unknown): never {
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      throw new RemoteError('session/writer-held', error.message, { sessionId })
    }
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
        ...(error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset }),
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    throw new RemoteError('gateway/internal', `failed to create session "${sessionId}": ${String(error)}`, {})
  }

  private async readSessionState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      return { id: attached.id, header: attached.header, events: attached.snapshotEvents() }
    }
    const inspected = await inspectApiSession(this.ctx, sessionId)
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events }
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

function resolvePromptFileReceipts(
  content: SessionPromptRequest['content'],
  stagedFile: (receiptId: FileUploadReceiptId) => FileAttachmentRef | undefined,
): { readonly content: AttachmentAdmissionPart[]; readonly receiptIds: readonly FileUploadReceiptId[] } {
  const receiptIds = new Set<FileUploadReceiptId>()
  const resolved = content.map((part): AttachmentAdmissionPart => {
    if (part.type !== 'file') return part
    const attachment = stagedFile(part.receiptId)
    if (attachment === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'File was not uploaded for this session.',
        { reason: 'FILE_NOT_STAGED' },
      )
    }
    receiptIds.add(part.receiptId)
    return { type: 'file', attachment }
  })
  return { content: resolved, receiptIds: [...receiptIds] }
}

function hasPromptRequest(agent: Agent, requestId: SessionRequestId): boolean {
  const matches = (message: UserMessage): boolean => {
    const source = message.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  }
  if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return agent.session.snapshotEvents().some((event) => {
    if (event.type !== 'user/message') return false
    const source = event.data.source
    return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
  })
}

/** Release the asserted attempt while non-cancellable attachment/model work settles independently. */
function waitReferenceAdmission<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(referenceAdmissionError('canceled')) }
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    void pending.then((value) => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
  })
}
function imageBlockIn(
  content: unknown,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
  }
  return undefined
}

/** Read only first-party declared content fields; unknown event payloads stay opaque. */
function imageInEvent(
  event: SessionEvent,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: unknown
    readonly summary?: unknown
    readonly rawOutput?: unknown
  }
  // First-party event payloads can be present without their producer plugin mounted.
  const type: string = event.type
  switch (type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      return imageBlockIn(data.content, match)
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      return imageBlockIn(data.message?.content, match)
    case 'agent/inbox/spliced': {
      const messages = data.inserted
      if (!Array.isArray(messages)) return undefined
      for (const message of messages as readonly unknown[]) {
        if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
        const found = imageBlockIn((message as { readonly content?: unknown }).content, match)
        if (found !== undefined) return found
      }
      return undefined
    }
    case 'compaction/summary':
      return imageBlockIn(data.summary, match) ?? imageBlockIn(data.rawOutput, match)
    case 'assistant/message': {
      const found = imageBlockIn(data.message?.content, match)
      if (found !== undefined) return found
      break
    }
    case 'assistant/attempt': break
    default: return undefined
  }
  const assistant = event as SessionEvent<'assistant/message' | 'assistant/attempt'>
  for (const chunk of assistantStreamChunks(assistant.data.stream, 'block-end')) {
    const found = imageBlockIn([chunk.block], match)
    if (found !== undefined) return found
  }
  return undefined
}

function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}
