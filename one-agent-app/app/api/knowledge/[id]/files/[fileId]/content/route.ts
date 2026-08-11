import { db } from "@/lib/db";
import { readOriginalFile, contentTypeFor } from "@/lib/rag/file-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; fileId: string }> };

/**
 * GET /api/knowledge/[id]/files/[fileId]/content — 查看文件原文（新窗口打开）
 * 优先返回上传的原始文件（PDF 浏览器内联展示；文本按 UTF-8）；
 * 旧数据无落盘文件时回退 DB 提取文本（text/plain）。
 */
export async function GET(_request: Request, { params }: Params) {
  const { id, fileId } = await params;
  const file = db.getKnowledgeFile(id, fileId);
  if (!file) return Response.json({ error: "not found" }, { status: 404 });

  const original = await readOriginalFile(id, fileId, file.name);
  if (original) {
    // Buffer 转 ArrayBuffer（显式拷贝，满足 BodyInit 类型约束）
    const bytes = new Uint8Array(original).buffer;
    return new Response(bytes, {
      headers: {
        "content-type": contentTypeFor(file.name),
        "content-disposition": `inline; filename="${encodeURIComponent(file.name)}"`,
        "cache-control": "no-cache",
      },
    });
  }
  // 旧数据回退：返回提取文本
  return new Response(file.content, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `inline; filename="${encodeURIComponent(file.name)}"`,
      "cache-control": "no-cache",
    },
  });
}
