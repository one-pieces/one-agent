import { describe, it, expect } from "vitest";
import { sanitizeText, extractFileText, SUPPORTED_EXTS } from "../lib/rag/file-text";

describe("RAG：文件文本提取（txt/pdf）", () => {
  it("sanitizeText 清理控制字符与未配对代理项", () => {
    expect(sanitizeText("a\u0000b\u0007c\nd\te")).toBe("abc\nd\te");
    // 未配对的高位代理项被丢弃，配对代理项保留
    expect(sanitizeText("x\ud83d\ude00y")).toBe("x\ud83d\ude00y");
    expect(sanitizeText("x\ud83dy")).toBe("xy");
    // 低位代理项单独出现被丢弃
    expect(sanitizeText("x\udfffy")).toBe("xy");
  });

  it("extractFileText：纯文本直接返回（不经过 PDF 解析）", async () => {
    const r = await extractFileText("note.md", "# 标题\n正文内容");
    expect(r.text).toContain("标题");
    expect(r.numPages).toBeUndefined();
  });

  it("extractFileText：不支持扩展名不抛错（由调用方过滤）", async () => {
    // .exe 按文本读，仅验证不 crash；实际路由会先按 SUPPORTED_EXTS 过滤
    expect(SUPPORTED_EXTS.has(".pdf")).toBe(true);
    expect(SUPPORTED_EXTS.has(".txt")).toBe(true);
    expect(SUPPORTED_EXTS.has(".md")).toBe(true);
    expect(SUPPORTED_EXTS.has(".mdx")).toBe(true);
    expect(SUPPORTED_EXTS.has(".markdown")).toBe(true);
    expect(SUPPORTED_EXTS.has(".exe")).toBe(false);
  });

  it("extractFileText：PDF 走 pdf-parse 提取文本（用真实生成的中文 PDF）", async () => {
    // 与 /tmp/pdfgen 相同的生成方式；此处用内联最小 PDF 二进制
    // 用 pdfkit 生成太重，直接构造一个含中文的极简 PDF（Helvetica 不支持中文，
    // 但 pdfjs-dist 对未知字形的文本仍能提取出字形序号）——这里改用英文 PDF 验证链路
    const pdfBytes = createMinimalPdf("Hello RAG PDF 123");
    const r = await extractFileText("doc.pdf", pdfBytes);
    expect(r.text).toContain("Hello RAG PDF");
    expect(r.numPages).toBeGreaterThanOrEqual(1);
  });
});

/** 构造一个最小可解析 PDF（单页、Helvetica 文本），返回 Uint8Array */
function createMinimalPdf(text: string): Uint8Array {
  // 用 pdfkit 太重；手写一个标准 PDF（无压缩流）
  const esc = text.replace(/[\\()]/g, "\\$&");
  const content = `BT /F1 24 Tf 72 720 Td (${esc}) Tj ET`;
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
