/**
 * 轻量可观测性：日志型 fetch 包装 + 内存请求日志（最近 500 条）。
 * 注入 Provider（createProvider(kind, { fetch })），记录每次 LLM 请求。
 */
export interface RequestLog {
  ts: string;
  url: string;
  status: number;
  durationMs: number;
  model?: string;
}

const MAX_LOGS = 500;

/**
 * 进程级日志缓冲：Next.js 会把同一模块打进多个 bundle（route 处理器 / 页面 server component 各自实例化），
 * 模块级数组会分裂成多份——内核写入的副本和页面读取的副本不是同一个。
 * 挂到 globalThis 保证同一进程内所有 bundle 读写同一份数组。
 */
const globalStore = globalThis as typeof globalThis & { __oneAgentRequestLogs?: RequestLog[] };
const logs: RequestLog[] = (globalStore.__oneAgentRequestLogs ??= []);

export function createLoggingFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const start = Date.now();
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    let model: string | undefined;
    try {
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body);
        if (typeof body.model === "string") model = body.model;
      }
    } catch {
      /* 非 JSON body，忽略 */
    }
    const res = await fetchImpl(input, init);
    logs.unshift({
      ts: new Date().toISOString(),
      url,
      status: res.status,
      durationMs: Date.now() - start,
      model,
    });
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    return res;
  };
}

export function getRequestLogs(): RequestLog[] {
  return logs;
}
