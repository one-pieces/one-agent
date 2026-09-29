# Agent 模板与示例资料

## 一、Agent 模板

可直接导入的 agent 配置（`POST /api/agents`，body 就是这个 JSON）。**不含任何密钥** ——
配置里的 `providerId` 指向供应商记录，应用层在保存/运行时解析出 `baseUrl`/`apiKey`。

```bash
# 导入（会创建 id 为 agent-shop-cs 的 agent；id 已存在时返回 409）
curl -X POST http://localhost:3000/api/agents \
  -H 'content-type: application/json' \
  --data-binary @examples/agents/agent-shop-cs.json
```

### agent-shop-cs.json —— 电商平台客服

- 模型：`deepseek-flash`（供应商 DeepSeek），temperature 0.3（客服场景要稳）
- 工具：**全部关闭**（纯知识型客服；接入知识库后 `knowledge_search` 会自动启用）
- 规划规程（planning）关闭：客服不需要多步规划，省 token 也少一次「先想后答」的延迟
- 工具调用守卫保持默认开启
- 系统指令分 12 段：职责范围 / 语气 / 回答结构 / 信息真实性红线 / 做不到的事 /
  索要信息边界 / 转人工升级（含固定格式）/ 工具使用 / 窄屏输出格式 / 边界与拒答 / 风格示例

> 模板里**不含 `knowledgeBaseIds`** —— 知识库 id 属本机数据，导入后请在 Agent 配置页勾选（见下）。
> 勾选后 kernel 会自动把 `knowledge_search` 打开，指令里「先检索再回答」的要求才真正生效。

配套的客服组件文案（标题/欢迎语/占位符）用
`PUT /api/agents/agent-shop-cs/widget` 设置，见 docs/widget-embed-design.md。

## 二、示例知识库资料

`examples/knowledge/示例商城客服知识库/` 是仓库自带的**演示资料**（5 份 Markdown）：

| 文件 | 内容 |
|---|---|
| 退换货政策.md | 7 天无理由的起算与例外品类、运费承担表、退货流程、退款到账时限、换货规则 |
| 配送与物流说明.md | 配送范围、发货时间、参考时效表、运费标准、物流异常处理、签收注意 |
| 支付与发票.md | 支付方式与常见问题、优惠券规则、发票类型与申请流程、价格保护 |
| 商品与保修.md | 参数以什么为准、保修范围与免责、配件耗材、安装、质量问题判定 |
| 常见问题FAQ.md | 订单 / 物流 / 售后 / 发票 / 积分会员的高频问答 + 防骗提醒 |

> ⚠️ **条款与数字都是示例**（每份文件开头也标注了）。上线前请替换成贵司真实规则：
> 改文件重新上传，或直接在知识库页面编辑后重新建索引。

导入步骤（与后台页面操作等价）：

```bash
# 1. 建知识库
curl -X POST http://localhost:3000/api/knowledge -H 'content-type: application/json' \
  -d '{"name":"示例商城客服知识库","description":"电商客服资料"}'

# 2. 上传资料（multipart，字段名固定为 file，支持多文件）
curl -X POST http://localhost:3000/api/knowledge/<kbId>/upload \
  -F "file=@examples/knowledge/示例商城客服知识库/退换货政策.md;filename=退换货政策.md" \
  -F "file=@examples/knowledge/示例商城客服知识库/配送与物流说明.md;filename=配送与物流说明.md"

# 3. 建向量索引（SSE 进度流；每个文件一次，body 带 fileId）
curl -N -X POST http://localhost:3000/api/knowledge/<kbId>/build-index \
  -H 'content-type: application/json' -d '{"fileId":"<fileId>"}'

# 4. 给 agent 关联知识库（勾选后 knowledge_search 自动启用）
curl -X PATCH http://localhost:3000/api/agents/agent-shop-cs \
  -H 'content-type: application/json' -d '{"knowledgeBaseIds":["<kbId>"]}'
```

索引用本地向量模型 `BAAI/bge-m3`（首次自动下载，之后离线可用；缓存位于
`one-agent-app/node_modules/@huggingface/transformers/.cache`），检索是 BM25 + 向量混合 + RRF 融合，
知识库页面可开关 cross-encoder 重排。
