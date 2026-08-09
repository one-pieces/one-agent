import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "@one-agent/core";

/**
 * 应用层 Agent 配置存储（SQLite，node:sqlite 零依赖）。
 * 只存 AgentConfig（JSON 一等数据）——动态配置的落地。
 */
export class AppDatabase {
  private db: DatabaseSync;

  constructor(filePath = join(process.cwd(), "data", "one-agent.db")) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id         TEXT PRIMARY KEY,
        config     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  listAgents(): AgentConfig[] {
    const rows = this.db.prepare("SELECT config FROM agents ORDER BY updated_at DESC").all() as { config: string }[];
    return rows.map((r) => JSON.parse(r.config) as AgentConfig);
  }

  getAgent(id: string): AgentConfig | null {
    const row = this.db.prepare("SELECT config FROM agents WHERE id = ?").get(id) as { config: string } | undefined;
    return row ? (JSON.parse(row.config) as AgentConfig) : null;
  }

  createAgent(config: AgentConfig): AgentConfig {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO agents (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(config.id, JSON.stringify(config), now, now);
    return config;
  }

  updateAgent(config: AgentConfig): AgentConfig {
    this.db
      .prepare("UPDATE agents SET config = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(config), new Date().toISOString(), config.id);
    return config;
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }
}

export const db = new AppDatabase();

export function newAgentId(): string {
  return `agent-${randomUUID().slice(0, 8)}`;
}
