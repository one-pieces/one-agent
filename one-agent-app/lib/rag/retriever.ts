import type { KnowledgeChunk } from "../db";

/**
 * 混合检索（移植 eve-agent rag/src/retriever.ts）：
 * BM25 关键词路（按字切词，中文友好）+ 向量语义路（余弦相似度），两路用 RRF 融合。
 */

export interface VectorChunk {
  chunk: KnowledgeChunk;
  embedding: number[];
}

export interface ScoredChunk {
  chunk: KnowledgeChunk;
  score: number;
}

// ─── 分词（字级） ───
function tokenize(text: string): string[] {
  return text.replace(/\s+/g, "").split("");
}

// ─── BM25 ───
class BM25 {
  private docs: string[][];
  private N: number;
  private avgdl: number;
  private df = new Map<string, number>();
  private k1: number;
  private b: number;

  constructor(docsTokens: string[][], k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.docs = docsTokens;
    this.N = docsTokens.length;
    this.avgdl = this.N > 0 ? docsTokens.reduce((s, d) => s + d.length, 0) / this.N : 0;
    for (const doc of docsTokens) {
      for (const t of new Set(doc)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  scores(query: string): number[] {
    const q = tokenize(query);
    return this.docs.map((doc) => {
      let score = 0;
      const dl = doc.length;
      for (const t of q) {
        const f = doc.filter((w) => w === t).length;
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
        const tf = (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * dl) / (this.avgdl || 1)));
        score += idf * tf;
      }
      return score;
    });
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 向量路：对 queryEmbedding 做余弦检索 */
export function vectorSearch(vectors: VectorChunk[], queryEmbedding: number[], topN: number): KnowledgeChunk[] {
  return vectors
    .map((v) => ({ chunk: v.chunk, score: cosineSimilarity(queryEmbedding, v.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((s) => s.chunk);
}

/**
 * 混合检索：BM25 + 向量（可选）双路召回，RRF 融合。
 * @param chunks 全部文本分块（BM25 路）
 * @param vectors 已建索引的向量（向量路，为空则退化为纯 BM25）
 * @param queryEmbedding 查询向量（向量路需要；未提供则跳过向量路）
 */
export function hybridSearch(
  chunks: KnowledgeChunk[],
  vectors: VectorChunk[],
  query: string,
  queryEmbedding: number[] | null,
  opts: { topK?: number; topN?: number; rrfK?: number } = {},
): ScoredChunk[] {
  const { topK = 5, topN = 20, rrfK = 60 } = opts;
  const rankedLists: KnowledgeChunk[][] = [];

  if (vectors.length > 0 && queryEmbedding) {
    rankedLists.push(vectorSearch(vectors, queryEmbedding, topN));
  }

  if (chunks.length > 0) {
    const bm25 = new BM25(chunks.map((c) => tokenize(c.content)));
    const scores = bm25.scores(query);
    const order = scores
      .map((score, idx) => ({ score, idx }))
      .sort((a, b) => b.score - a.score)
      .filter((x) => x.score > 0)
      .slice(0, topN);
    rankedLists.push(order.map((x) => chunks[x.idx]));
  }

  // RRF 融合
  const fused = new Map<string, number>();
  const byKey = new Map<string, KnowledgeChunk>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const c = list[rank];
      const k = c.id;
      fused.set(k, (fused.get(k) ?? 0) + 1.0 / (rrfK + rank + 1));
      if (!byKey.has(k)) byKey.set(k, c);
    }
  }

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([k, score]) => ({ chunk: byKey.get(k)!, score }));
}
