/**
 * 本地 Embedding（Transformers.js，@huggingface/transformers）：
 * 默认 BAAI/bge-m3（与 eve-agent 一致；多语言、1024 维，首次使用自动下载到本地缓存）。
 * 可用环境变量 EMBEDDING_MODEL 切换（如 BAAI/bge-small-zh-v1.5，更轻量但效果弱些）。
 * 与 eve-agent 一致：feature-extraction + cls pooling + normalize。
 */

export type TextEmbedder = (texts: string[]) => Promise<number[][]>;

// 惰性单例：避免重复加载模型
let _pipe: any = null;
let _modelName = "";

async function ensurePipeline(): Promise<any> {
  const modelName = process.env.EMBEDDING_MODEL ?? "BAAI/bge-m3";
  if (_pipe && _modelName === modelName) return _pipe;

  const { pipeline, env } = await import("@huggingface/transformers");
  // 国内网络 huggingface.co 不可达时兜底走镜像；用户显式设置 HF_ENDPOINT 时保持其值
  if (env.remoteHost === "https://huggingface.co") {
    env.remoteHost = process.env.HF_ENDPOINT ?? "https://hf-mirror.com";
  }
  _pipe = await pipeline("feature-extraction", modelName, { dtype: "fp32" });
  _modelName = modelName;
  return _pipe;
}

/** 批量文本 → 向量（逐条推理，避免 OOM；进度由调用方通过分批驱动） */
export async function encodeTexts(texts: string[]): Promise<number[][]> {
  const pipe = await ensurePipeline();
  const out: number[][] = [];
  for (const text of texts) {
    const r = await pipe(text, { pooling: "cls", normalize: true });
    out.push(Array.from(r.data as Float32Array));
  }
  return out;
}
