/**
 * 文件文本提取（对齐 eve-agent rag/src/loader.ts）：
 * - .txt/.md/.mdx/.markdown：直接读文本
 * - .pdf：用 pdf-parse（内部 pdfjs-dist）解析提取文本
 * 提取结果统一做 sanitizeText 清理（NUL/控制字符/未配对 UTF-16 代理项——
 * PDF 解析尤其扫描件/编码异常的 PDF 常产出这类脏字符，会被下游向量化/存储拒绝）。
 */

/** 支持的文本扩展名 */
const TEXT_EXTS = new Set([".txt", ".md", ".mdx", ".markdown"]);
export const PDF_EXT = ".pdf";
export const SUPPORTED_EXTS = new Set([...TEXT_EXTS, PDF_EXT]);

/**
 * 清理文本中的非法字符：NUL 字节、C0 控制字符（保留 \n \t \r）以及未配对的
 * UTF-16 代理项。
 */
export function sanitizeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x00 || code === 0x7f) continue;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      }
      continue; // 丢弃未配对的高位代理项
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // 丢弃未配对的低位代理项
    out += text[i];
  }
  return out;
}

/** 提取 PDF 文本（惰性 import，避免未使用时加载 pdfjs-dist） */
export async function extractPdfText(buffer: Uint8Array): Promise<{ text: string; numPages: number }> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText();
    const info = await parser.getInfo();
    return { text: sanitizeText(textResult.text), numPages: info.total };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** 按文件名提取文件文本；PDF 走解析，其余按 UTF-8 文本 */
export async function extractFileText(
  name: string,
  content: ArrayBuffer | Uint8Array | string,
): Promise<{ text: string; numPages?: number }> {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (ext === PDF_EXT) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    return extractPdfText(bytes);
  }
  return {
    text: sanitizeText(
      typeof content === "string" ? content : new TextDecoder("utf-8").decode(content),
    ),
  };
}
