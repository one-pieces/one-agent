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
const logs: RequestLog[] = [];

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
