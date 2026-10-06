/** Explicit intent stays outside editor history and survives only selection changes. */
import { Context } from '@deepseek-ai/cordis'
import { UNDO_COMMAND, $getSelection, $isRangeSelection } from 'lexical'
import { expect, it, vi, onTestFinished } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DraftAttachmentId, InputTriggerController } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { SessionInputDeps } from '../src/client/input/facade.ts'
import { $replaceDetectSpanWithText, $selectDetectSpan } from '../src/client/input/editor/span-map.ts'

function fixture(overrides: Partial<SessionInputDeps> = {}) {
  const asserted = vi.fn<NonNullable<SessionInputDeps['assertedSink']>>(async () => ({ kind: 'success' as const }))
  const ordinary = vi.fn<SessionInputDeps['defaultSink']>(async () => ({ kind: 'success' as const }))
  const input = new SessionInputShell({ actx: new Context(), defaultSink: ordinary,
    canAssert: () => true, assertedSink: asserted, referenceNotice: category => category,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' }, ...overrides })
  onTestFinished(() => { input.dispose() })
  input.setDraft('Use Alpha instead of Beta')
  return { input, asserted, ordinary }
}

function select(input: SessionInputShell, start: number, end: number, backward = false) {
  input.editor.update(() => {
    expect($selectDetectSpan({ start, end })).toBe(true)
    const selection = $getSelection()
    if (backward && $isRangeSelection(selection)) {
      const anchor = { ...selection.anchor }
      selection.anchor.set(selection.focus.key, selection.focus.offset, selection.focus.type)
      selection.focus.set(anchor.key, anchor.offset, anchor.type)
    }
  }, { discrete: true })
  return input.actions.captureInsertion()
}

it('identical unmarked text uses only ordinary prompt', async () => {
  const { input, ordinary, asserted } = fixture()
  input.submit()
  expect(ordinary).toHaveBeenCalledOnce()
  expect(asserted).not.toHaveBeenCalled()
})

it.each([false, true])('captures forward/backward selection (%s) without changing editor JSON or persistence', (backward) => {
  const { input } = fixture()
  const mirror = vi.fn()
  input.bindMirror(mirror)
  const span = select(input, 4, 9, backward)
  const json = input.editor.getEditorState().toJSON()
  const calls = mirror.mock.calls.length
  expect(input.markReference(span)).toBe(true)
  expect(input.snapshot.referenceMarks).toEqual([span])
  expect(input.editor.getEditorState().toJSON()).toEqual(json)
  expect(mirror).toHaveBeenCalledTimes(calls)
  select(input, 0, 0)
  expect(input.snapshot.referenceMarks).toEqual([span])
})

it.each([
  ['insert before', 0, 0, 'New '], ['delete before', 0, 4, ''], ['inside', 5, 6, 'x'],
] as const)('clears every mark on %s', (_name, start, end, text) => {
  const { input } = fixture()
  expect(input.markReference(select(input, 4, 9))).toBe(true)
  input.editor.update(() => { $replaceDetectSpanWithText({ start, end }, text) }, { discrete: true })
  expect(input.snapshot.referenceMarks).toEqual([])
})

it('clears on paste, undo, and identical programmatic replacement', async () => {
  const { input } = fixture()
  input.markReference(select(input, 4, 9))
  input.paste('Alpha')
  expect(input.snapshot.referenceMarks).toEqual([])
  input.setDraft('Use Alpha instead of Beta')
  input.markReference(select(input, 4, 9))
  const old = input.actions.captureInsertion()
  input.setDraft(input.snapshot.draft)
  expect(input.snapshot.referenceMarks).toEqual([])
  expect(input.markReference(old)).toBe(false)
  input.actions.insertText('New ', { start: 0, end: 0, draftRev: input.snapshot.draftRev })
  input.markReference(select(input, 8, 13))
  input.editor.dispatchCommand(UNDO_COMMAND, undefined)
  await vi.waitFor(() => { expect(input.snapshot.referenceMarks).toEqual([]) })
})

it('rejects stale/empty/partial/duplicate selections and a fifth mark', () => {
  const { input } = fixture()
  const stale = select(input, 4, 9)
  input.setDraft(input.snapshot.draft)
  expect(input.markReference(stale)).toBe(false)
  expect(input.markReference(select(input, 4, 4))).toBe(false)
  expect(input.markReference(select(input, 5, 9))).toBe(false)
  input.setDraft('A B C D E')
  for (const start of [0, 2, 4, 6]) expect(input.markReference(select(input, start, start + 1))).toBe(true)
  expect(input.markReference(select(input, 0, 1))).toBe(false)
  expect(input.markReference(select(input, 8, 9))).toBe(false)
})

it('captures immutable exact spans before a reentrant submission callback edits the draft', async () => {
  const state = { running: false, runMode: 'default' as const }
  const built = fixture({ submissionState: () => { built.input.setDraft('later'); return state } })
  const { input } = built
  input.markReference(select(input, 4, 9))
  input.submit()
  await vi.waitFor(() => { expect(built.asserted).toHaveBeenCalledOnce() })
  expect(built.asserted.mock.calls[0]?.[0]).toEqual({ text: 'Use Alpha instead of Beta', referenceSpans: [{ start: 4, end: 9 }] })
  expect(input.snapshot.draft).toBe('later')
  expect(built.ordinary).not.toHaveBeenCalled()
})

it('restores a failed send without intent and never retries it through ordinary prompt', async () => {
  const send = vi.fn(async () => { throw new Error('private caller text') })
  const { input, ordinary } = fixture({ assertedSink: send })
  input.markReference(select(input, 4, 9))
  input.submit()
  await vi.waitFor(() => { expect(input.snapshot.draft).toBe('Use Alpha instead of Beta') })
  expect(input.snapshot.referenceMarks).toEqual([])
  expect(ordinary).not.toHaveBeenCalled()
  expect(input.notices.getSnapshot()?.text).toBe('send-failed')
})

it('refuses command, subagent, and takeover routes visibly', () => {
  const { input } = fixture({ canAssert: () => false })
  expect(input.markReference(select(input, 4, 9))).toBe(false)
  expect(input.notices.getSnapshot()?.text).toBe('unsupported-route')
  const supported = fixture().input
  supported.setDraft('/command Alpha')
  expect(supported.markReference(select(supported, 9, 14))).toBe(false)
})

it('rejects chip selection and clears intent on chip insertion and removal', () => {
  const { input } = fixture()
  input.setDraft('Alpha')
  input.markReference(select(input, 0, 5))
  select(input, 0, 0)
  input.addFiles([{ source: 'file', ref: 'one', label: 'one', clipboardText: '@one' }], [])
  expect(input.snapshot.referenceMarks).toEqual([])
  expect(input.markReference(select(input, 0, 1))).toBe(false)
  expect(input.markReference(select(input, 0, 4))).toBe(false)
  expect(input.markReference(select(input, 2, 7))).toBe(true)
  input.editor.update(() => { $replaceDetectSpanWithText({ start: 0, end: 1 }, '') }, { discrete: true })
  expect(input.snapshot.referenceMarks).toEqual([])
})

it('rejects surrogate-splitting selections and preserves UTF-16 offsets after emoji', () => {
  const { input } = fixture()
  input.setDraft('😀 Alpha')
  expect(input.markReference(select(input, 0, 1))).toBe(false)
  expect(input.markReference(select(input, 1, 2))).toBe(false)
  expect(input.markReference(select(input, 3, 8))).toBe(true)
})

it('serializes captured chip positions asynchronously while later typing changes only the new draft', async () => {
  const serialization = Promise.withResolvers<string>()
  const triggers: InputTriggerController = {
    launcher: createSnapshotStore<string | null>(null),
    lexicon: createSnapshotStore<ReadonlyMap<'/' | '@', readonly string[]>>(new Map()),
    track: () => {}, arbitrate: () => 'pass', onSpace: () => false,
    serializeReference: () => serialization.promise, adjudicate: async () => undefined,
    openReference: () => false, toggleSource: () => {},
  }
  const { input, asserted, ordinary } = fixture({ inputTriggers: () => triggers })
  input.setDraft('Alpha')
  select(input, 0, 0)
  input.addFiles([{ source: 'file', ref: 'one', label: 'one', clipboardText: '@one' }], [])
  expect(input.markReference(select(input, 2, 7))).toBe(true)
  input.submit()
  input.setDraft('later')
  serialization.resolve('expanded chip')
  await vi.waitFor(() => { expect(asserted).toHaveBeenCalledOnce() })
  expect(asserted.mock.calls[0]?.[0]).toEqual({ text: 'expanded chip Alpha', referenceSpans: [{ start: 14, end: 19 }] })
  expect(input.snapshot.draft).toBe('later')
  expect(ordinary).not.toHaveBeenCalled()
})

it('captures before the submission notification and restores failed content and attachments without marks', async () => {
  const sent = Promise.withResolvers<{ kind: 'error' }>()
  const sink = vi.fn<NonNullable<SessionInputDeps['assertedSink']>>(() => sent.promise)
  const notified = vi.fn(() => {
    expect(built.input.snapshot.referenceMarks).toEqual([])
    expect(built.input.snapshot.draft).toBe('Use Alpha instead of Beta')
  })
  const built = fixture({ assertedSink: sink,
    submissionState: () => ({ running: false, runMode: 'default' }), messageSubmitted: notified,
  })
  const { input } = built
  const attachment = 'captured-attachment' as DraftAttachmentId
  input.addAttachments([attachment])
  input.markReference(select(input, 4, 9))
  input.submit()
  expect(notified).toHaveBeenCalledOnce()
  expect(input.snapshot.draft).toBe('')
  expect(input.snapshot.attachmentIds).toEqual([])
  await vi.waitFor(() => { expect(sink).toHaveBeenCalledOnce() })
  expect(sink.mock.calls[0]![0]).toEqual({
    text: 'Use Alpha instead of Beta', referenceSpans: [{ start: 4, end: 9 }],
  })
  expect(sink.mock.calls[0]![1]).toEqual([attachment])
  sent.resolve({ kind: 'error' })
  await vi.waitFor(() => { expect(input.snapshot.draft).toBe('Use Alpha instead of Beta') })
  expect(input.snapshot.attachmentIds).toEqual([attachment])
  expect(input.snapshot.referenceMarks).toEqual([])
  expect(built.ordinary).not.toHaveBeenCalled()
})
