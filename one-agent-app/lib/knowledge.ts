import type { KnowledgeChunk } from "./db";

/**
 * 知识库 MVP 检索：文本分块 + BM25 关键词打分（无 embedding 依赖）。
 * 中文按相邻双字（bigram）切词、英文按单词；检索时同规则分词后 BM25 打分取 Top-K。
 */

/** 将文本切成带重叠的块（按 ~800 字符，跨段落边界对齐） */
export function chunkText(text: string, chunkSize = 800, overlap = 100): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = start + chunkSize;
    if (end < normalized.length) {
      // 尽量在段落/句子边界断开，避免硬切
      const boundary = findBoundary(normalized, start, end);
      if (boundary > start + chunkSize / 2) end = boundary;
    }
    chunks.push(normalized.slice(start, end).trim());
    start = end - overlap;
  }
  return chunks.filter((c) => c.length > 0);
}

function findBoundary(text: string, start: number, end: number): number {
  const window = text.slice(start, end);
  // 优先段落边界 \n\n，其次换行，再次句末标点
  const candidates = [
    window.lastIndexOf("\n\n"),
    window.lastIndexOf("\n"),
    Math.max(window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"), window.lastIndexOf(".")),
  ];
  const idx = candidates.reduce((best, c) => Math.max(best, c), 0);
  return start + idx;
}

/** 分词：英文单词（小写）+ 中文双字 bigram */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  // 拉丁/数字单词
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_\-.]{1,}/g)) {
    tokens.push(m[0]!);
  }
  // 中文连续段 → 相邻双字
  for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const cjk = m[0]!;
    for (let i = 0; i < cjk.length - 1; i++) {
      tokens.push(cjk.slice(i, i + 2));
    }
    if (cjk.length === 1) tokens.push(cjk);
  }
  return tokens;
}

/** BM25 检索：对 chunks 按 query 打分，返回 Top-K（附带来源文件名） */
export function searchKnowledgeChunks(chunks: KnowledgeChunk[], query: string, limit = 5): KnowledgeChunk[] {
  if (chunks.length === 0 || !query.trim()) return [];

  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const n = chunks.length;
  const avgLen = chunks.reduce((s, c) => s + c.content.length, 0) / n;

  // 文档频率（包含该 term 的块数）
  const docFreq = new Map<string, number>();
  for (const c of chunks) {
    const set = new Set(tokenize(c.content));
    for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  const k1 = 1.5;
  const b = 0.75;
  const scored: Array<{ chunk: KnowledgeChunk; score: number }> = [];

  for (const c of chunks) {
    const termFreq = new Map<string, number>();
    for (const t of tokenize(c.content)) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

    let score = 0;
    for (const t of terms) {
      const tf = termFreq.get(t) ?? 0;
      if (tf === 0) continue;
      const df = docFreq.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const dl = c.content.length;
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgLen)));
    }
    if (score > 0) scored.push({ chunk: c, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.chunk);
}
