import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase } from "../lib/db";
import { decryptSecret, encryptSecret, isEncrypted } from "../lib/crypto";
import type { AgentConfig } from "@one-agent/core";

function makeConfig(apiKey: string): AgentConfig {
  return {
    id: "enc-test",
    name: "加密测试",
    instructions: "i",
    model: { provider: "openai-compatible", baseUrl: "http://x/v1", modelId: "m", apiKey },
    tools: [],
  };
}

describe("API key 加密存储（M5）", () => {
  it("encrypt/decrypt 往返", () => {
    const token = encryptSecret("sk-超级机密-123");
    expect(token).toMatch(/^enc:v1:/);
    expect(isEncrypted(token)).toBe(true);
    expect(decryptSecret(token)).toBe("sk-超级机密-123");
  });

  it("数据库落盘为密文，读取自动解密", async () => {
    const dir = mkdtempSync(join(tmpdir(), "one-agent-enc-"));
    const file = join(dir, "db.db");
    const db = new AppDatabase(file);

    db.createAgent(makeConfig("sk-plaintext"));
    // 原始行包含密文，不含明文
    const raw = new DatabaseSync(file).prepare("SELECT config FROM agents").get() as { config: string };
    expect(raw.config).toContain("enc:v1:");
    expect(raw.config).not.toContain("sk-plaintext");

    // 读取时解密
    const loaded = db.getAgent("enc-test");
    expect(loaded?.model.apiKey).toBe("sk-plaintext");

    // 幂等：再次保存不重复加密
    db.updateAgent(makeConfig("sk-plaintext"));
    const raw2 = new DatabaseSync(file).prepare("SELECT config FROM agents").get() as { config: string };
    expect(raw2.config.match(/enc:v1:/g)?.length).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });
});
