# 客服组件（嵌入网站的 JS SDK）

## 目标

任何 agent 都能一键变成"网页客服"：新建 agent → 后台开启客服组件 → 复制一行 `<script>` 粘到客户网站 →
访客在该网站右下角看到客服按钮，点开即可与这个 agent 对话（**无需登录**）。

## 架构

```
客户网站（任意域名）
├─ <script src="…/widget.js" data-agent data-key>      ← SDK（public/widget.js，无依赖 ~8KB）
│    ├─ 注入悬浮按钮（fixed，56×56，右下/左下 24px）
│    └─ 注入面板 iframe → one-agent 的 /embed/chat
│         └─ 访客对话界面（components/widget/WidgetChat.tsx）
│              └─ fetch /api/widget/{config,session,messages,chat}（同源，SSE 流式）
└─ postMessage 双向：SDK ⇄ iframe（open/close/ready/unread）

one-agent 后台
└─ Agent 详情页「客服组件（嵌入网站）」卡片 → /api/agents/[id]/widget
```

**为什么面板用 iframe**：客户网站的 CSS 与 one-agent 的界面互相完全隔离（反之亦然），
SDK 里不需要带任何对话 UI 代码，也避免了 Shadow DOM 在流式渲染/高度自适应上的坑。

## 数据模型

`widget_settings` 表（每个 agent 一行，`agent_id` 主键）：

| 字段 | 说明 |
|---|---|
| `enabled` | 是否允许嵌入（关闭后公开接口一律 403） |
| `embed_key` | 公开嵌入凭据 `wk_<32hex>`，可重置（重置后旧代码立即失效） |
| `title` / `subtitle` / `welcome` / `placeholder` | 面板文案（空则回落默认值，title 回落到 agent 名） |
| `primary_color` | 主题色（按钮、头部、用户气泡） |
| `position` | `right` / `left` |
| `origins` | 允许的来源白名单（可空 = 不限制） |
| `rate_limit` | 每个访客每分钟消息数（0 = 不限） |

## 接口

**后台（需与后台同一来源，无鉴权——与其它后台接口一致）**
- `GET /api/agents/[id]/widget` → `{ settings, configured, snippet, demoUrl, embedUrl }`
- `PUT /api/agents/[id]/widget` → 更新配置；`{ resetKey: true }` 重置嵌入 key
- `DELETE /api/agents/[id]/widget` → 关闭并清空配置

**公开（面向公网访客，全部要求 `agentId + key`，全部带 CORS 与 OPTIONS 预检）**
- `GET /api/widget/config` → 外观配置（**只含公开字段**）
- `POST /api/widget/session` → 建/恢复访客会话，返回 `{ sessionId, visitorToken }`
- `GET /api/widget/messages` → 访客自己的对话记录（只回 user/assistant 纯文本）
- `POST /api/widget/chat` → SSE 流式回答

## 安全模型（这是与后台接口最大的不同）

| 风险 | 处理 |
|---|---|
| 被盗用 | 公开接口必须带**该 agent 的 embedKey**；重置即失效；组件关闭后一律 403 |
| 被别的网站白嫖 | `origins` 白名单：支持完整 origin（含端口）与通配子域 `*.example.com`；**写了协议就精确匹配**（只允许 https 的站点不会被 http 放行）；配了白名单后**没有 Origin 的请求也拒绝** |
| 访客越权触发危险工具 | 访客请求**不接受** `modelOverride`/`toolOverrides`/`allowDangerous`；`onApproval` 恒 `false` → 需要审批的工具（bash 等）一律拒绝 |
| 内部信息外泄 | 公开配置不含 provider/apiKey/instructions/工具/知识库；SSE 流里 `tool_result` **整条丢弃**，`tool_call` 只转成「正在查资料…」这类文案（工具名与参数不进访客视野）；历史接口过滤合成消息与工具消息 |
| 被刷 | 按会话滑动窗口限流（每分钟条数，后台可配）+ 单条消息长度上限 2000 字 |
| 跨访客串号 | 会话用随机 `visitorToken` 绑定；token 不匹配 → 403（拿别人的 sessionId 也读不到记录） |

## SDK 用法

```html
<script src="https://<one-agent 地址>/widget.js"
        data-agent="agent-xxxx" data-key="wk_xxxx" async></script>
```

可选属性：`data-host`（默认取脚本自身域名）、`data-position`、`data-color`、`data-label`、`data-auto-open="true"`。

JS API：

```js
window.OneAgentChat.open();      // 展开
window.OneAgentChat.close();
window.OneAgentChat.toggle();
window.OneAgentChat.isOpen();
window.OneAgentChat.on("unread", (n) => console.log(n));  // 另有 ready / open / close 事件
```

- 面板尺寸 380×600，`@media (max-width:480px)` 时自动全屏
- 未读徽标：面板关闭时收到回复 → 按钮右上角红点计数
- 支持 Escape 关闭、`prefers-reduced-motion`、按钮 `aria-label` / `aria-expanded`
- 本机演示页：`/widget-demo.html?agent=<agentId>&key=<embedKey>`（后台卡片里的「预览效果」直接打开）

## Markdown 渲染

助手回复按 Markdown 渲染（与后台对话页**同一套**：`streamdown` + `@streamdown/cjk`（中文断行）+
`@streamdown/code`（shiki 高亮 + 复制按钮，配色见 `lib/code-theme.ts`））：

- 支持标题 / 列表 / 表格 / 引用 / 链接 / 行内代码 / 代码块（带语法高亮与复制）/ 图片
- 用户消息保持**纯文本**（不把访客输入当标记解析）
- 窄面板适配（`.oa-widget-md` 作用域）：气泡放宽到 92%、表格块内横向滚动、代码块限高 320px 块内滚动、
  标题与列表项间距压缩，`min-width:0` 防长行硬裁
- 主题一致性：面板按 `?theme=` 或 `prefers-color-scheme` 决定明暗后，**同时设置 `data-theme`**
  （globals.css 的代码高亮/面板色变量挂在该属性上）—— 否则访客面板会继承后台管理员的明暗偏好，
  出现「深色面板 + 浅色代码块」这类割裂

## 访客侧体验

- 首次打开显示欢迎语；对话历史存在访客浏览器（localStorage 存 `sessionId + visitorToken`），刷新/重开面板继续同一段对话
- 「正在查资料…」这类状态提示 + 三点动画；回复逐字流式渲染
- 组件未授权/被关闭：面板内显示可读原因（如「来源未授权：https://x.com，请把该域名加入白名单」），而不是白屏

## 验证

- 单测 `one-agent-app/tests/widget.test.ts`（19 例）：来源匹配矩阵（精确/端口/通配子域/伪装域/协议区分/无 Origin）、
  CORS 头、访客事件过滤（工具名与结果不外泄、错误不泄漏上游报错）、限流窗口与隔离、嵌入代码、公开配置不泄漏内部字段、访客会话标记
- API 冒烟 `scripts/smoke-widget-api.py`（34 项，33 通过 + 1 项重跑前置断言）：配置读写与校验、key 校验、会话复用、真实对话、
  历史、错误 token、限流 429、来源白名单、关闭后失效、重置 key 后旧代码失效
- 端到端 `scripts/e2e-widget.py`（26 项全绿，Playwright + 真实 deepseek）：
  宿主页面注入（按钮右下 24px/56×56、`window.OneAgentChat` 可用）、点击展开、欢迎语与占位符按配置、
  发消息拿到真实回复、关闭/重开、**刷新后访客会话恢复**、白名单拦截时面板显示来源未授权、
  **Markdown 渲染**（三级标题 / 三项列表 / 行内代码 / 代码块限高 / 表格 / 无残留标记 / 无横向溢出）
- 明暗两套实测：暗色下正文 12.4:1、代码块文字 16.6:1，`data-theme` 与面板主题一致（代码块底 rgb(11,13,19)）

## 未做（可继续）

- 客服工作台：人工接管（后台把访客会话转给人工）、会话列表按"客服会话"筛选（`session.meta.widget` 已落库，可直接用）
- 文件/图片上传、快捷问题按钮、满意度评价
- 多语言文案、按域名分别配置文案
- 嵌入面板的自定义域名（客户 CNAME 到自己的域名，避免暴露 one-agent 地址）
