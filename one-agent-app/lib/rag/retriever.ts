import type { KnowledgeChunk } from "../db";

/**
 * 混合检索（移植 eve-agent rag/src/retriever.ts）：
 * BM25 关键词路（按字切词，中文友好）+ 向量语义路（余弦相似度），两路用 RRF 融合。
 *
 * 性能要点（2026-08 优化）：
 * - 余弦计算兼容 Float32Array（检索缓存直接给 TypedArray，避免 number[] 装箱开销）；
 * - vectorSearch 用有界 top-N 插入选择替代全量 sort（O(N·topN) ≈ O(N·20)，远快于 O(N log N)）；
 * - BM25 拆出 buildBM25 / hybridSearchWithBm25，索引可跨查询复用（避免每次重建分词/df）。
 */

export interface VectorChunk {
  chunk: KnowledgeChunk;
  embedding: number[] | Float32Array;
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
export class BM25 {
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

/** 构建可复用的 BM25 索引（高频检索请缓存，避免每次查询重新分词） */
export function buildBM25(chunks: KnowledgeChunk[]): BM25 {
  return new BM25(chunks.map((c) => tokenize(c.content)));
}

/** BM25 路：对 query 做关键词检索，返回 topN 命中分块 */
export function bm25Search(bm25: BM25, chunks: KnowledgeChunk[], query: string, topN: number): KnowledgeChunk[] {
  const scores = bm25.scores(query);
  const order = scores
    .map((score, idx) => ({ score, idx }))
    .sort((a, b) => b.score - a.score)
    .filter((x) => x.score > 0)
    .slice(0, topN);
  return order.map((x) => chunks[x.idx]!);
}

export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
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

/** 向量路：对 queryEmbedding 做余弦检索（有界 top-N 选择，避免全量 sort） */
export function vectorSearch(
  vectors: VectorChunk[],
  queryEmbedding: number[] | Float32Array,
  topN: number,
): KnowledgeChunk[] {
  const n = vectors.length;
  if (n === 0 || topN <= 0) return [];
  const scores = new Float64Array(n);
  for (let i = 0; i < n; i++) scores[i] = cosineSimilarity(queryEmbedding, vectors[i]!.embedding);
  // 有界插入：维护降序 top-N 下标，O(N·topN)（topN 通常 ≤ 20），避免全量 sort 的 O(N log N)
  const topIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = scores[i]!;
    const len = topIdx.length;
    if (len < topN || s > scores[topIdx[len - 1]!]!) {
      let j = len - 1;
      while (j >= 0 && scores[topIdx[j]!]! < s) {
        topIdx[j + 1] = topIdx[j]!;
        j--;
      }
      topIdx[j + 1] = i;
      if (topIdx.length > topN) topIdx.length = topN;
    }
  }
  return topIdx.map((idx) => vectors[idx]!.chunk);
}

/**
 * 混合检索核心：传入可复用的 BM25 索引（buildBM25 构建）。
 * BM25 + 向量（可选）双路召回，RRF 融合。
 * @param chunks 全部文本分块（BM25 路，须与 bm25 对应同一份数据）
 * @param bm25 复用索引（高频调用避免每次重建）
 * @param vectors 已建索引的向量（向量路，为空则退化为纯 BM25）
 * @param queryEmbedding 查询向量（向量路需要；未提供则跳过向量路）
 */
export function hybridSearchWithBm25(
  chunks: KnowledgeChunk[],
  bm25: BM25,
  vectors: VectorChunk[],
  query: string,
  queryEmbedding: number[] | Float32Array | null,
  opts: { topK?: number; topN?: number; rrfK?: number } = {},
): ScoredChunk[] {
  const { topK = 5, topN = 20, rrfK = 60 } = opts;
  const rankedLists: KnowledgeChunk[][] = [];

  if (vectors.length > 0 && queryEmbedding) {
    rankedLists.push(vectorSearch(vectors, queryEmbedding, topN));
  }

  if (chunks.length > 0) {
    rankedLists.push(bm25Search(bm25, chunks, query, topN));
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

/** 混合检索（便捷入口：每次构建 BM25；高频调用请用 hybridSearchWithBm25 + buildBM25 复用索引） */
export function hybridSearch(
  chunks: KnowledgeChunk[],
  vectors: VectorChunk[],
  query: string,
  queryEmbedding: number[] | Float32Array | null,
  opts: { topK?: number; topN?: number; rrfK?: number } = {},
): ScoredChunk[] {
  return hybridSearchWithBm25(chunks, buildBM25(chunks), vectors, query, queryEmbedding, opts);
}
