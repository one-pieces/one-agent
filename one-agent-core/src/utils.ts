/** 安全解析 JSON 片段（工具参数分片拼接后可能不完整），失败返回 {} */
export function safeParseJSON(text: string): unknown {
  if (!text || text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 去尾部斜杠，保证 baseUrl 拼接正确 */
export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
