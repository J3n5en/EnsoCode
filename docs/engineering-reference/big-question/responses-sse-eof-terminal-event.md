# Responses 流在网关省略末帧空行时被当成失败

## 症状

同一套 OpenAI Responses API，新开对话正常，旧会话点继续/重试反复红字：

```text
OpenAI Responses stream ended before a terminal response event
```

网关/API 本身往往是好的：服务端已经发出 `response.completed`，正文也可能已经流到 UI，随后整轮被标成 error。再点重试发的是同一请求，继续打转。

## 根因

错误来自 pi-ai `processResponsesStream`：SSE 结束时没见到 `response.completed` / `incomplete` / `failed`。

真正丢掉末帧的是 bundled openai-node（6.40.0）：解码器只在空行时吐事件。部分兼容网关（尤其负载高、长会话）在最后一条 `data:` 后直接关连接，不跟 `\n\n`。`response.completed` 正好是最后一帧，被静默丢弃。

新对话更短、更快，更容易带上合规空行，所以看起来像「API 没问题、旧会话坏了」。

上游：openai/openai-node#2725；pi#9513 / #9047。

## 修法

在 `withOpenAIResponsesRouting` 里包 fetch：`text/event-stream` 的 body 在 EOF 补 `\n\n`。空帧会被忽略，未闭合的末帧会被刷出。不改预算、store、缓存策略。

## 回归防线

`src/agent/sseEofFlush.test.ts`：合规 SSE 仍成功；末帧只有 `\n` 或无换行时，未包装走 openai-node 会报这句错，包装后 `stopReason: stop`。

## 相关代码

- `src/agent/sseEofFlush.ts`
- `src/agent/openaiResponsesRouting.ts`
- pi-ai `dist/api/openai-responses-shared.js`（`sawTerminalResponseEvent`）
