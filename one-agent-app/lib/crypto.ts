import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * API key 静态加密（AES-256-GCM）。
 * 密钥：data/.secret（自动生成，0600 权限；可用环境变量 ONE_AGENT_SECRET 覆盖）。
 * 格式：enc:v1:<iv>:<tag>:<data>（base64）
 */
const KEY_FILE = join(process.cwd(), "data", ".secret");

function getKey(): Buffer {
  const env = process.env.ONE_AGENT_SECRET;
  if (env && env.length >= 32) return Buffer.from(env.slice(0, 64), "hex");
  if (!existsSync(KEY_FILE)) {
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return Buffer.from(readFileSync(KEY_FILE, "utf-8").trim(), "hex");
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(token: string): string {
  const parts = token.split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") throw new Error("bad encrypted token");
  const [, , ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64!, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64!, "base64")), decipher.final()]).toString("utf-8");
}

export function isEncrypted(s: string): boolean {
  return s.startsWith("enc:v1:");
}
