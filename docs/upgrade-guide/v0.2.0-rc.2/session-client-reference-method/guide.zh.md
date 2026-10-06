---
kind: upgrade-guide
description: "自定义 Session 客户端实现必须实现新增的 promptWithReferences 方法。"
---

# Session 客户端实现 `promptWithReferences`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-api-session-controller/client` 导出的 `ISession` 和 `SessionFace` 类型要求实现 `promptWithReferences(content, mode, assertions, requestId, signal?)`。自定义实现和测试夹具必须实现该方法。内置 Session 客户端已实现该方法。普通 `prompt` 调用方保留原有 API。

该方法使用独立的 `session/promptWithReferences` Remote 端点。旧版 Host 会拒绝此端点；客户端必须显示失败，不能通过普通 `prompt` 重试。

## 迁移

1. 更新自定义 `ISession` 或 `SessionFace` 实现，使其接收最终文本和 `@deepseek-ai/dsh-api-session-controller/types` 导出的 `SessionReferenceAssertions`。将它们连同相同的提交 `requestId` 转发至断言 Remote 端点；可选的全局 `AbortSignal` 参数置于最后。
2. 无法提供断言传输的实现必须返回固定的 `session/reference-rejected` 错误，详情为空。不要委托给普通 `prompt`。
3. 运行调用方的 TypeScript 检查，确认不支持的断言提交会显示错误，并且不会调用普通 prompt。
