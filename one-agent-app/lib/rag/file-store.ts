/**
 * 原始文件存储：上传时保存原始字节到磁盘（data/uploads/{kbId}/），
 * 「查看文件」接口直接返回原文件（PDF 浏览器内联打开，文本按 UTF-8 展示）。
 * 与 DB 里的提取文本（content 列，用于索引）相互独立。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
const UPLOAD_ROOT = join(process.cwd(), "data", "uploads");

/** 扩展名 → Content-Type */
export function contentTypeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
    case ".mdx":
    case ".markdown":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/** 原始文件落盘路径：data/uploads/{kbId}/{fileId}{ext}（fileId 为内部随机 id，无穿越风险） */
export function originalFilePath(kbId: string, fileId: string, name: string): string {
  const ext = extname(name).toLowerCase();
  return normalize(join(UPLOAD_ROOT, kbId, `${fileId}${ext}`));
}

/** 保存原始文件 */
export async function saveOriginalFile(kbId: string, fileId: string, name: string, buffer: Uint8Array): Promise<string> {
  const dir = join(UPLOAD_ROOT, kbId);
  await mkdir(dir, { recursive: true });
  const path = originalFilePath(kbId, fileId, name);
  await writeFile(path, buffer);
  return path;
}

/** 读取原始文件；不存在返回 null */
export async function readOriginalFile(kbId: string, fileId: string, name: string): Promise<Buffer | null> {
  try {
    return await readFile(originalFilePath(kbId, fileId, name));
  } catch {
    return null;
  }
}

/** 删除单个原始文件（忽略不存在） */
export async function deleteOriginalFile(kbId: string, fileId: string, name: string): Promise<void> {
  await rm(originalFilePath(kbId, fileId, name), { force: true }).catch(() => {});
}

/** 删除某知识库的全部原始文件（忽略不存在） */
export async function deleteOriginalDir(kbId: string): Promise<void> {
  await rm(join(UPLOAD_ROOT, kbId), { recursive: true, force: true }).catch(() => {});
}
