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

## 启动 Web 应用（M3）

```bash
cd one-agent-app
npm install
npm run dev        # http://localhost:3000
# 左侧图标导航（对话/Agents/日志）→ /chat 选择 Agent → 会话侧边栏 → 流式对话
```

UI 对齐 eve-agent：左侧图标导航栏 + 可折叠会话侧边栏（显示当前 Agent 会话、自动标题）+ Markdown 渲染 + 工具状态徽章 + Token 用量 + 危险工具审批开关 + 消息删除。

数据落在 `one-agent-app/data/`（agents 配置 + sessions 历史，SQLite，已 gitignore）。

## 状态

- [x] M0：项目骨架 + contracts/ + Provider 层（OpenAI 兼容 + Anthropic）+ 测试 + 真实流式 demo
- [x] M1：ToolRegistry（运行时动态增删工具）+ 内置工具（calculator/web_search/文件工具）+ Agent 动态配置 + AgentLoop 多轮工具调用 + CLI 对话
- [x] M2：会话与记忆（Session/SessionStore 内存 + SQLite 持久化、消息 id 稳定、窗口裁剪 + compaction 摘要、重启恢复）
- [x] M3：应用层 v1（Next.js 对话页 + SSE 桥 + Agent 管理 UI 动态配置 + SQLite 存储，浏览器全流程验证）
- [x] M4：动态配置强化（会话级 model/tool 覆盖存 session.meta 每轮自动生效、请求级 override 优先、多会话隔离）
- [x] M5：增强（MCP 桥接动态接入外部工具、工具沙箱 worker_threads、危险工具审批默认拒绝、请求日志 /api/logs、API key AES-256-GCM 加密存储）
- [ ] 文件系统沙盒：当前工具沙箱仅 worker_threads 线程级隔离（崩溃/超时），run_local_command 等命令仍可访问全盘；需 OS 级限制只读写会话工作区（macOS sandbox-exec / Linux 容器 / 权限降级）
- [x] UI 改造（对齐 eve-agent）：左侧图标导航 + 可折叠会话侧边栏（方案 A：当前 Agent 会话）+ Markdown 渲染 + 工具状态徽章 + Token 用量 + 危险工具会话开关 + 消息删除 + 会话自动标题
- [ ] M6（可选）：Python 内核（契约冻结后）
