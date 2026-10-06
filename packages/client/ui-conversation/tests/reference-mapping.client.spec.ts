/** Positional intent mapping and parity with M6.1's mechanical token surface. */
import { describe, expect, it } from 'vitest'
import { validateReferenceSpans } from '../../../api/session-controller/src/reference-validation.ts'
import {
  ReferenceMappingError, serializeReferenceAssertions, validateComposerReferences,
} from '../src/client/input/reference-serialization.ts'
import type { ReferenceDraftSnapshot } from '../src/client/input/reference-serialization.ts'

function snapshot(text: string, spans = [{ start: 0, end: text.length }]): ReferenceDraftSnapshot {
  return Object.freeze({ detectText: text, clipboardText: text, segments: Object.freeze([]),
    marks: Object.freeze(spans.map(span => Object.freeze({ ...span, draftRev: 1 }))),
    occurrences: Object.freeze([]), attachmentIds: Object.freeze([]) })
}

describe('M6.1 surface and UTF-16 endpoints', () => {
  it.each(['Alpha', 'alpha', 'path/file.ts', 'get-value', 'under_score', '../src', 'two tokens'])('accepts whole %s', (text) => {
    const spans = [{ start: 0, end: text.length }]
    expect(validateReferenceSpans(text, spans)).toBeUndefined()
    expect(validateComposerReferences(text, spans)).toBeUndefined()
  })
  it.each([
    ['empty', 'Alpha', [{ start: 0, end: 0 }]],
    ['partial left', 'Alpha', [{ start: 1, end: 5 }]],
    ['partial right', 'Alpha', [{ start: 0, end: 4 }]],
    ['ambiguous period', 'Beta.', [{ start: 0, end: 4 }]],
    ['unicode identifier', 'café', [{ start: 0, end: 4 }]],
    ['chip', '\uFFFC', [{ start: 0, end: 1 }]],
    ['negative', 'Alpha', [{ start: -1, end: 4 }]],
    ['fraction', 'Alpha', [{ start: 0.5, end: 5 }]],
    ['nan', 'Alpha', [{ start: Number.NaN, end: 5 }]],
    ['outside', 'Alpha', [{ start: 0, end: 6 }]],
    ['surrogate start', '😀 Alpha', [{ start: 1, end: 2 }]],
    ['surrogate end', '😀 Alpha', [{ start: 0, end: 1 }]],
    ['duplicate', 'Alpha', [{ start: 0, end: 5 }, { start: 0, end: 5 }]],
    ['overlap', 'A B C', [{ start: 0, end: 3 }, { start: 2, end: 5 }]],
    ['nesting', 'A B C', [{ start: 0, end: 5 }, { start: 2, end: 3 }]],
    ['fifth', 'A B C D E', [0, 2, 4, 6, 8].map(start => ({ start, end: start + 1 }))],
    ['too many words', 'a b c d e f g h i', [{ start: 0, end: 17 }]],
    ['event limit', 'A'.repeat(1_201), [{ start: 0, end: 1_201 }]],
  ] as const)('rejects %s with matching fixed categories', (_name, text, spans) => {
    const host = validateReferenceSpans(text, spans)
    expect(host).toBeDefined()
    expect(validateComposerReferences(text, spans)).toBe(host)
  })
  it('supports four marks with emoji before and between references', () => {
    const text = '😀 A 😀 B C D'
    expect(serializeReferenceAssertions(snapshot(text, [3, 8, 10, 12].map(start => ({ start, end: start + 1 }))), []))
      .toEqual({ text, referenceSpans: [3, 8, 10, 12].map(start => ({ start, end: start + 1 })) })
  })
})

describe('positional serialization', () => {
  it('maps repeated identical text across expanded chips, paragraph gaps, newlines, spaces, and trim', () => {
    const input = snapshot('  \uFFFC Alpha\n\n\uFFFC Alpha  ', [{ start: 4, end: 9 }, { start: 13, end: 18 }])
    const cut: ReferenceDraftSnapshot = Object.freeze({ ...input,
      clipboardText: '  @first Alpha\n\n@second Alpha  ',
      segments: Object.freeze([
        { kind: 'chip', detectStart: 2, detectLength: 1, clipboardStart: 2, clipboardLength: 6 },
        { kind: 'gap', detectStart: 9, detectLength: 1, clipboardStart: 14, clipboardLength: 1 },
        { kind: 'linebreak', detectStart: 10, detectLength: 1, clipboardStart: 15, clipboardLength: 1 },
        { kind: 'chip', detectStart: 11, detectLength: 1, clipboardStart: 16, clipboardLength: 7 },
      ] as const),
    })
    const result = serializeReferenceAssertions(cut, [
      { offset: 2, length: 6, text: 'expanded first ' }, { offset: 16, length: 7, text: 'other' },
    ])
    expect(result).toEqual({ text: 'expanded first  Alpha\n\nother Alpha',
      referenceSpans: [{ start: 16, end: 21 }, { start: 29, end: 34 }] })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.referenceSpans)).toBe(true)
    expect(Object.isFrozen(result.referenceSpans[0])).toBe(true)
  })
  it('rejects a replacement crossing an asserted range', () => {
    expect(() => serializeReferenceAssertions(snapshot('Alpha'), [{ offset: 1, length: 2, text: 'x' }]))
      .toThrow(ReferenceMappingError)
  })
  it('rejects chip intersection even if the assertion snapshot is forged', () => {
    const cut = { ...snapshot('Alpha'), segments: [
      { kind: 'chip' as const, detectStart: 2, detectLength: 1, clipboardStart: 2, clipboardLength: 1 },
    ] }
    expect(() => serializeReferenceAssertions(cut, [])).toThrow('chip')
  })
  it.each([' Alpha', 'Alpha '])('rejects a span removed by trim: %s', (text) => {
    expect(() => serializeReferenceAssertions(snapshot(text), [])).toThrow('text-binding')
  })
  it('revalidates whole atoms after an adjacent chip expands', () => {
    const cut = { ...snapshot('\uFFFCAlpha', [{ start: 1, end: 6 }]), clipboardText: '@aAlpha', segments: [
      { kind: 'chip' as const, detectStart: 0, detectLength: 1, clipboardStart: 0, clipboardLength: 2 },
    ] }
    expect(() => serializeReferenceAssertions(cut, [{ offset: 0, length: 2, text: 'prefix' }])).toThrow('atom')
  })
  it('preserves exact selected whitespace without adding spans for repeated unmarked text', () => {
    const text = 'Alpha\tBeta Alpha Beta'
    const spans = [{ start: 0, end: 10 }]
    const result = serializeReferenceAssertions(snapshot(text, spans), [])
    expect(result.text).toBe(text)
    expect(result.referenceSpans).toEqual(spans)
    expect(result.text.slice(result.referenceSpans[0]!.start, result.referenceSpans[0]!.end)).toBe('Alpha\tBeta')
  })
  it.each(['  Alpha', 'Alpha  ', ' \nAlpha\n '])('maps retained text adjacent to trim without normalization (%s)', (text) => {
    const start = text.length - text.trimStart().length
    const result = serializeReferenceAssertions(snapshot(text, [{ start, end: start + 5 }]), [])
    expect(result).toEqual({ text: 'Alpha', referenceSpans: [{ start: 0, end: 5 }] })
  })
})
