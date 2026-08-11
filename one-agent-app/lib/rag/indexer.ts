import { db, type AppDatabase } from "../db";
import { chunkText } from "./chunker";
import { encodeTexts } from "./embedder";
import { hybridSearch, type ScoredChunk, type VectorChunk } from "./retriever";
import { rerank as rerankDefault } from "./reranker";

/**
 * 每个文件的向量索引构建（对齐 eve build-index 流程）：
 *   读文件原文 → 结构感知分块 → 逐块向量化（进度回调）→ 写入 SQLite 向量表 → 更新文件状态。
 * 状态机：none → building → done / error（含耗时与错误信息）。
 */
export interface BuildProgress {
  percent: number;
  done: number;
  total: number;
  message: string;
}

export interface IndexDeps {
  /** 测试注入假 embedder；缺省用本地 Transformers.js */
  encode?: (texts: string[]) => Promise<number[][]>;
}

export async function buildFileIndex(
  kbId: string,
  fileId: string,
  onProgress?: (p: BuildProgress) => void,
  deps: IndexDeps = {},
  store: AppDatabase = db,
): Promise<{ chunkCount: number; durationMs: number }> {
  const file = store.getKnowledgeFile(kbId, fileId);
  if (!file) throw new Error("文件不存在");

  store.updateKnowledgeFileStatus(fileId, { indexStatus: "building", indexError: null });
  const start = Date.now();
  const encode = deps.encode ?? encodeTexts;

  try {
    if (!file.content.trim()) throw new Error("文件内容为空");
    onProgress?.({ percent: 0, done: 0, total: 0, message: "正在解析文档…" });
    const chunks = chunkText(file.content, 512, 50, file.name);
    if (chunks.length === 0) throw new Error("文件内容为空（切分后无有效分块）");
    store.replaceFileChunks(kbId, fileId, chunks.map((c) => c.text));
    const chunkRows = store.getChunksForFile(kbId, fileId);

    onProgress?.({ percent: 5, done: 0, total: chunks.length, message: `文档解析完成，共 ${chunks.length} 个分块` });

    const entries: Array<{ chunkId: string; embedding: number[] }> = [];
    for (let i = 0; i < chunks.length; i++) {
      const [vec] = await encode([chunks[i]!.text]);
      entries.push({ chunkId: chunkRows[i]!.id, embedding: vec });
      onProgress?.({
        percent: Math.round(5 + ((i + 1) / chunks.length) * 90),
        done: i + 1,
        total: chunks.length,
        message: `向量化中 ${i + 1}/${chunks.length}`,
      });
    }

    store.replaceEmbeddings(kbId, fileId, entries);
    const durationMs = Date.now() - start;
    store.updateKnowledgeFileStatus(fileId, {
      indexStatus: "done",
      chunkCount: chunks.length,
      indexedAt: new Date().toISOString(),
      indexDurationMs: durationMs,
    });
    onProgress?.({ percent: 100, done: chunks.length, total: chunks.length, message: "索引构建完成" });
    return { chunkCount: chunks.length, durationMs };
  } catch (err) {
    store.updateKnowledgeFileStatus(fileId, {
      indexStatus: "error",
      indexError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * 知识库检索编排：BM25 + 向量双路 RRF，可选 cross-encoder 重排。
 * deps 可注入假 embedder/reranker（测试用）。
 */
export interface SearchDeps {
  encode?: (texts: string[]) => Promise<number[][]>;
  rerankImpl?: typeof rerankDefault;
}

export async function searchKnowledge(
  kbIds: string[],
  query: string,
  opts: { topK?: number; useRerank?: boolean; deps?: SearchDeps; store?: AppDatabase } = {},
): Promise<ScoredChunk[]> {
  const { topK = 5, useRerank = false, deps = {}, store = db } = opts;
  const chunks = store.getChunksForKnowledgeBases(kbIds);
  const vectors: VectorChunk[] = store
    .getEmbeddingsForKnowledgeBases(kbIds)
    .map((r) => ({
      chunk: {
        id: r.chunkId,
        knowledgeBaseId: r.knowledgeBaseId,
        fileId: r.fileId,
        chunkIndex: r.chunkIndex,
        content: r.content,
        fileName: r.fileName,
      },
      embedding: JSON.parse(r.embedding) as number[],
    }));

  // 查询向量：有索引才需要；embedder 失败（如模型未下载）时降级为纯 BM25
  let queryEmbedding: number[] | null = null;
  if (vectors.length > 0) {
    try {
      const encode = deps.encode ?? (await import("./embedder")).encodeTexts;
      [queryEmbedding] = await encode([query]);
    } catch {
      queryEmbedding = null;
    }
  }

  let results = hybridSearch(chunks, vectors, query, queryEmbedding, { topK: useRerank ? Math.max(topK, 20) : topK });

  if (useRerank && results.length > 0) {
    try {
      const rerankImpl = deps.rerankImpl ?? rerankDefault;
      results = await rerankImpl(query, results, topK);
    } catch {
      // 重排模型加载失败 → 保持 RRF 结果
    }
  }
  return results;
}
