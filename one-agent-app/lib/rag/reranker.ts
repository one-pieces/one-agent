/**
 * Cross-Encoder 重排（移植 eve-agent rag/src/reranker.ts）：
 * 检索召回「快而广」，重排用 cross-encoder 对候选精算相关性。
 * 默认模型 kftof/bge-reranker-v2-m3-onnx-int8-avx2；惰性加载，仅在开启时下载。
 */
import type { ScoredChunk } from "./retriever";

let _tokenizer: any = null;
let _model: any = null;
let _cachedModelName = "";

async function ensureModel(modelName: string) {
  if (_tokenizer && _model && _cachedModelName === modelName) {
    return { tokenizer: _tokenizer, model: _model };
  }
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
  _tokenizer = await AutoTokenizer.from_pretrained(modelName);
  _model = await AutoModelForSequenceClassification.from_pretrained(modelName, { dtype: "fp32" });
  _cachedModelName = modelName;
  return { tokenizer: _tokenizer, model: _model };
}

/** 对候选分块重新打分排序，返回 Top-K */
export async function rerank(
  query: string,
  candidates: ScoredChunk[],
  topK = 5,
  modelName = "kftof/bge-reranker-v2-m3-onnx-int8-avx2",
): Promise<ScoredChunk[]> {
  if (candidates.length === 0) return [];
  const { tokenizer, model } = await ensureModel(modelName);
  const scores: number[] = [];
  for (const rc of candidates) {
    const inputs = tokenizer(query, { text_pair: rc.chunk.content, padding: true, truncation: true });
    const output = await model(inputs);
    const logits = output.logits.data as Float32Array;
    scores.push(logits[0]);
  }
  return candidates
    .map((rc, i) => ({ chunk: rc.chunk, score: scores[i]! }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
