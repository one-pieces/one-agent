import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, type KnowledgeChunk } from "../lib/db";
import { chunkText, searchKnowledgeChunks } from "../lib/knowledge";
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

describe("知识库：分块与 BM25 检索", () => {
  it("chunkText 长文本切成多块并在边界断开", () => {
    const text = "第一段内容，介绍定价政策。\n\n第二段内容，介绍退款规则。\n\n" + "第三段内容重复".repeat(400);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("定价");
  });

  it("中文 bigram 检索返回相关分块（含来源文件名）", () => {
    const chunks: KnowledgeChunk[] = [
      { id: "1", knowledgeBaseId: "kb", fileId: "f1", chunkIndex: 0, content: "公司定价政策：基础版 99 元每月，专业版 299 元每月。", fileName: "pricing.md" },
      { id: "2", knowledgeBaseId: "kb", fileId: "f1", chunkIndex: 1, content: "退款规则：订阅后 7 天内可申请全额退款。", fileName: "pricing.md" },
      { id: "3", knowledgeBaseId: "kb", fileId: "f2", chunkIndex: 0, content: "公司团建活动安排在下周五下午。", fileName: "events.md" },
    ];
    expect(searchKnowledgeChunks(chunks, "定价是多少钱", 1)[0]?.id).toBe("1");
    expect(searchKnowledgeChunks(chunks, "退款", 1)[0]?.id).toBe("2");
    expect(searchKnowledgeChunks(chunks, "团建", 2)[0]?.fileName).toBe("events.md");
  });
});

describe("知识库：DB CRUD + knowledge_search 工具", () => {
  it("创建 → 上传分块 → 检索工具返回相关片段 → 删除级联", async () => {
    const store = makeStore();
    const kb = store.createKnowledgeBase("产品手册", "内部文档");
    const file = store.addKnowledgeFile(kb.id, "manual.md", 100, [
      "定价政策：基础版 99 元每月。",
      "退款规则：订阅后 7 天内退款。",
    ]);

    expect(store.listKnowledgeFiles(kb.id)).toHaveLength(1);
    expect(store.getChunksForKnowledgeBases([kb.id])).toHaveLength(2);

    const tool = createKnowledgeSearchTool([kb.id], store);
    const r = await tool.execute({}, { query: "退款规则" });
    expect(r.ok).toBe(true);
    expect(String(r.output)).toContain("退款");
    expect(String(r.output)).toContain("manual.md");

    // 删除文件 → 分块联动删除
    store.deleteKnowledgeFile(kb.id, file.id);
    expect(store.getChunksForKnowledgeBases([kb.id])).toHaveLength(0);

    // 删除知识库 → 级联删除文件与分块
    store.addKnowledgeFile(kb.id, "manual2.md", 10, ["内容A"]);
    store.deleteKnowledgeBase(kb.id);
    expect(store.getKnowledgeBase(kb.id)).toBeNull();
    expect(store.listKnowledgeFiles(kb.id)).toHaveLength(0);
  });
});
