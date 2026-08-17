# 向量库：SQLite 方案分析与优化

> 日期：2026-08-17
> 范围：`one-agent-app` 知识库 RAG 的向量存储与检索
> 结论先行：当前 SQLite + 内存暴力扫描方案在「小数量级」完全够用；本次已落地四项低成本优化（BLOB 落库 / 检索缓存 / TypedArray 余弦 / BM25 复用 + 有界 top-N），把容量上限从「几万分块」提到「几十万分块」；再往上再考虑 sqlite-vec / LanceDB / pgvector 等。

---

## 0. 交付摘要

### 交付物

| # | 交付物 | 说明 |
|---|---|---|
| 1 | 本文档 | 问题分析与优化记录（`docs/向量库SQLite方案分析与优化.md`） |
| 2 | 代码优化 | 6 个文件，+261 / -53 行（见下表） |
| 3 | 测试 | 新增 4 条用例，全量 25/25 通过 |

### 代码改动清单

| 文件 | 改动 |
|---|---|
| `one-agent-app/lib/db.ts` | 向量改 **BLOB 落库**（Float32Array 二进制，4B/维）；`decodeEmbedding` 透明兼容旧 JSON 文本（**无需数据迁移**）；新增版本化检索缓存 `getVectorChunks`（加载一次、跨查询复用，写入自动失效） |
| `one-agent-app/lib/rag/retriever.ts` | 余弦兼容 TypedArray；`vectorSearch` 改**有界 top-N 插入选择**（替代全量 sort）；BM25 拆出 `buildBM25` 可复用 |
| `one-agent-app/lib/rag/indexer.ts` | 检索走缓存 + **BM25 跨查询复用**（WeakMap 按 store 隔离，版本失效） |
| `app/api/knowledge/[id]/index/route.ts` | 向量预览改用 `decodeEmbedding`，新旧格式都能显示 |
| `app/api/knowledge/[id]/files/[fileId]/chunks/route.ts` | 同上 |
| `one-agent-app/tests/knowledge.test.ts` | 新增 4 条用例（BLOB 落库、旧 JSON 兼容、缓存命中/失效、top-N 一致性） |

### 实测收益（20,000 × 1024 维基准）

| 项 | 改造前 | 改造后 | 提升 |
|---|---|---|---|
| 单向量存储 | JSON ~19.8KB | BLOB 4.0KB | **5 倍** 磁盘 |
| 全库解析 | JSON.parse ~598ms | BLOB 解码 ~7.5ms | **~85 倍** |
| 单次查询向量路 | ~620ms | ~25ms | **~20 倍** |
| 向量常驻内存 | number[] 8KB/维 | Float32Array 4KB/维 | **减半** |

改造后单机容量上限从「几万分块」提到约 **50 万分块**（常驻 ~2GB、单查 ~600ms）。

### 验证状态

- `pnpm typecheck` ✅ 无错误
- `pnpm test` ✅ 25/25 全绿（4 个测试文件）

> 说明：基准中 Float32Array 扫描（~24ms）与 number[] 扫描（~18ms）同数量级，收益主要来自「去掉每次查询的 JSON.parse + 缓存复用 + 存储减半 + top-N 有界选择」，而非扫描循环本身；文档第 6.3 节有详细数据。

---

## 1. 问题背景

原提问（整理）：

> 现在向量数据库用来 SQLite，相比于传统向量数据库，这有什么问题？目前实现好像是在内存里做向量匹配，这样做在数量级小的时候还行，但一旦知识库内容巨大，内存压力会很大。

这是一个非常准确的观察。本文先诊断现状，再对比 SQLite 与传统向量库的差距，给出量化分析，最后记录本次落地的优化与基准数据。

---

## 2. 现状诊断（改造前）

检索路径（`one-agent-app/lib/rag/indexer.ts` → `searchKnowledge`）：

```
① getChunksForKnowledgeBases(kbIds)     全量拉取所有分块文本（BM25 语料）
② getEmbeddingsForKnowledgeBases(kbIds) 全量拉取所有向量（JSON 字符串）
③ JSON.parse 每一个向量                 每次查询都全量解析
④ 纯 JS 双层 for 循环算余弦             逐元素扫描全部向量
⑤ 全量 sort 取 top-N                     O(N log N)
⑥ new BM25(chunks.map(tokenize))        每次查询重建 BM25 索引（全库分词 + df 统计）
```

### 2.1 三个隐藏问题

1. **向量以 JSON 文本存储**（`db.ts` 原 `embedding TEXT` + `JSON.stringify`）。
   bge-m3 是 1024 维，一个向量 JSON 文本约 **20KB**，二进制 float32 只要 **4KB**——存储膨胀约 5 倍，且每次查询要全量 `JSON.parse`。

2. **BM25 每次查询全量重建**。`new BM25(chunks.map(tokenize))` 对全库重新分词、重建 df 统计，是一条与向量路同级的 O(N) 开销，容易被忽略。

3. **每次查询的内存峰值 = 全部分块文本 + 全部向量 JSON 文本 + 全部解析后的数组**，三重叠加，且查询结束才释放（GC 压力 + 延迟抖动）。

### 2.2 内存压力量化（按 1024 维实测）

| 分块数 | JSON 存储占盘（≈20KB/向量） | 单次查询 JSON.parse 耗时 | 解析后内存（float32） |
|---|---|---|---|
| 1 万 | ~200MB | ~0.3s | ~40MB |
| 10 万 | ~2GB | ~3s | ~400MB |
| 100 万 | ~20GB | ~30s | ~4GB（不可行） |

> 实测：20,000 × 1024 维，仅 `JSON.parse` 全库 ≈ **598ms**；BLOB 解码全库 ≈ **7.5ms**（约 85 倍差距）。

---

## 3. SQLite 当向量库 vs 传统向量数据库

| 维度 | 原 SQLite 方案 | 传统向量库（Milvus/Qdrant/pgvector） |
|---|---|---|
| 索引结构 | 无，只能全表扫描 O(N) | HNSW（图）/ IVF（倒排）/ DiskANN（磁盘） |
| 距离计算 | JS 逐元素循环 | C++/SIMD/GPU，批量矩阵运算 |
| 存储格式 | JSON 文本，膨胀 ~5 倍 | 二进制 float32 / 量化压缩（PQ 可压到 1/4~1/32） |
| 内存模型 | 每次查询全量载入 + 全量解析 | mmap 页缓存 + 索引剪枝，不用全量驻留 |
| 近似检索 | 不支持（只能精确暴力） | ANN：牺牲 ~1% 召回换 10~100 倍速度 |
| 并发 | 单写者锁，索引构建时阻塞读 | 多副本/分片，读写分离 |
| 横向扩展 | 单文件，无法分片 | 分布式，亿级向量 |

核心差异一句话：**SQLite 的 B-tree 是为「等值/范围查询」设计的，它对高维向量的距离计算毫无帮助**——数据库本身做不了任何剪枝，向量检索退化成「存储层 + 手写暴力扫描」。传统向量库的价值不在「存」，而在「索引」：HNSW 用图结构让每次查询只访问几百个节点而不是全库，IVF 先粗聚类再只搜最近几个桶，DiskANN 把向量放 SSD 上只把图放内存。

---

## 4. 误区澄清

「在内存里做向量匹配」本身不是问题——**FAISS 的 HNSW 也是纯内存的**。问题在于原方案「全量、无索引、每次查询重新解析」三件事叠加：

- 传统向量库是**加载一次、常驻内存、查询走索引剪枝**；
- 原方案是**每次查询全量拉取、全量解析、全量扫描**——内存压力不是「知识库大」导致的，而是「没有索引 + 没有缓存 + 存储格式膨胀」三合一。

所以正确的判断顺序是：**先榨干 SQLite 方案（成本最低），规模真的上去了再换库**。

---

## 5. 分级建议（规模阶梯）

| 层级 | 规模 | 方案 | 运维成本 |
|---|---|---|---|
| L1 | < 5 万分块 | SQLite + BLOB + 内存缓存（**本次已落地**） | 零（现状） |
| L2 | 几十万 | sqlite-vec 扩展（C 实现 HNSW）/ LanceDB / Chroma | 零～低（嵌入式） |
| L3 | 百万+ / 多实例 | pgvector（已在用 Postgres 时）/ Qdrant / Milvus | 中～高（独立服务） |

本项目是单机 Next.js + 本地 bge-m3 向量化，面向个人/小团队知识库，**大概率长期停留在 L1**。现阶段直接上 Milvus/Qdrant 属于过度设计——多一个要运维的服务，收益趋近于零。

---

## 6. 本次落地的优化（L1 内实现）

### 6.1 改动清单

| 文件 | 改动 |
|---|---|
| `one-agent-app/lib/db.ts` | ① `knowledge_embeddings.embedding` 列 TEXT → BLOB（Float32Array 二进制）；② 新增 `embeddingToBlob` / `decodeEmbedding`（兼容旧 JSON 文本）；③ 新增版本化检索缓存：`getChunksForKnowledgeBases` / `getVectorChunks` 按 `dataVersion` 失效；④ 所有 chunk/向量写操作自增 `version` |
| `one-agent-app/lib/rag/retriever.ts` | ① 余弦计算兼容 `Float32Array`；② `vectorSearch` 改用**有界 top-N 插入选择**替代全量 sort；③ BM25 拆出 `buildBM25` / `bm25Search` / `hybridSearchWithBm25`，索引可跨查询复用 |
| `one-agent-app/lib/rag/indexer.ts` | `searchKnowledge` 走 store 缓存（`getVectorChunks`）+ BM25 按「store 实例 × 知识库」缓存（WeakMap，版本失效） |
| `app/api/knowledge/[id]/index/route.ts` | 向量预览改用 `decodeEmbedding`（兼容新旧格式） |
| `app/api/knowledge/[id]/files/[fileId]/chunks/route.ts` | 同上 |

### 6.2 关键设计

**BLOB 存储（向后兼容，无需迁移）**
- 新写入：`embeddingToBlob(number[])` → `Uint8Array`（float32 二进制，4B/维）。
- 读取：`decodeEmbedding` 自动识别——`string` 走旧 `JSON.parse`，`Uint8Array` 直接按 buffer 解码。
- 旧数据无需一次性迁移：老行读时按 JSON 解析，文件重新建索引后自动转 BLOB。SQLite 的 TEXT 亲和列存 BLOB 会原样存储/读回（已验证）。

**版本化检索缓存（加载一次、跨查询复用）**
- `AppDatabase` 内维护 `version`，`replaceFileChunks` / `replaceEmbeddings` / `deleteFileIndex` / `deleteKnowledgeFile` / `deleteKnowledgeBase` 自增。
- `getVectorChunks(kbIds)` 首次查询解码并缓存 `StoredVector[]`（embedding 为 `Float32Array`），后续查询直接命中同一引用（测试断言 `toBe` 同一引用）；写入后版本变化自动失效重建。
- 缓存键 `kbCacheKey` 对 kbIds 排序，与传入顺序无关。

**BM25 复用**
- `buildBM25(chunks)` 构建一次，`hybridSearchWithBm25` 复用；`indexer` 里按 `WeakMap<AppDatabase, Map<kbKey, {v, bm25}>>` 缓存，`dataVersion` 变化时重建。WeakMap 按 store 实例隔离（测试/多进程互不污染），且不会泄漏。

**有界 top-N 选择**
- `vectorSearch` 不再全量 `sort`（O(N log N)），改为维护降序 top-N 下标的插入选择（O(N·topN)，topN 通常 ≤ 20），结果与全量排序一致（测试覆盖）。

### 6.3 基准数据（本机快速基准，20,000 × 1024 维）

| 项 | 改造前 | 改造后 | 提升 |
|---|---|---|---|
| 单向量存储 | JSON ~19.8KB | BLOB 4.0KB | **5.0x** 磁盘 |
| 全库解析 | JSON.parse ~598ms | BLOB 解码 ~7.5ms | **~85x** |
| 单次查询向量路 | ~598ms(parse) + ~18ms(扫描) + ~4ms(sort) | 0ms(缓存) + ~24ms(扫描) + ~0.5ms(top-N) | **~20x 单查询** |
| 向量内存 | number[] 8KB/向量 | Float32Array 4KB/向量 | **2x** 常驻 |
| BM25 | 每次查询重建（全库分词） | 缓存复用，版本失效 | 查询间 ~0 |

> 注：`Float32Array` 扫描（24ms）与 `number[]` 扫描（18ms）同数量级，本方案收益主要来自「去掉每次查询的 JSON.parse + 缓存复用 + 存储减半 + top-N 有界选择」，而非扫描循环本身。

### 6.4 容量上限推算（改造后）

按 1024 维、float32、常驻缓存：

| 分块数 | 常驻内存（向量） | 单次查询耗时（扫描 + top-N） |
|---|---|---|
| 10 万 | ~400MB | ~120ms |
| 50 万 | ~2GB | ~600ms |
| 100 万 | ~4GB | ~1.2s |

单机 50 万级内体验良好；超过后进入 L2（sqlite-vec / LanceDB）。

---

## 7. 测试

`tests/knowledge.test.ts` 新增 4 条用例（共 25 条全绿）：

1. `replaceEmbeddings 以 BLOB 落库，decodeEmbedding 还原` —— 断言原始行为 `Uint8Array`（非 JSON 字符串）、解码值正确；
2. `embeddingToBlob / decodeEmbedding 兼容旧版 JSON 文本向量` —— 旧格式字符串、空值安全、编解码往返；
3. `getVectorChunks 命中缓存（同一引用），写入后按版本失效重建` —— 缓存命中 `toBe` 同一引用，写入新文件后重建且数据正确；
4. `vectorSearch 有界 top-N 与全量排序结果一致` —— 构造严格递增相似度序列，验证 top-3 顺序。

验证命令：`pnpm typecheck` + `pnpm test`（4 个测试文件 25 条全部通过）。

---

## 8. 后续可选方向（L2 / L3）

1. **sqlite-vec**（`asg017/sqlite-vec`）：纯 SQLite 扩展，C 实现暴力检索与 HNSW，数据不用迁出，只改查询层——L2 首选。
2. **LanceDB / Chroma**：嵌入式、文件型、自带 HNSW，对 Next.js 单机应用近乎 drop-in。
3. **pgvector**：若项目已用 Postgres，几十万到百万级表现良好且运维简单。
4. **Qdrant / Milvus**：面向真正大规模 / 多实例，引入独立服务，现阶段不推荐。

---

## 附录：本次改动文件 diff 摘要

- `lib/db.ts`：`embedding` 列 TEXT→BLOB；新增 `embeddingToBlob`/`decodeEmbedding`/`kbCacheKey`/`getVectorChunks`/`getDataVersion`；`version` 缓存失效机制；类型拓宽（`embedding: string | Uint8Array`，新增 `StoredVector`）。
- `lib/rag/retriever.ts`：`BM25` 导出；新增 `buildBM25`/`bm25Search`/`hybridSearchWithBm25`；`vectorSearch` 有界 top-N；`cosineSimilarity` 兼容 TypedArray；`hybridSearch` 保持原签名（便捷入口）。
- `lib/rag/indexer.ts`：`searchKnowledge` 使用 `getVectorChunks` + BM25 缓存（WeakMap 按 store 隔离）。
- 两个 API 路由：`JSON.parse` → `decodeEmbedding`。
- `tests/knowledge.test.ts`：新增 4 条 BLOB/缓存/top-N 用例。
