import { db } from "@/lib/db";
import { SUPPORTED_EXTS, extractFileText } from "@/lib/rag/file-text";
import { saveOriginalFile } from "@/lib/rag/file-store";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB（PDF 可能比纯文本大）

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/knowledge/[id]/upload — multipart/form-data 上传文档（.txt/.md/.mdx/.pdf，支持多文件）
 * 保存原始文件到磁盘（供「查看文件」直接打开），同时提取原文存入 content（供索引），
 * 索引状态 none（由 build-index 单独构建向量索引）。
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (!db.getKnowledgeBase(id)) return Response.json({ error: "not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "multipart/form-data 请求体" }, { status: 400 });
  }

  const files: File[] = [...form.entries()]
    .filter(([k]) => k === "file")
    .map(([, v]) => v as File);
  if (files.length === 0) return Response.json({ error: "未选择文件" }, { status: 400 });

  const results: Array<{ id: string; name: string; ok: boolean; error?: string; extra?: string }> = [];
  for (const file of files) {
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) {
      results.push({ id: "", name: file.name, ok: false, error: `不支持的格式 ${ext}（仅支持 txt/md/mdx/pdf）` });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      results.push({ id: "", name: file.name, ok: false, error: "文件超过 10MB 限制" });
      continue;
    }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const { text, numPages } = await extractFileText(file.name, buf);
      const trimmed = text.trim();
      if (!trimmed) {
        results.push({ id: "", name: file.name, ok: false, error: "文件内容为空（PDF 可能为扫描件/无文本层）" });
        continue;
      }
      const record = db.addKnowledgeFile(id, file.name, file.size, trimmed);
      // 原始文件落盘（「查看文件」直接返回原文件）
      await saveOriginalFile(id, record.id, file.name, buf);
      results.push({ id: record.id, name: file.name, ok: true, extra: numPages !== undefined ? `${numPages} 页` : undefined });
    } catch (err) {
      results.push({
        id: "",
        name: file.name,
        ok: false,
        error: `解析失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return Response.json({ results });
}
