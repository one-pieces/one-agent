import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { defineTool } from "../define.ts";
import { resolveToolPath } from "../../utils.ts";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"]);

/** 从文件头解析常见图像尺寸（PNG/JPEG/GIF/WebP），失败返回 null */
function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // PNG: 8 字节签名 + IHDR
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: "GIF8" + 宽高 LE
  if (buf.toString("ascii", 0, 4) === "GIF8") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: 扫描 SOF 段（0xFFC0–0xFFCF，排除 C4/C8/CC）
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
    return null;
  }
  // WebP: "RIFF" + "WEBP" + VP8X / VP8 / VP8L
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8X" && buf.length >= 30) {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (fmt === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fmt === "VP8L" && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

/**
 * 读取文件与图像内容：
 * - 文本文件：UTF-8 内容（大文件自动截断）
 * - 图像文件：返回大小与尺寸等元信息（当前内核工具结果以文本回填模型，无视觉通道）
 */
export const readTool = defineTool({
  name: "read",
  description:
    "读取一个或多个文件与图像内容。文本文件返回内容（UTF-8，大文件自动截断）；图像文件（png/jpg/gif/webp 等）返回大小与尺寸元信息。支持 path（单个）或 paths（批量数组，推荐，可一次读多个文件减少轮次）。path/paths 为绝对路径或相对会话工作目录。",
  schema: z
    .object({
      path: z.string().min(1).optional(),
      paths: z.array(z.string().min(1)).max(20).optional(),
      maxChars: z.number().int().positive().max(100_000).optional(),
    })
    .refine((v) => v.path || v.paths, { message: "path 或 paths 至少提供一个" }),
  async execute(ctx, { path, paths, maxChars = 20_000 }) {
    const targets = paths && paths.length > 0 ? paths : path ? [path] : [];
    const results: Record<string, unknown> = {};
    let firstError: string | undefined;
    for (const p of targets) {
      try {
        const resolved = resolveToolPath(p, ctx.cwd);
        const st = await stat(resolved);
        const dot = resolved.lastIndexOf(".");
        const ext = dot > 0 ? resolved.slice(dot).toLowerCase() : "";
        if (IMAGE_EXT.has(ext)) {
          const buf = await readFile(resolved);
          const dim = imageDimensions(buf);
          results[p] = {
            type: "image",
            path: resolved,
            sizeBytes: st.size,
            ...(dim ? { width: dim.width, height: dim.height } : {}),
            note: "当前为图像元信息（大小/尺寸）；图像内容识别需要视觉模型支持",
          };
        } else {
          const content = await readFile(resolved, "utf-8");
          results[p] =
            content.length > maxChars
              ? content.slice(0, maxChars) + `\n...[已截断，总长度 ${content.length}]`
              : content;
        }
      } catch (err) {
        results[p] = `读取失败: ${err instanceof Error ? err.message : String(err)}`;
        firstError ??= err instanceof Error ? err.message : String(err);
      }
    }
    // 单个文件时保持旧返回格式（纯文本/对象），批量时返回 { files: { path: content } }
    if (targets.length === 1) {
      const single = results[targets[0]!];
      if (typeof single === "string" && single.startsWith("读取失败:")) {
        return { ok: false, output: null, error: single };
      }
      return { ok: true, output: single };
    }
    return { ok: true, output: { files: results } };
  },
});
