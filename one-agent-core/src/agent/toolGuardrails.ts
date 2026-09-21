/**
 * 工具调用守卫（port of Hermes `agent/tool_guardrails.py`，精简版）。
 *
 * 纯函数控制器、无副作用：只观察本轮的工具调用与结果，返回决策；由 AgentLoop 决定
 * 决策怎么落地（注入提示 / 不执行并合成拒绝结果 / 结束本轮）。
 *
 * 解决的问题：模型陷入无效重试（同一调用重复、同一条失败路径反复撞）时，此前只会
 * 一路试到 maxIterations，白烧 token 且用户看到一堆重复的工具卡片。
 *
 * 判定分层（与 Hermes 同构）：
 *   warn  → 往对话里追加一条引导文本（合成消息，前端隐藏、压缩时丢弃），模型自己改
 *   block → 该次调用**不执行**，合成 ok:false 结果（带 guardrail 标记），模型必须换策略
 *   halt  → 本轮累计被拦下 haltAfterBlocks 次后停止整轮
 */

/** 控制器返回的动作 */
export type GuardrailAction = "continue" | "warn" | "block" | "halt";

/** 决策码（与提示文案一一对应；前端/日志可据此聚合「哪类误用最多」） */
export type GuardrailCode =
  | "idempotent_no_progress"
  | "repeated_exact_failure"
  | "same_tool_failure"
  | "identical_call_cycle"
  | "web_search_cap"
  | "duplicate_same_batch";

export interface GuardrailDecision {
  action: GuardrailAction;
  code: GuardrailCode;
  toolName: string;
  count: number;
  /** 给模型（halt 时给人）看的说明文本 */
  message: string;
}

export interface ToolGuardrailConfig {
  /** 总开关（默认开） */
  enabled?: boolean;
  /** 同参数同结果连续第几次开始提示（默认 2） */
  warnAfter?: number;
  /** 连续第几次后拦下、不再执行（默认 3） */
  blockAfter?: number;
  /** 本轮累计拦下多少次后停轮（默认 3） */
  haltAfterBlocks?: number;
  /** 每轮 web_search 上限（默认 50） */
  maxWebSearches?: number;
  /** 只读工具：重复调用无新信息才判定为无进展；覆盖默认表 */
  idempotentTools?: string[];
  /** 失败容忍工具：其"失败"是正常产出（测试变红、空匹配），不计入「反复失败」 */
  failureTolerantTools?: string[];
}

/** 默认只读工具（同参数同结果重复 = 无进展） */
export const DEFAULT_IDEMPOTENT_TOOLS = ["read", "grep", "find", "ls", "tree", "web_search", "knowledge_search"];
/** 默认失败容忍工具（失败不等于卡住） */
export const DEFAULT_FAILURE_TOLERANT_TOOLS = ["bash"];

const DEFAULT_WARN_AFTER = 2;
const DEFAULT_BLOCK_AFTER = 3;
const DEFAULT_HALT_AFTER_BLOCKS = 3;
const DEFAULT_MAX_WEB_SEARCHES = 50;
/** 周期检测：最长周期 + 观察窗口（够 3 圈最长周期 + 余量） */
const MAX_CYCLE_PERIOD = 4;
const CYCLE_HISTORY = 32;

/** 单次调用的观察记录 */
interface Observation {
  name: string;
  /** 参数指纹（稳定 JSON） */
  argsKey: string;
  /** 结果指纹（稳定 JSON；失败时为空串） */
  resultKey: string;
  ok: boolean;
}

/** 稳定的 JSON 序列化：键排序，避免对象键序不同导致指纹不同 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`).join(",")}}`;
}

/** 工具专属的「换个做法」建议（Hermes `_tool_failure_recovery_hint` 的对应物） */
function failureRecoveryHint(toolName: string, count: number): string {
  const common =
    `${toolName} 本轮已失败 ${count} 次，看起来是重试循环。不要退回只输出文字：` +
    `先看最新一次的错误/输出，核实自己的假设，再改变做法。`;
  if (toolName === "bash") {
    return (
      common +
      `命令类失败建议先跑一次小诊断（如 \`pwd && ls -la\`），再改用绝对路径、更简单的命令、` +
      `换个工作目录，或改用 read/write/edit 这类工具完成同一件事。`
    );
  }
  return (
    common +
    `可以换参数、把范围收窄、用绝对路径，或换一个能推进任务的工具；若阻塞来自外部` +
    `（网络/权限/不存在的资源），做一次诊断后直接说明阻塞，不要重复同一条失败路径。`
  );
}

/**
 * 工具调用守卫控制器。
 * 生命周期 = 一轮对话（`agentLoop` 每次调用创建一个，销毁即重置）。
 */
export class ToolGuardrailController {
  private readonly cfg: Required<Omit<ToolGuardrailConfig, "idempotentTools" | "failureTolerantTools">> &
    Pick<ToolGuardrailConfig, "idempotentTools" | "failureTolerantTools">;
  private readonly idempotent: Set<string>;
  private readonly failureTolerant: Set<string>;
  private observations: Observation[] = [];
  private blocks = 0;
  private webSearches = 0;
  /** 本批已出现过的「只读调用」指纹（同批重复 = 纯浪费，直接抑制执行） */
  private batchSeen = new Set<string>();

  constructor(config: ToolGuardrailConfig = {}) {
    this.cfg = {
      enabled: config.enabled ?? true,
      warnAfter: config.warnAfter ?? DEFAULT_WARN_AFTER,
      blockAfter: config.blockAfter ?? DEFAULT_BLOCK_AFTER,
      haltAfterBlocks: config.haltAfterBlocks ?? DEFAULT_HALT_AFTER_BLOCKS,
      maxWebSearches: config.maxWebSearches ?? DEFAULT_MAX_WEB_SEARCHES,
      idempotentTools: config.idempotentTools,
      failureTolerantTools: config.failureTolerantTools,
    };
    this.idempotent = new Set(config.idempotentTools ?? DEFAULT_IDEMPOTENT_TOOLS);
    this.failureTolerant = new Set(config.failureTolerantTools ?? DEFAULT_FAILURE_TOLERANT_TOOLS);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** 本轮已被拦下的调用次数 */
  get blockedCount(): number {
    return this.blocks;
  }

  /** 是否应该停轮（拦下次数达到上限） */
  get shouldHalt(): boolean {
    return this.blocks >= this.cfg.haltAfterBlocks;
  }

  /**
   * 每轮工具批次开始时调用（AgentLoop 在执行前判定之前调用一次）。
   * 用途：批内去重的作用域 = 一个批次。
   */
  beginBatch(): void {
    this.batchSeen.clear();
  }

  /**
   * 执行前判定：是否要拦下这次调用（不再执行）。
   * 依据是**之前**的观察（同参数同结果已连续 blockAfter 次），参数本身不预测结果。
   */
  beforeCall(name: string, input: unknown): GuardrailDecision | null {
    if (!this.cfg.enabled) return null;

    if (name === "web_search") {
      this.webSearches += 1;
      if (this.webSearches > this.cfg.maxWebSearches) {
        this.blocks += 1;
        return {
          action: this.shouldHalt ? "halt" : "block",
          code: "web_search_cap",
          toolName: name,
          count: this.webSearches,
          message:
            `本轮 web_search 已达上限 ${this.cfg.maxWebSearches} 次，疑似搜索循环；` +
            `该次搜索未执行，请基于已有结果作答。`,
        };
      }
      return null;
    }

    const argsKey = stableKey(input);

    // ① 批内重复：同一批次里对**只读工具**的完全相同的调用（模型一次要了 6 个一样的 read）。
    //    这类重复纯属浪费：只执行第一次，其余拦下并告知（不计入停轮计数——它是机械去重，不是死循环）
    if (this.idempotent.has(name)) {
      const fingerprint = `${name}\u0000${argsKey}`;
      if (this.batchSeen.has(fingerprint)) {
        return {
          action: "block",
          code: "duplicate_same_batch",
          toolName: name,
          count: 1,
          message:
            `已抑制这次重复调用：本轮里 ${name} 已经以完全相同的参数执行过，结果见上面的调用。` +
            `需要新信息请换参数或换工具。`,
        };
      }
      this.batchSeen.add(fingerprint);
    }

    const streak = this.identicalStreak();
    if (streak && streak.observation.name === name && streak.observation.argsKey === argsKey) {
      if (streak.count >= this.cfg.blockAfter) {
        this.blocks += 1;
        const message =
          `已拦下这次 ${name} 调用：相同参数+相同结果已经连续出现 ${streak.count} 次。` +
          `请直接使用已有结果，或换参数/换工具；原样重试不会带来新信息。`;
        return {
          action: this.shouldHalt ? "halt" : "block",
          code: "idempotent_no_progress",
          toolName: name,
          count: streak.count,
          message,
        };
      }
    }
    return null;
  }

  /**
   * 执行后判定：返回需要注入对话的引导（无则 null）。
   * 传入的是**按原始调用顺序**回填的结果，保证并行段内计数稳定。
   */
  afterCall(name: string, input: unknown, output: unknown, ok: boolean): GuardrailDecision | null {
    if (!this.cfg.enabled) return null;

    const observation: Observation = {
      name,
      argsKey: stableKey(input),
      resultKey: ok ? stableKey(output) : "",
      ok,
    };
    this.observations.push(observation);
    if (this.observations.length > CYCLE_HISTORY) this.observations.shift();

    // ① 失败路径优先于"无进展"：失败的工具调用按"反复失败"处理（措辞指向错误本身），
    //    而不是"结果没变"（Hermes 同样区分：idempotent_no_progress 只用于成功的只读重复）。
    //    失败容忍工具（bash 等）也会拿到提示；拦截只发生在 beforeCall，不受此影响。
    if (!ok) {
      const exact = this.consecutiveExactFailures();
      if (exact.count >= this.cfg.warnAfter) {
        return {
          action: "warn",
          code: "repeated_exact_failure",
          toolName: name,
          count: exact.count,
          message:
            `${name} 已连续 ${exact.count} 次以相同参数失败（结果也相同）。` +
            `这是重试循环：请看最新报错改变策略，或换一个工具，不要原样重试。`,
        };
      }
      const same = this.observations.filter((o) => o.name === name && !o.ok).length;
      if (same >= this.cfg.warnAfter + 1) {
        return {
          action: "warn",
          code: "same_tool_failure",
          toolName: name,
          count: same,
          message: failureRecoveryHint(name, same),
        };
      }
      return null;
    }

    // ② 幂等工具：同参数 + 同结果连续重复 → 无进展
    if (this.idempotent.has(name)) {
      const streak = this.identicalStreak();
      if (streak && streak.count >= this.cfg.warnAfter && streak.observation.resultKey === observation.resultKey) {
        return {
          action: "warn",
          code: "idempotent_no_progress",
          toolName: name,
          count: streak.count,
          message:
            `${name} 已连续 ${streak.count} 次返回相同结果（参数未变）。` +
            `这条结果已经足够回答，请使用它或换一个查询/工具，不要原样重复。`,
        };
      }
    }

    // ③ 周期检测：A,B,A,B…（参数与结果都相同）的整批重放（对所有工具生效，含只读工具）
    const cycle = this.detectCycle();
    if (cycle && cycle.laps >= this.cfg.warnAfter) {
      const blockIt = cycle.laps >= this.cfg.blockAfter;
      if (blockIt) this.blocks += 1;
      return {
        action: blockIt ? (this.shouldHalt ? "halt" : "block") : "warn",
        code: "identical_call_cycle",
        toolName: name,
        count: cycle.laps,
        message:
          `检测到连续 ${cycle.laps} 轮重复同一组工具调用（周期 ${cycle.period}，参数与结果都相同）。` +
          `重复这批调用不会带来进展：请改用已有结果、改变参数，或换一组工具。`,
      };
    }
    return null;
  }

  /** 末尾与当前签名相同（工具+参数+结果）的连续观察数 */
  private identicalStreak(): { observation: Observation; count: number } | null {
    const last = this.observations[this.observations.length - 1];
    if (!last) return null;
    let count = 0;
    for (let i = this.observations.length - 1; i >= 0; i--) {
      const o = this.observations[i]!;
      if (o.name === last.name && o.argsKey === last.argsKey && o.resultKey === last.resultKey) count++;
      else break;
    }
    return { observation: last, count };
  }

  /** 末尾连续的「同工具+同参数失败」次数（结果也相同） */
  private consecutiveExactFailures(): { count: number } {
    const last = this.observations[this.observations.length - 1];
    if (!last || last.ok) return { count: 0 };
    let count = 0;
    for (let i = this.observations.length - 1; i >= 0; i--) {
      const o = this.observations[i]!;
      if (!o.ok && o.name === last.name && o.argsKey === last.argsKey) count++;
      else break;
    }
    return { count };
  }

  /**
   * 周期检测：末尾是否由「长度为 period 的调用序列」重复了 laps 圈（参数与结果都相同）。
   * 交替重放（A,B,A,B…）会重置"连续相同调用"的计数，所以必须单独判。
   */
  private detectCycle(): { period: number; laps: number } | null {
    const obs = this.observations;
    for (let period = 2; period <= MAX_CYCLE_PERIOD; period++) {
      const need = period * 2;
      if (obs.length < need) continue;
      const tail = obs.slice(-need);
      let identical = true;
      for (let i = 0; i < period && identical; i++) {
        const a = tail[i]!;
        const b = tail[i + period]!;
        if (a.name !== b.name || a.argsKey !== b.argsKey || a.resultKey !== b.resultKey || a.ok !== b.ok) {
          identical = false;
        }
      }
      if (!identical) continue;
      // 往前数还有几圈
      let laps = 2;
      while (obs.length >= period * (laps + 1)) {
        const prev = obs.slice(-period * (laps + 1));
        let same = true;
        for (let i = 0; i < period && same; i++) {
          const a = prev[i]!;
          const b = prev[i + period]!;
          if (a.name !== b.name || a.argsKey !== b.argsKey || a.resultKey !== b.resultKey || a.ok !== b.ok) {
            same = false;
          }
        }
        if (!same) break;
        laps++;
      }
      return { period, laps };
    }
    return null;
  }
}

/** 便捷构造（AgentLoop 用） */
export function createToolGuardrails(config?: ToolGuardrailConfig): ToolGuardrailController {
  return new ToolGuardrailController(config ?? {});
}
