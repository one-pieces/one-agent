# Agent 模板

可直接导入的 agent 配置（`POST /api/agents`，body 就是这个 JSON）。**不含任何密钥** ——
配置里的 `providerId` 指向供应商记录，应用层在保存/运行时解析出 `baseUrl`/`apiKey`。

```bash
# 导入（会创建 id 为 agent-shop-cs 的 agent；id 已存在时返回 409）
curl -X POST http://localhost:3000/api/agents \
  -H 'content-type: application/json' \
  --data-binary @examples/agents/agent-shop-cs.json
```

## agent-shop-cs.json —— 电商平台客服

- 模型：`deepseek-flash`（供应商 DeepSeek），temperature 0.3（客服场景要稳）
- 工具：**全部关闭**（纯知识型客服；接入知识库后 `knowledge_search` 会自动启用）
- 规划规程（planning）关闭：客服不需要多步规划，省 token 也少一次「先想后答」的延迟
- 工具调用守卫保持默认开启
- 系统指令分 12 段：职责范围 / 语气 / 回答结构 / 信息真实性红线 / 做不到的事 /
  索要信息边界 / 转人工升级（含固定格式）/ 工具使用 / 窄屏输出格式 / 边界与拒答 / 风格示例

配套的客服组件文案（标题/欢迎语/占位符）用
`PUT /api/agents/agent-shop-cs/widget` 设置，见 docs/widget-embed-design.md。
