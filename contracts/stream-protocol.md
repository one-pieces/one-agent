# 流协议（内核 ↔ 应用层 ↔ 前端）

> 语言无关契约 v0.1。格式：HTTP POST + SSE（`text/event-stream`），每行 `data: <json>`，与 OpenAI 流式风格一致。

## 事件类型（`StreamChunk`）

| type | 字段 | 说明 |
|---|---|---|
| `text` | `delta: string` | 文本增量 |
| `tool_call` | `id` / `name` / `input` | 完整工具调用（提供商会聚合分片后发出） |
| `tool_result` | `id` / `ok` / `output` | 工具执行结果（由 AgentLoop 产生，M1） |
| `usage` | `inputTokens` / `outputTokens` / `cachedTokens?` / `cacheCreationTokens?` | token 用量（可能为 0 表示未知）；`cachedTokens` 缓存命中输入（OpenAI `prompt_tokens_details.cached_tokens` / DeepSeek `prompt_cache_hit_tokens` / Anthropic `cache_read_input_tokens`）；`cacheCreationTokens` 缓存写入（Anthropic `cache_creation_input_tokens`，OpenAI 兼容一般无） |
| `error` | `message: string` | 错误（HTTP / 网络 / 流解析失败） |
| `done` | — | 流结束 |

## 示例

```text
data: {"type":"text","delta":"你好"}

data: {"type":"tool_call","id":"call_1","name":"web_search","input":{"q":"2026 诺贝尔奖"}}

data: {"type":"tool_result","id":"call_1","ok":true,"output":"..."}

data: {"type":"text","delta":"根据搜索结果..."}

data: {"type":"usage","inputTokens":1234,"outputTokens":567,"cachedTokens":200}

data: {"type":"done","sessionId":"s_1","messageId":"m_9"}
```

- 终止：`{"type":"done"}`
- 错误：`{"type":"error","message":"..."}`，之后流结束
- 中断：客户端 `AbortController` → 服务端 `AbortSignal` 传导，静默结束（不发 error）
- 顺序约定：`text` / `tool_call` 实时；`tool_call` 在 provider 流结束后聚合发出；`usage` 在 `done` 前；`done` 永远最后

## token 统计持久化

- **消息级**：每条 `assistant` 消息可携带 `usage`（`inputTokens`/`outputTokens`/`cachedTokens?`/`cacheCreationTokens?`），表示生成该消息的那次 LLM 调用用量，随会话落库。
- **会话级**：`Session.meta.tokenUsage` 保存会话累计用量（每轮结束后累加），刷新页面后前端据此恢复右上角统计；即使窗口裁剪/压缩丢弃了旧消息，总量也不丢失。
- 兼容性：旧会话无 `meta.tokenUsage` 时，前端回退为对消息级 `usage` 求和。

## 跨语言一致性测试（契约测试）

同一输入（messages + config）→ 同一事件序列。TS 实现与 Python 实现（未来）都必须通过 `contracts/` 中固化的样例。
