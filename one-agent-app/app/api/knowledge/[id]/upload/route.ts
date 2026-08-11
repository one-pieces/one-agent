import { db } from "@/lib/db";
import { chunkText } from "@/lib/knowledge";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 512 * 1024; // 512KB

type Params = { params: Promise<{ id: string }> };

const TEXT_EXT = new Set([".txt", ".md", ".mdx", ".markdown"]);

/**
 * POST /api/knowledge/[id]/upload — multipart/form-data 上传文本文件（.txt/.md/.mdx）
 * 服务端读取文本 → 分块 → 入库（文件 + chunks）。
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

  const entries = [...form.entries()].filter(([k]) => k === "file");
  if (entries.length === 0) return Response.json({ error: "未选择文件" }, { status: 400 });

  const files: File[] = entries.map(([, v]) => v as File);
  const results: Array<{ name: string; ok: boolean; error?: string; chunkCount?: number }> = [];

  for (const file of files) {
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXT.has(ext)) {
      results.push({ name: file.name, ok: false, error: `不支持的格式 ${ext}（仅支持 txt/md/mdx）` });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      results.push({ name: file.name, ok: false, error: "文件超过 512KB 限制" });
      continue;
    }
    const text = await file.text();
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      results.push({ name: file.name, ok: false, error: "文件内容为空" });
      continue;
    }
    db.addKnowledgeFile(id, file.name, file.size, chunks);
    results.push({ name: file.name, ok: true, chunkCount: chunks.length });
  }

  return Response.json({ results });
}
