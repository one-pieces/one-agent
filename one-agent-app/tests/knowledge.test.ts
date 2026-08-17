import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, decodeEmbedding, embeddingToBlob, type KnowledgeChunk } from "../lib/db";
import { chunkText } from "../lib/rag/chunker";
import { hybridSearch, cosineSimilarity, vectorSearch } from "../lib/rag/retriever";
import { buildFileIndex, searchKnowledge } from "../lib/rag/indexer";
import { createKnowledgeSearchTool } from "../lib/knowledge-tool";

const dirs: string[] = [];
function makeStore(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "one-agent-kb-"));
  dirs.push(dir);
  return new AppDatabase(join(dir, "test.db"));
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 假 embedder：字符哈希到固定维度向量（语义近似按共同字符数） */
const fakeEncode = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    const v = new Array<number>(16).fill(0);
    for (const ch of t.replace(/\s+/g, "")) v[ch.charCodeAt(0) % 16] += 1;
    return v;
  });

describe("RAG：分块与检索", () => {
  it("chunkText 结构感知切分（第N条边界优先）", () => {
    const text = "第一条 定价政策。基础版每月99元。\n\n第二条 退款规则。订阅后7天内可退。";
    const chunks = chunkText(text, 512, 50, "manual.md");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.source).toBe("manual.md");
    const joined = chunks.map((c) => c.text).join("");
    expect(joined).toContain("定价");
    expect(joined).toContain("退款");
  });

  it("hybridSearch：BM25 + 向量双路 RRF 融合", () => {
    const chunks: KnowledgeChunk[] = [
      { id: "1", knowledgeBaseId: "kb", fileId: "f", chunkIndex: 0, content: "公司定价政策：基础版 99 元每月。", fileName: "pricing.md" },
      { id: "2", knowledgeBaseId: "kb", fileId: "f", chunkIndex: 1, content: "退款规则：订阅后 7 天内可申请全额退款。", fileName: "pricing.md" },
      { id: "3", knowledgeBaseId: "kb", fileId: "f", chunkIndex: 2, content: "公司团建活动安排在下周五下午。", fileName: "events.md" },
    ];
    // 纯 BM25（无向量）
    expect(hybridSearch(chunks, [], "退款", null, { topK: 1 })[0]?.chunk.id).toBe("2");
    // 向量路（query 向量指向 chunk3 语义）与 BM25 融合
    const vectors = [
      { chunk: chunks[0]!, embedding: [1, 0, 0, 0] },
      { chunk: chunks[1]!, embedding: [0, 1, 0, 0] },
      { chunk: chunks[2]!, embedding: [0, 0, 1, 0] },
    ];
    const qv = [0, 0, 1, 0];
    expect(cosineSimilarity(qv, [0, 0, 1, 0])).toBe(1);
    const fused = hybridSearch(chunks, vectors, "团建", qv, { topK: 1 });
    expect(fused[0]?.chunk.id).toBe("3");
  });
});

describe("RAG：索引构建与检索（假 embedder）", () => {
  it("上传 → buildFileIndex → done，向量落库，混合检索命中", async () => {
    const store = makeStore();
    const kb = store.createKnowledgeBase("产品手册", "内部文档", "sqlite", false);
    const file = store.addKnowledgeFile(kb.id, "manual.md", 100, "第一条 定价政策：基础版99元每月。\n\n第二条 退款规则：7天内可退款。");
    expect(file.indexStatus).toBe("none");

    const progress: number[] = [];
    const result = await buildFileIndex(kb.id, file.id, (p) => progress.push(p.percent), { encode: fakeEncode }, store);
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(100);

    const stored = store.getKnowledgeFile(kb.id, file.id)!;
    expect(stored.indexStatus).toBe("done");
    expect(stored.chunkCount).toBe(result.chunkCount);
    expect(store.getEmbeddingsForKnowledgeBases([kb.id]).length).toBe(result.chunkCount);

    const hits = await searchKnowledge([kb.id], "退款", { topK: 1, store, deps: { encode: fakeEncode } });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.content).toContain("退款");
  });

  it("索引失败 → 状态 error 并带错误信息", async () => {
    const store = makeStore();
    const kb = store.createKnowledgeBase("空库");
    const file = store.addKnowledgeFile(kb.id, "empty.md", 0, "   \n  ");
    await expect(buildFileIndex(kb.id, file.id, undefined, { encode: fakeEncode }, store)).rejects.toThrow();
    expect(store.getKnowledgeFile(kb.id, file.id)!.indexStatus).toBe("error");
  });

  it("knowledge_search 工具：混合检索返回带来源的片段", async () => {
    const store = makeStore();
    const kb = store.createKnowledgeBase("手册");
    const file = store.addKnowledgeFile(kb.id, "guide.md", 100, "使用说明：先注册账号，再创建项目。");
    await buildFileIndex(kb.id, file.id, undefined, { encode: fakeEncode }, store);

    const tool = createKnowledgeSearchTool([kb.id], store, { encode: fakeEncode });
    const r = await tool.execute({}, { query: "怎么创建项目" });
    expect(r.ok).toBe(true);
    expect(String(r.output)).toContain("创建项目");
    expect(String(r.output)).toContain("guide.md");
  });

  it("删除文件/知识库级联清理向量", async () => {
    const store = makeStore();
    const kb = store.createKnowledgeBase("手册");
    const file = store.addKnowledgeFile(kb.id, "a.md", 10, "内容A");
    await buildFileIndex(kb.id, file.id, undefined, { encode: fakeEncode }, store);
    expect(store.countEmbeddings(kb.id)).toBeGreaterThan(0);

    store.deleteKnowledgeFile(kb.id, file.id);
    expect(store.countEmbeddings(kb.id)).toBe(0);
    expect(store.listKnowledgeFiles(kb.id)).toHaveLength(0);

    store.addKnowledgeFile(kb.id, "b.md", 10, "内容B");
    await buildFileIndex(kb.id, store.listKnowledgeFiles(kb.id)[0]!.id, undefined, { encode: fakeEncode }, store);
    store.deleteKnowledgeBase(kb.id);
    expect(store.getKnowledgeBase(kb.id)).toBeNull();
    expect(store.getEmbeddingsForKnowledgeBases([kb.id])).toHaveLength(0);
  });
});

describe("向量存储：BLOB 落库与检索缓存", () => {
  it("replaceEmbeddings 以 BLOB（Float32Array 二进制）落库，decodeEmbedding 还原", () => {
    const store = makeStore();
    const kb = store.createKnowledgeBase("kb");
    const file = store.addKnowledgeFile(kb.id, "f.md", 10, "内容");
    store.replaceFileChunks(kb.id, file.id, ["块1", "块2"]);
    const chunks = store.getChunksForFile(kb.id, file.id);

    store.replaceEmbeddings(kb.id, file.id, [
      { chunkId: chunks[0]!.id, embedding: [0.5, -0.25, 1.0] },
      { chunkId: chunks[1]!.id, embedding: [-0.5, 0.25, 1.0] },
    ]);

    // 原始行应为 BLOB（Uint8Array），而非旧版 JSON 字符串
    const rows = store.getEmbeddingsForKnowledgeBases([kb.id]);
    expect(rows.length).toBe(2);
    expect(rows[0]!.embedding).toBeInstanceOf(Uint8Array);
    expect(typeof rows[0]!.embedding).not.toBe("string");

    const v = decodeEmbedding(rows[0]!.embedding);
    expect(v).toBeInstanceOf(Float32Array);
    expect(Array.from(v)).toEqual([0.5, -0.25, 1.0]); // 均为 Float32 可精确表示的值
    expect(Array.from(decodeEmbedding(rows[1]!.embedding))).toEqual([-0.5, 0.25, 1.0]);
  });

  it("embeddingToBlob / decodeEmbedding 兼容旧版 JSON 文本向量", () => {
    const legacy = JSON.stringify([0.5, -0.25, 1.5]);
    expect(Array.from(decodeEmbedding(legacy))).toEqual([0.5, -0.25, 1.5]);
    // 空值安全
    expect(decodeEmbedding(null).length).toBe(0);
    expect(decodeEmbedding(undefined).length).toBe(0);
    // 编解码往返
    const blob = embeddingToBlob([1, 2, 3, 4]);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(blob.byteLength).toBe(16); // 4 维 × 4B
    expect(Array.from(decodeEmbedding(blob))).toEqual([1, 2, 3, 4]);
  });

  it("getVectorChunks 命中缓存（同一引用），写入后按版本失效重建", () => {
    const store = makeStore();
    const kb = store.createKnowledgeBase("kb");
    const f1 = store.addKnowledgeFile(kb.id, "a.md", 10, "内容A");
    store.replaceFileChunks(kb.id, f1.id, ["块A"]);
    const c1 = store.getChunksForFile(kb.id, f1.id);
    store.replaceEmbeddings(kb.id, f1.id, [{ chunkId: c1[0]!.id, embedding: [1, 0, 0] }]);

    const v1 = store.getVectorChunks([kb.id]);
    const v2 = store.getVectorChunks([kb.id]);
    expect(v2).toBe(v1); // 命中缓存：同一引用，未重复解码

    // 写入新文件 → version 自增 → 缓存失效重建
    const f2 = store.addKnowledgeFile(kb.id, "b.md", 10, "内容B");
    store.replaceFileChunks(kb.id, f2.id, ["块B"]);
    const c2 = store.getChunksForFile(kb.id, f2.id);
    store.replaceEmbeddings(kb.id, f2.id, [{ chunkId: c2[0]!.id, embedding: [0, 1, 0] }]);

    const v3 = store.getVectorChunks([kb.id]);
    expect(v3).not.toBe(v1);
    expect(v3.length).toBe(2);
    // 文件行按随机 id 排序，不保证插入序 → 按 fileId 定位断言
    const b = v3.find((x) => x.chunk.fileId === f2.id)!;
    const a = v3.find((x) => x.chunk.fileId === f1.id)!;
    expect(Array.from(b.embedding)).toEqual([0, 1, 0]);
    expect(Array.from(a.embedding)).toEqual([1, 0, 0]);
  });

  it("vectorSearch 有界 top-N 与全量排序结果一致", () => {
    const chunks: KnowledgeChunk[] = [0, 1, 2, 3, 4].map((i) => ({
      id: String(i),
      knowledgeBaseId: "kb",
      fileId: "f",
      chunkIndex: i,
      content: `块${i}`,
    }));
    const vectors = chunks.map((chunk, i) => ({
      chunk,
      // 方向随 i 向 query 靠拢：similarity = (i+1)/sqrt((i+1)²+1)，严格递增
      embedding: new Float32Array(16).fill(0).map((_, d) => (d === 0 ? i + 1 : d === 1 ? 1 : 0)),
    }));
    const q = new Float32Array(16).fill(0);
    q[0] = 1;
    const top = vectorSearch(vectors, q, 3);
    expect(top.map((c) => c.id)).toEqual(["4", "3", "2"]);
  });
});
