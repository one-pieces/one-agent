import { describe, it, expect } from "vitest";
import { InMemorySessionStore, type Session } from "../../src/session/index.ts";

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

describe("InMemorySessionStore", () => {
  it("save / get / list / delete", async () => {
    const store = new InMemorySessionStore();
    await store.saveSession(makeSession("s1"));
    await store.saveSession(makeSession("s2", "b"));

    const s1 = await store.getSession("s1");
    expect(s1?.id).toBe("s1");
    expect(s1?.messages[0]?.content).toBe("hi");

    const all = await store.listSessions();
    expect(all.length).toBe(2);
    const byAgent = await store.listSessions("b");
    expect(byAgent.map((s) => s.id)).toEqual(["s2"]);

    await store.deleteSession("s1");
    expect(await store.getSession("s1")).toBeNull();
  });

  it("saveSession upsert 覆盖", async () => {
    const store = new InMemorySessionStore();
    await store.saveSession(makeSession("s1"));
    await store.saveSession({ ...makeSession("s1"), messages: [] });
    const s = await store.getSession("s1");
    expect(s?.messages).toEqual([]);
  });

  it("getSession 返回副本（外部修改不影响内部）", async () => {
    const store = new InMemorySessionStore();
    await store.saveSession(makeSession("s1"));
    const s = await store.getSession("s1");
    s!.messages.push({ id: "x", role: "user", content: "x", createdAt: now });
    const again = await store.getSession("s1");
    expect(again?.messages.length).toBe(1);
  });
});
