import type { LanguageProvider } from "../../src/providers/index.ts";
import type { ChatOptions } from "../../src/providers/types.ts";
import type { StreamChunk } from "../../src/index.ts";

/** 脚本化 Provider：按调用次数返回预设 chunk 序列（超长时重复最后一步） */
export class ScriptedProvider implements LanguageProvider {
  readonly kind = "openai-compatible" as const;
  calls = 0;
  receivedTools: unknown[][] = [];
  script: Array<() => StreamChunk[]>;
  onChat?: (opts: ChatOptions) => void;

  constructor(script: Array<() => StreamChunk[]>, onChat?: (opts: ChatOptions) => void) {
    this.script = script;
    this.onChat = onChat;
  }

  async *chat(opts: ChatOptions): AsyncIterable<StreamChunk> {
    this.onChat?.(opts);
    this.receivedTools.push(opts.tools ?? []);
    const step = this.script[this.calls] ?? this.script[this.script.length - 1]!;
    this.calls++;
    for (const c of step()) yield c;
  }
}
