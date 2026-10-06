---
kind: upgrade-guide
description: "Custom Session client implementations must implement the new promptWithReferences method."
---

# Session clients implement `promptWithReferences`

English | [中文](guide.zh.md)

## Change

The exported `ISession` and `SessionFace` types in `@deepseek-ai/dsh-api-session-controller/client` require `promptWithReferences(content, mode, assertions, requestId, signal?)`. Custom implementations and test fixtures must implement this method. The supplied Session client implements it. Ordinary `prompt` callers keep their existing API.

The method uses the separate `session/promptWithReferences` Remote endpoint. Older Hosts reject this endpoint; clients must surface the failure without retrying through ordinary `prompt`.

## Migration

1. Update custom `ISession` or `SessionFace` implementations to accept the final text and `SessionReferenceAssertions` exported from `@deepseek-ai/dsh-api-session-controller/types`. Forward them to the asserted Remote endpoint with the same submission `requestId`; keep optional global `AbortSignal` last.
2. Implementations that cannot provide asserted transport must return a fixed `session/reference-rejected` error with empty details. Do not delegate to ordinary `prompt`.
3. Run the consumer's TypeScript check and verify that an unsupported asserted send produces a visible error and makes no ordinary prompt call.
