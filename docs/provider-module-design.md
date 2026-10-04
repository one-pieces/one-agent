# 供应商（Provider）模块

## 动机

原先把模型连接配置（provider 类型 / Base URL / API Key）**内联在每个 agent 的表单**里：
换一个密钥要逐个 agent 改，两台机器上的本地模型地址也不一致，同一个 DeepSeek key 在 5 个 agent 里存了 5 份。

现在抽出独立实体：`providers` 表 + `/settings/providers` 管理页（左侧导航底部的「设置」下），agent 只填 `providerId` 与模型 ID。

## 数据模型

```sql
CREATE TABLE providers (
  id, name, kind, base_url, api_key, models, notes, created_at, updated_at
);
```

- `kind`：`openai-compatible` / `anthropic`（对应契约里的 `model.provider`）
- `api_key`：**AES-256-GCM 加密存储**（与 agent 密钥同一套 `lib/crypto.ts`）
- `models`：每行一个模型 ID，第一个是该供应商的默认模型（UI 里作为模型 ID 输入的候选清单）
- 列表接口**不带出明文密钥**，只给 `hasApiKey`；只有 `GET /api/providers/[id]` 与 POST 响应带明文（表单回显用）
- 编辑走**独立页面**（`/settings/providers/[id]`）：服务端取配置后**不下发明文密钥**给浏览器，只给 `hasApiKey` 标记；表单留空提交 = 不修改密钥

## agent 侧语义（契约 `providerId`）

`AgentConfig.providerId?: string` —— **核心运行时忽略该字段**，只消费解析后的 `model`。
语义是"两条路径、同一规则"（`lib/providers.ts` 的 `applyProviderModel`）：

| 时机 | 行为 | 为什么 |
|---|---|---|
| 保存 agent（POST/PATCH、迁移） | **快照**：把供应商的 `kind/baseUrl/apiKey` 写进 `model` | 其它直接读 agent 配置的路径（会话模型覆盖、脚本、导出）拿到的仍是完整配置，不依赖数据库联表 |
| 运行时（`/api/chat`） | **解析**：再用供应商当前值覆盖一遍 | 改了密钥/换地址，引用它的 agent **立即生效**，不用逐个改 agent |

规则细节：
- 供应商的 `baseUrl` 或 `apiKey` 为空 → **保留 agent 里的旧值**（"只是没填"不该把能用的配置清空）
- `modelId` 是 agent 自己的选择；为空时回落到供应商登记的默认模型
- `providerId` 为空（老 agent）= 完全按 `model` 跑，行为与改动前**一字不差**
- `providerId` 指向已删除的供应商 → 按 agent 里的快照跑，不报错

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/providers` | 列表（无明文密钥，带 `hasApiKey`）；顺带跑一次老配置迁移 |
| POST | `/api/providers` | 新建：`{ name, kind?, baseUrl, apiKey?, models?, notes? }` |
| GET | `/api/providers/[id]` | 单个（带明文密钥） |
| PATCH | `/api/providers/[id]` | 更新；`apiKey` **不传 = 不改**，传空串 = 清空 |
| DELETE | `/api/providers/[id]` | 删除；**被 agent 引用时 409** 并列出引用的 agent（避免静默把 agent 打坏） |

校验（API 与 UI 共用 `validateProviderInput`）：`name`/`baseUrl` 必填、`baseUrl` 必须合法 URL、
`kind` 白名单、模型清单接受数组或逗号/分号/换行分隔的文本（去空去重保序）。

## UI

- **`/settings/providers`**（设置页子导航第一项，旧地址 `/providers` 307 重定向到这里）：列表 + 新建/编辑独立页 + 删除。
  - 编辑时**密钥不回填**到表单（避免在页面上暴露明文），留 placeholder「已保存（留空保持不变）」，留空保存 = 不改密钥
  - 删除被引用的供应商 → 页面顶部红色横幅显示具体原因
- **`/agents[/new]` 表单「模型」段**：供应商下拉（显示 `名称（类型 · 已配密钥）`）+ 模型 ID（候选来自供应商登记的清单）+ Temperature + Max Tokens。
  - 选中供应商时**不再显示**内联的 kind/Base URL/API Key（连接配置由供应商统一管理），只显示一行灰色说明：`Base URL: … · 密钥由供应商统一管理`
  - 选「自定义」时恢复内联三字段（旧行为，给不想建 supplier 的一次性场景用）
- **`/agents` 列表**：原来显示 `openai-compatible / model`，现在显示 `供应商名 / model`（可点进供应商页）
- 导航栏新增「供应商」入口

## 老配置自动迁移

`ensureProviderMigration()`（幂等，模块级只跑一次）在 `/api/providers`、`/api/agents` 首次访问时执行：
对每个没有 `providerId` 的 agent，按 `(kind, baseUrl)` **建或找**一条 supplier 记录并写回 `providerId`。
同一端点只建一条 → 多个 agent 自动合并（实测 7 个 agent 合并成 2 条：本地模型 + DeepSeek）。
名字按端点自动起（`autoProviderName`）：本地地址 → `本地模型（localhost:11434）`，云端 → `Deepseek（api.deepseek.com）`，可随时改。

## 验证

- 单测：`one-agent-app/tests/providers.test.ts`（11 例）——摘要不带密钥、无 providerId 不改动、指向不存在的供应商不炸、
  快照/解析规则、空值保留、校验（必填/URL/kind/清单去重）、自动命名
- 端到端：`/tmp/oa_providers_e2e.py`（Playwright + 真实 API，37 项断言全绿）——覆盖
  列表/新建/编辑/删除、**编辑留空不清密钥**、**被引用拒绝删除（409 + 横幅）**、
  agent 表单下拉（引用态隐藏内联字段、切自定义出现内联字段、保存后 providerId 保持）、
  以及**走 provider 解析路径的真实对话**（deepseek 返回 `可用`，会话落库）
- 测试计数：core 155 / app 61，`tsc --noEmit` 通过

## 未做（下一轮可加）

- 「测试连接」按钮（发一次最小 completion 探活）
- 供应商级别的默认 temperature / 限速 / 代理设置
- provider 的 `models` 从端点自动拉取（`GET /v1/models`）
- 会话级切换供应商（目前会话设置只能覆盖模型 ID）
