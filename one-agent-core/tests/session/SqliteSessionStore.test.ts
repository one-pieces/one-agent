import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore, type Session } from "../../src/session/index.js";

const now = new Date().toISOString();
function makeSession(id: string, agentId = "a"): Session {
  return {
    id,
    agentId,
    messages: [{ id: "m1", role: "user", content: "hi", createdAt: now }],
    createdAt: now,
    updatedAt: now,
  };
}

const dir = mkdtempSync(join(tmpdir(), "one-agent-sqlite-"));
const dbPath = join(dir, "sessions.db");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteSessionStore", () => {
  it("save / get / list / delete", async () => {
    const store = new SqliteSessionStore(":memory:");
    await store.saveSession(makeSession("s1"));
    await store.saveSession(makeSession("s2", "b"));
    expect((await store.getSession("s1"))?.messages[0]?.content).toBe("hi");
    expect((await store.listSessions("b")).map((s) => s.id)).toEqual(["s2"]);
    await store.deleteSession("s1");
    expect(await store.getSession("s1")).toBeNull();
    store.close();
  });

  it("文件持久化：关闭后重新打开（模拟进程重启）数据仍在", async () => {
    const store1 = new SqliteSessionStore(dbPath);
    await store1.saveSession(makeSession("persist"));
    store1.close();

    const store2 = new SqliteSessionStore(dbPath);
    const s = await store2.getSession("persist");
    expect(s?.messages[0]?.content).toBe("hi");
    store2.close();
  });

  it("upsert 更新同一 id", async () => {
    const store = new SqliteSessionStore(":memory:");
    await store.saveSession(makeSession("u1"));
    await store.saveSession({ ...makeSession("u1"), messages: [] });
    expect((await store.getSession("u1"))?.messages).toEqual([]);
    store.close();
  });
});
