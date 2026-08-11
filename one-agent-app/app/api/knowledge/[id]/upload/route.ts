import { db } from "@/lib/db";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

type Params = { params: Promise<{ id: string }> };

const TEXT_EXT = new Set([".txt", ".md", ".mdx", ".markdown"]);

/**
 * POST /api/knowledge/[id]/upload — multipart/form-data 上传文本文件（.txt/.md/.mdx，支持多文件）
 * 只存元数据 + 原文，索引状态 none（由 build-index 单独构建向量索引）。
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

  const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
  for (const file of files) {
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXT.has(ext)) {
      results.push({ id: "", name: file.name, ok: false, error: `不支持的格式 ${ext}（仅支持 txt/md/mdx）` });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      results.push({ id: "", name: file.name, ok: false, error: "文件超过 2MB 限制" });
      continue;
    }
    const text = (await file.text()).trim();
    if (!text) {
      results.push({ id: "", name: file.name, ok: false, error: "文件内容为空" });
      continue;
    }
    const record = db.addKnowledgeFile(id, file.name, file.size, text);
    results.push({ id: record.id, name: file.name, ok: true });
  }
  return Response.json({ results });
}
