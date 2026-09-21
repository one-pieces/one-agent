# 工具调用守卫（port of Hermes `agent/tool_guardrails.py`）

## 为什么需要

在此之前，模型如果陷进无效重试（同一个调用反复做、沿同一条失败路径一直撞、A,B,A,B 重放同一批调用），
one-agent 只会一路试到 `maxIterations`：白烧 token，用户还要看一屏重复的工具卡片。

Hermes 用 `agent/tool_guardrails.py`（639 行，纯函数控制器）解决这件事。本仓按其语义移植了精简版
`one-agent-core/src/agent/toolGuardrails.ts`，并把它落到 SSE 契约与前端呈现上。

## 分层：warn → block → halt

| 动作 | 发生时点 | 落地方式 |
|---|---|---|
| `warn` | 执行**后**观察 | 引导文本以合成消息（`synthetic: "guardrailGuidance"`）追加进对话：前端隐藏、压缩时丢弃、模型下一轮能看到 |
| `block` | 执行**前**判定 | 该次调用**不执行**，合成 `ok:false` 结果（`{ error, guardrail: { code, count } }`）交给模型 |
| `halt` | 本轮累计被拦下达到 `haltAfterBlocks` | 发一条 `text`（`[已停止] …`）+ `usage` + `done`，结束本轮 |

`warn` 优先：真机实测（deepseek）里模型拿到一次提示后**自己就改了做法**（第 3 次调用从重复 `read`
换成 `ls`），所以 block/halt 是最后手段，不是常规路径。

## 判据（与 Hermes 对应）

| 决策码 | 触发条件 | 对应 Hermes |
|---|---|---|
| `idempotent_no_progress` | **只读工具**（read/grep/find/ls/tree/web_search/knowledge_search）同参数 + 同结果连续重复；`warnAfter` 起提示，`blockAfter` 起拦下 | `idempotent_no_progress_warning` |
| `repeated_exact_failure` | 同工具 + 同参数 + 同结果反复**失败** | `repeated_exact_failure_warning` |
| `same_tool_failure` | 同工具、参数不同也一直失败 → 附**工具专属恢复建议**（bash：先 `pwd && ls -la` 诊断、再换绝对路径/更简单命令/换 read·edit） | `same_tool_failure_warning` + `_tool_failure_recovery_hint` |
| `identical_call_cycle` | A,B,A,B… 整批重放（周期 2–4，参数与结果都相同） | `identical_cycle_halt` |
| `web_search_cap` | 每轮 `web_search` 超过 `maxWebSearches`（默认 50） | `loop_web_search_cap` |
| `duplicate_same_batch` | **同一批次内**对只读工具的完全相同的调用（模型一次要了 6 个一样的 `read`）→ 只执行第一次，其余抑制 | 无（本仓补充） |

两处与 Hermes 相同的取舍：

- **失败优先于"无进展"**：失败调用按"反复失败"措辞（指向错误本身），`idempotent_no_progress` 只用于成功的只读重复。
- **失败容忍工具**（默认 `bash`）：它们的"失败"是正常产出（测试变红、命令不存在），因此不会被"同工具反复失败"拦下；
  只有**同参数同结果**的重放才会升级（拦截只发生在 `beforeCall`）。

## 配置（`AgentConfig.toolGuardrails`）

```json
{
  "toolGuardrails": {
    "enabled": true,          // 默认开
    "warnAfter": 2,           // 同参数同结果连续第几次开始提示
    "blockAfter": 3,          // 连续第几次后拦下、不再执行
    "haltAfterBlocks": 3,     // 本轮累计拦下多少次后停轮
    "maxWebSearches": 50,     // 每轮 web_search 上限
    "idempotentTools": ["read", "grep", "…"],   // 覆盖默认只读表
    "failureTolerantTools": ["bash"]            // 覆盖默认失败容忍表
  }
}
```

契约同步：`contracts/agent-config.schema.json`。

## 实现要点

- 控制器**纯观察 + 决策**，无副作用；生命周期 = 一次 `agentLoop`（一轮对话），销毁即重置。
- `beginBatch()`：AgentLoop 在执行前判定前调用一次 —— 批内去重的作用域就是一个批次。
- 参数/结果指纹用**键排序的稳定 JSON**（`stableKey`），避免对象键序不同导致"同参"判不出来。
- 执行前的判定（拦截）与执行后的观察（计数）分开：判定只需知道**历史**，不预测结果。
- 执行后的观察按**原始调用顺序**回填（并行段内结果可能乱序到达），保证计数确定。
- 被拦下的调用不参与"结果"统计（它没有结果）。

## 前端呈现

- 被拦下的调用：行尾状态图标为 **Ban + 警示色**（`blocked`，区别于失败的红色 ✗），展开后显示
  「被守卫拦下」+ 拦截原因 + 决策码（`duplicate_same_batch ×1`），而不是一坨 JSON。
- 提示条渲染为 `.tool-guardrail-note`（warning 色调、左沿与代码正文对齐）。
- `warn` 注入的引导消息是合成消息，界面**看不到**（符合"内核脚手架不进对话"的一贯规则）。

## 验证

- 单测：`tests/agent/toolGuardrails.test.ts`（12 例，覆盖每条判据、批内去重、enabled:false）
- 集成：`tests/agent/toolGuardrailLoop.test.ts`（4 例：提示→拦下→停轮、批内重复只执行一次、正常调用不误伤、关闭后行为与守卫生效前一致）
- 前端：`one-agent-app/tests/chat-messages.test.ts`（guardrailOf / toolErrorText / blocked 状态）
- 真机（deepseek-v4-flash）：
  - 要求"原样重复 read 到成功"→ 第 2 次相同失败后注入提示，模型自行改用 `ls`（**warn 生效**）
  - 要求"一批发 6 次相同 read"→ 实发 7 次，**执行 2 次、抑制 5 次**（`duplicate_same_batch`），界面 5 张卡片显示为"被守卫拦下"

## 与 Hermes 的差距（仍是后续项）

Hermes 还有：重复结果的**引用桩替换**（≥512 字符的完全相同结果换成"见上文"）、
`delegate_task` 的子代理预算、以及刻意绕过连续计数时的更多周期形态；本仓暂未移植。
