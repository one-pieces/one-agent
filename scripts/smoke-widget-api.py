"""客服组件 API 冒烟：配置/会话/对话/历史/来源与鉴权负例/限流。"""
import json
import time
import urllib.error
import urllib.request

BASE = "http://localhost:3000"
AGENT = "deepseek-agent"
ok, bad = [], []


def check(label, cond, detail=""):
    (ok if cond else bad).append(label)
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail else ""))


def api(path, method="GET", body=None, origin=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    if origin:
        req.add_header("origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            text = r.read().decode()
            return r.status, (text if raw else json.loads(text)), dict(r.headers)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text), dict(e.headers)
        except Exception:
            return e.code, text, dict(e.headers)


print("【1】后台：开启客服组件")
st, admin, _ = api(f"/api/agents/{AGENT}/widget")
check("GET 后台配置 200", st == 200, f"status={st}")
check("默认未开启", admin["settings"]["enabled"] is False and admin["configured"] is False)

st, admin, _ = api(f"/api/agents/{AGENT}/widget", "PUT", {
    "enabled": True,
    "title": "示例商城客服",
    "subtitle": "一般 1 分钟内回复",
    "welcome": "你好，我是示例商城的客服小助手～",
    "placeholder": "请描述你的问题",
    "primaryColor": "#2f6bff",
    "position": "right",
    "rateLimit": 3,
})
check("PUT 开启并保存 200", st == 200, f"status={st}")
KEY = admin["settings"]["embedKey"]
SNIPPET = admin["snippet"]
check("返回嵌入代码含 agentId 与 key", f'data-agent="{AGENT}"' in SNIPPET and f'data-key="{KEY}"' in SNIPPET, SNIPPET[:120])
check("嵌入代码引用 widget.js", "/widget.js" in SNIPPET)
check("embedKey 形如 wk_<hex>", KEY.startswith("wk_") and len(KEY) > 20, KEY[:16] + "…")

st, r, _ = api(f"/api/agents/{AGENT}/widget", "PUT", {"primaryColor": "红色"})
check("非法颜色 → 400", st == 400, json.dumps(r, ensure_ascii=False))
st, r, _ = api(f"/api/agents/{AGENT}/widget", "PUT", {"rateLimit": 9999})
check("超范围限流 → 400", st == 400)

print("\n【2】公开接口：配置")
st, cfg, hdrs = api(f"/api/widget/config?agentId={AGENT}&key={KEY}", origin="https://shop.example.com")
check("GET config 200", st == 200, f"status={st}")
check("返回标题/欢迎语", cfg.get("title") == "示例商城客服" and cfg.get("welcome", "").startswith("你好"))
check("不带出内部字段（provider/tools/instructions）",
      not any(k in cfg for k in ("model", "tools", "instructions", "providerId", "knowledgeBaseIds")), list(cfg.keys()))
check("CORS 回显来源", hdrs.get("access-control-allow-origin") == "https://shop.example.com", hdrs.get("access-control-allow-origin"))

st, r, _ = api(f"/api/widget/config?agentId={AGENT}&key=wk_wrong")
check("错误 key → 403", st == 403, json.dumps(r, ensure_ascii=False)[:90])
st, r, _ = api("/api/widget/config?agentId=agent-not-exist&key=x")
check("不存在的 agent → 404", st == 404)

print("\n【3】访客会话与对话")
st, ses, hdrs = api("/api/widget/session", "POST", {"agentId": AGENT, "key": KEY}, origin="https://shop.example.com")
check("建会话 201", st == 201, f"status={st}")
SID, TOKEN = ses["sessionId"], ses["visitorToken"]
check("返回 sessionId 与 visitorToken", bool(SID) and len(TOKEN) >= 16, f"{SID} token={TOKEN[:8]}…")

st, ses2, _ = api("/api/widget/session", "POST", {"agentId": AGENT, "key": KEY, "sessionId": SID, "visitorToken": TOKEN}, origin="https://shop.example.com")
check("带 token 恢复同一会话", ses2.get("resumed") is True and ses2["sessionId"] == SID)

st, r, _ = api("/api/widget/session", "POST", {"agentId": AGENT, "key": KEY, "sessionId": SID, "visitorToken": "wrongtoken"}, origin="https://shop.example.com")
check("错误 token → 新建会话（不复用）", st == 201 and r.get("sessionId") != SID)

st, raw, _ = api("/api/widget/chat", "POST", {
    "agentId": AGENT, "key": KEY, "sessionId": SID, "visitorToken": TOKEN,
    "message": "只回复两个字：在线",
}, origin="https://shop.example.com", raw=True)
check("对话请求 200", st == 200, f"status={st}")
check("SSE 含文本增量", '"type": "text"' in raw.replace('"type":"text"', '"type": "text"') and "在线" in raw, raw[-200:].replace("\n", " ")[:150])
check("SSE 含 done", '"done"' in raw)
check("访客流不含 tool_call/tool_result 内部事件", "tool_result" not in raw)

st, hist, _ = api(f"/api/widget/messages?agentId={AGENT}&key={KEY}&sessionId={SID}&visitorToken={TOKEN}", origin="https://shop.example.com")
check("历史记录 200 且含双向消息", st == 200 and len(hist["messages"]) >= 2 and {m["role"] for m in hist["messages"]} == {"user", "assistant"},
      json.dumps([m["role"] for m in hist["messages"]], ensure_ascii=False))
check("历史过滤掉合成消息与工具消息", all(m["role"] in ("user", "assistant") and m["content"].strip() for m in hist["messages"]))

st, r, _ = api(f"/api/widget/messages?agentId={AGENT}&key={KEY}&sessionId={SID}&visitorToken=wrongtoken", origin="https://shop.example.com")
check("历史用错误 token → 403", st == 403)

print("\n【4】限流（后台设为 3 条/分钟）")
codes = []
for i in range(5):
    st, _, _ = api("/api/widget/chat", "POST", {
        "agentId": AGENT, "key": KEY, "sessionId": SID, "visitorToken": TOKEN,
        "message": f"限流测试 {i}",
    }, origin="https://shop.example.com", raw=True)
    codes.append(st)
check("超过阈值后返回 429", 429 in codes, f"状态序列={codes}")

print("\n【5】来源白名单")
api(f"/api/agents/{AGENT}/widget", "PUT", {"origins": "https://shop.example.com\n*.trusted.cn"})
st, r, _ = api(f"/api/widget/config?agentId={AGENT}&key={KEY}", origin="https://shop.example.com")
check("白名单内来源 → 200", st == 200, f"status={st}")
st, r, _ = api(f"/api/widget/config?agentId={AGENT}&key={KEY}", origin="https://blog.trusted.cn")
check("通配子域 → 200", st == 200, f"status={st}")
st, r, _ = api(f"/api/widget/config?agentId={AGENT}&key={KEY}", origin="https://evil.com")
check("白名单外来源 → 403", st == 403, json.dumps(r, ensure_ascii=False)[:90])
st, r, _ = api(f"/api/widget/config?agentId={AGENT}&key={KEY}")
check("无 Origin（非浏览器）→ 403", st == 403)

# 关闭后一切公开接口失效
api(f"/api/agents/{AGENT}/widget", "PUT", {"enabled": False, "origins": ""})
st, r, _ = api(f"/api/widget/config?agentId={AGENT}&key={KEY}", origin="https://shop.example.com")
check("关闭组件后 → 403", st == 403, json.dumps(r, ensure_ascii=False)[:80])
api(f"/api/agents/{AGENT}/widget", "PUT", {"enabled": True})

# 重置 key：旧 key 失效
st, after, _ = api(f"/api/agents/{AGENT}/widget", "PUT", {"resetKey": True})
NEW_KEY = after["settings"]["embedKey"]
check("重置后 key 变化", NEW_KEY != KEY, f"{KEY[:12]}… → {NEW_KEY[:12]}…")
st, r, _ = api(f"/api/widget/config?agentId={AGENT}&key={KEY}", origin="https://shop.example.com")
check("旧 key 立即失效（403）", st == 403)
st, r, _ = api(f"/api/widget/config?agentId={AGENT}&key={NEW_KEY}", origin="https://shop.example.com")
check("新 key 可用", st == 200)

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
if bad:
    print("失败项:")
    for b in bad:
        print("  -", b)
