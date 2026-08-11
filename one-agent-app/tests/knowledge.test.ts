import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, type KnowledgeChunk } from "../lib/db";
import { chunkText } from "../lib/rag/chunker";
import { hybridSearch, cosineSimilarity } from "../lib/rag/retriever";
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
