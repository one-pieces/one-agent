# one-agent

从调用大语言模型提供商底层接口开始的自研 agent 内核 + Next.js 应用层。

> 动机：eve 框架（Vercel）的 agent 配置是静态文件（`agent.ts` / `tools/*.ts`），无法运行时动态配置 model / tools。
> one-agent 把配置变成一等数据（JSON），天然支持动态配置。设计文档见项目根目录 `设计方案.md`。

## 项目结构（根目录多项目文件夹）

```
one-agent/
├── contracts/          # ★ 语言无关契约（JSON Schema + 流协议）
├── one-agent-app/      # 应用层（Next.js 16，M3 实现 UI）
├── one-agent-core/     # 内核层（TS，纯逻辑，M0 进行中：Provider 层）
└── one-agent-agent-py/ # Python 内核（未来，drop-in 同一契约，暂未创建）
```

## 快速开始（M0：内核 Provider 层）

```bash
# 1. 安装内核依赖并跑测试（mock SSE，无需联网）
cd one-agent-core && npm install && npm test

# 2. 真实流式 demo（默认连本机 Ollama，无需 key）
npm run demo
# 或指定 DeepSeek / OpenAI 兼容端点：
#   OPENAI_BASE_URL=https://api.deepseek.com/v1 OPENAI_API_KEY=sk-xxx OPENAI_MODEL=deepseek-chat npm run demo

# 3. 交互式多轮对话（M1：Agent + 内置工具 + 多轮工具调用）
npm run chat
#   试试：算一下 (1234*5678)/2 / 列出当前目录 / 搜索 2026 诺贝尔物理学奖

# 4. Anthropic 原生（需要 key）：
#   DEMO_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-xxx ANTHROPIC_MODEL=claude-sonnet-4-5 npm run demo
```

## 状态

- [x] M0：项目骨架 + contracts/ + Provider 层（OpenAI 兼容 + Anthropic）+ 测试 + 真实流式 demo
- [x] M1：ToolRegistry（运行时动态增删工具）+ 内置工具（calculator/web_search/文件工具）+ Agent 动态配置 + AgentLoop 多轮工具调用 + CLI 对话
- [ ] M2：会话与记忆（SessionStore、compaction）
- [ ] M3：应用层 UI
