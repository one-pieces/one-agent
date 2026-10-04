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
cd one-agent-core && pnpm install && pnpm test

# 2. 真实流式 demo（默认连本机 Ollama，无需 key）
pnpm run demo
# 或指定 DeepSeek / OpenAI 兼容端点：
#   OPENAI_BASE_URL=https://api.deepseek.com/v1 OPENAI_API_KEY=sk-xxx OPENAI_MODEL=deepseek-chat pnpm run demo

# 3. 交互式多轮对话（M1：Agent + 内置工具 + 多轮工具调用）
pnpm run chat
#   试试：算一下 (1234*5678)/2 / 列出当前目录 / 搜索 2026 诺贝尔物理学奖

# 4. Anthropic 原生（需要 key）：
#   DEMO_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-xxx ANTHROPIC_MODEL=claude-sonnet-4-5 pnpm run demo
```

## 启动 Web 应用（M3）

```bash
cd one-agent-app
pnpm install
pnpm run dev        # http://localhost:3000
# 左侧单列侧边栏（顶部 Agent/知识库 + 中部会话树 + 底部设置）→ /chat 点会话就地打开 → 流式对话
```

> ⚠️ **改动 `one-agent-core` 后必须重新 `NODE_ENV=development pnpm install`**：app 通过 pnpm `file:` 依赖引用 core，
> `node_modules/@one-agent/core` 里的文件是与源码的**硬链接**，改写 core 文件会断链 —— app（含 Next dev，
> `transpilePackages` 会编译这份副本）会**静默继续用旧代码**，表现为「改动不生效 / 类型找不到」。
> 若改动未生效，先执行这条重装命令。

UI：左侧单列侧边栏（顶部 `Agent` 标题 + 知识库导航，中部按 Agent 分组的会话树，底部主题切换 + 设置；供应商与日志收在设置里）+ 主区跟随导航（点会话就地打开对话）+ Markdown 渲染 + 工具状态徽章 + Token 用量 + 消息删除。

数据落在 `one-agent-app/data/`（agents 配置 + sessions 历史，SQLite，已 gitignore）。

## 状态

- [x] M0：项目骨架 + contracts/ + Provider 层（OpenAI 兼容 + Anthropic）+ 测试 + 真实流式 demo
- [x] M1：ToolRegistry（运行时动态增删工具）+ 内置工具（read/write/edit/bash/grep/find/ls/web_search）+ Agent 动态配置 + AgentLoop 多轮工具调用 + CLI 对话
- [x] M2：会话与记忆（Session/SessionStore 内存 + SQLite 持久化、消息 id 稳定、窗口裁剪 + compaction 摘要、重启恢复）
- [x] M3：应用层 v1（Next.js 对话页 + SSE 桥 + Agent 管理 UI 动态配置 + SQLite 存储，浏览器全流程验证）
- [x] M4：动态配置（Agent 配置改动即时生效：按 config 缓存 Agent 实例并自动重建；模型与工具一律以 Agent 配置为准）
- [x] M5：增强（MCP 桥接动态接入外部工具、工具沙箱 worker_threads、危险工具审批默认拒绝、请求日志 /api/logs、API key AES-256-GCM 加密存储）
- [x] P1：自规划能力（AgentConfig.planning 规划规程 + todo 计划工件（压缩后自动重注入未完成项）+ plan 方案文档/面板）与工具批调度器（路径重叠感知的并行/串行分段）
- [ ] 文件系统沙盒：当前工具沙箱仅 worker_threads 线程级隔离（崩溃/超时），bash 等命令仍可访问全盘；需 OS 级限制只读写会话工作区（macOS sandbox-exec / Linux 容器 / 权限降级）
- [x] UI 改造（对齐 eve-agent）：左侧图标导航 + 可折叠会话侧边栏（方案 A：当前 Agent 会话）+ Markdown 渲染 + 工具状态徽章 + Token 用量 + 危险工具会话开关 + 消息删除 + 会话自动标题
- [x] 知识库完整 RAG（对齐 eve-agent）：多文件上传（.txt/.md/.mdx）→ 每文件独立向量索引（none→building→done/error，SSE 进度）+ Transformers.js 本地向量化（BAAI/bge-m3，1024 维，hf-mirror 兜底）+ 混合检索（BM25+向量+RRF）+ 可选 cross-encoder 重排 + 向量索引/分块查看器 + `knowledge_search` 工具（Agent 按需调用）
- [x] 模型供应商独立模块：`providers` 表 + `/settings/providers` 管理页（**入口在左侧导航底部的「设置」里**；kind/Base URL/API Key/模型清单，密钥 AES-256-GCM 加密）；Agent 只填 `providerId` 下拉选择，运行时解析 → 换密钥/换地址一次生效；老配置自动迁移
- [x] 导航收敛：单列侧边栏 = 顶部「Agent（标题，→ 对话首页）+ 知识库」+ 中部会话树 + 底部「主题 / 设置」；供应商与请求日志收进 `/settings`（子导航 供应商 / 日志），旧地址 `/providers`、`/logs` 保留 307 重定向；主区始终渲染当前导航项/当前会话的内容
- [x] 侧边栏提为常驻外壳（`app/(app)/layout.tsx`）：会话树在任何页面都可见，/chat 点会话在主区就地打开（不跳路由），其它路由点会话走 `/chat/session/[id]`
- [x] 工具调用守卫（移植 Hermes `tool_guardrails`）：识别无效重试（幂等无进展 / 同参反复失败 / 调用周期 / 批内重复），按 提示 → 拦下 → 停轮 三级处理；被拦下的调用在前端以「被守卫拦下」呈现
- [x] 客服组件（嵌入网站）：一行 `<script src="/widget.js" data-agent data-key>` 接入任意网站 → 右下角客服按钮 + 面板（iframe 隔离样式）→ 访客无需登录即可与 agent 对话；后台可按 agent 配置标题/欢迎语/主题色/位置/来源白名单/限流，SSE 工具内部信息不外泄（详见 docs/widget-embed-design.md）
- [x] Agent 详情页二级导航：**Agent 配置**（模型/工具/知识库/客服组件）+ **对话记录**（每个用户与 agent 的对话列表，客服访客会话带来源域名、可按类型筛选与搜索、可打开与删除）
- [ ] M6（可选）：Python 内核（契约冻结后）
