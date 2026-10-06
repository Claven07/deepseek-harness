/** Positional reference-intent mapping, without text search or Unicode normalization. */
import type { SessionReferenceAssertions, SessionReferenceSpan } from '@deepseek-ai/dsh-api-session-controller/types'
import type { DraftAttachmentId } from '../contract/input.ts'
import type { Occurrence, TokenSpan } from '../contract/draft-editor.ts'

/** Immutable scalar editor segment; no Lexical node or mutable editor state escapes. */
export interface ReferenceSegment {
  readonly kind: 'text' | 'chip' | 'linebreak' | 'gap'
  readonly detectStart: number
  readonly detectLength: number
  readonly clipboardStart: number
  readonly clipboardLength: number
}

/** Submission cut captured before callbacks, draft clearing, or asynchronous chip serialization. */
export interface ReferenceDraftSnapshot {
  readonly detectText: string
  readonly clipboardText: string
  readonly segments: readonly ReferenceSegment[]
  readonly marks: readonly TokenSpan[]
  readonly occurrences: readonly Occurrence[]
  readonly attachmentIds: readonly DraftAttachmentId[]
}

/** Serialized replacement at one captured clipboard occurrence. */
export interface ReferenceReplacement {
  readonly offset: number
  readonly length: number
  readonly text: string
}

/** Fixed composer failure without assertion values. */
export class ReferenceMappingError extends Error {
  /** Fixed validation category that identifies the failed reference mapping step. */
  readonly category: string

  /** @param category - fixed validation category. */
  constructor(category: string) {
    super(category)
    this.category = category
  }
}

/**
 * Apply M6.1's reference surface and atom-character rules, rejecting ambiguous full-text endpoints.
 * @param text - exact detect or final UTF-16 text.
 * @param spans - explicit ranges.
 * @param enforceEventLimit - bound final transport to M6.1's event limit.
 * @returns a fixed failure category, or undefined.
 */
export function validateComposerReferences(
  text: string, spans: readonly SessionReferenceSpan[], enforceEventLimit = true,
): string | undefined {
  if (enforceEventLimit && text.length > 1_200) return 'limit'
  if (spans.length === 0 || spans.length > 4) return 'count'
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let previousEnd = 0
  for (const { start, end } of sorted) {
    if (![start, end].every(Number.isSafeInteger) || start < 0 || end <= start || end > text.length) return 'range'
    for (const offset of [start, end]) {
      const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset)
      if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) return 'surrogate'
    }
    const surface = text.slice(start, end)
    const atomCharacter = /[A-Za-z0-9_./-]/
    if (!/^[A-Za-z0-9_./-]+(?:\s+[A-Za-z0-9_./-]+){0,7}$/.test(surface)
      || (start > 0 && atomCharacter.test(text.charAt(start - 1)))
      || (end < text.length && atomCharacter.test(text.charAt(end)))) return 'atom'
    if (start < previousEnd) return 'overlap'
    previousEnd = end
  }
  return undefined
}

/**
 * Map detect ranges through chip expansions, serialization replacements, and final trim.
 * @param snapshot - immutable attempt cut.
 * @param replacements - ordered serialization results at captured clipboard positions.
 * @returns immutable final text and spans for the asserted transport.
 */
export function serializeReferenceAssertions(
  snapshot: ReferenceDraftSnapshot,
  replacements: readonly ReferenceReplacement[],
): SessionReferenceAssertions {
  const spans = snapshot.marks.map((mark) => {
    let delta = 0
    for (const segment of snapshot.segments) {
      if (segment.kind !== 'chip') continue
      const end = segment.detectStart + segment.detectLength
      if (mark.start < end && mark.end > segment.detectStart) throw new ReferenceMappingError('chip')
      if (end <= mark.start) delta += segment.clipboardLength - segment.detectLength
    }
    return { start: mark.start + delta, end: mark.end + delta }
  })
  let text = ''
  let cursor = 0
  for (const part of replacements) {
    if (!Number.isSafeInteger(part.offset) || !Number.isSafeInteger(part.length)
      || part.offset < cursor || part.length < 0 || part.offset + part.length > snapshot.clipboardText.length) {
      throw new ReferenceMappingError('replacement')
    }
    text += snapshot.clipboardText.slice(cursor, part.offset) + part.text
    cursor = part.offset + part.length
  }
  text += snapshot.clipboardText.slice(cursor)
  const mapped: SessionReferenceSpan[] = spans.map((span) => {
    let delta = 0
    for (const part of replacements) {
      const end = part.offset + part.length
      if (span.start < end && span.end > part.offset) throw new ReferenceMappingError('replacement')
      if (end <= span.start) delta += part.text.length - part.length
    }
    return { start: span.start + delta, end: span.end + delta }
  })
  const leading = text.length - text.trimStart().length
  const retainedEnd = text.trimEnd().length
  const finalSpans = mapped.map((span, index) => {
    const mark = snapshot.marks[index]
    if (mark === undefined || span.start < leading || span.end > retainedEnd
      || text.slice(span.start, span.end) !== snapshot.detectText.slice(mark.start, mark.end)) {
      throw new ReferenceMappingError('text-binding')
    }
    return Object.freeze({ start: span.start - leading, end: span.end - leading })
  })
  const final = text.trim()
  const invalid = validateComposerReferences(final, finalSpans)
  if (invalid !== undefined) throw new ReferenceMappingError(invalid)
  return Object.freeze({ text: final, referenceSpans: Object.freeze(finalSpans) })
}
