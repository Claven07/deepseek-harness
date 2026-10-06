/** Mechanical UTF-16 validation for asserted Host admission. */
import type { SessionReferenceSpan } from './types.ts'

/** Fixed validation categories, without caller text or offsets. */
export type ReferenceValidationError = 'count' | 'range' | 'surrogate' | 'atom' | 'overlap' | 'limit'

/**
 * Validate explicit spans without inferring reference meaning or normalizing text.
 * Atom characters match M6.1's ASCII path/name characters: letters, digits, `_./-`.
 * @param text - exact text in JavaScript UTF-16 code units.
 * @param spans - caller-declared half-open ranges.
 * @param enforceEventLimit - apply M6.1's 1,200-code-unit event limit at final admission.
 * @returns a fixed failure category, or undefined for valid ranges.
 */
export function validateReferenceSpans(
  text: string,
  spans: readonly SessionReferenceSpan[],
  enforceEventLimit = true,
): ReferenceValidationError | undefined {
  if (enforceEventLimit && text.length > 1_200) return 'limit'
  if (spans.length < 1 || spans.length > 4) return 'count'
  const ordered = [...spans].sort((a, b) => a.start - b.start)
  for (const [index, span] of ordered.entries()) {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || span.start < 0 || span.start >= span.end || span.end > text.length) return 'range'
    if (splitsSurrogate(text, span.start) || splitsSurrogate(text, span.end)) return 'surrogate'
    if (!/^[A-Za-z0-9_./-]+(?:\s+[A-Za-z0-9_./-]+){0,7}$/.test(text.slice(span.start, span.end))) return 'atom'
    if ((span.start > 0 && /[A-Za-z0-9_./-]/.test(text.charAt(span.start - 1)))
      || (span.end < text.length && /[A-Za-z0-9_./-]/.test(text.charAt(span.end)))) return 'atom'
    const previous = ordered[index - 1]
    if (previous !== undefined && previous.end > span.start) return 'overlap'
  }
  return undefined
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}
