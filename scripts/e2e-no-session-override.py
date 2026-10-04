import json, urllib.request, urllib.error, time
from playwright.sync_api import sync_playwright
BASE = "http://localhost:3000"
ok, bad = [], []
def check(label, cond, detail=""):
    (ok if cond else bad).append(label)
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail else ""))

def api(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    if data: req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            txt = r.read().decode()
            try:
                return r.status, (json.loads(txt) if txt else None)
            except json.JSONDecodeError:
                return r.status, txt   # SSE 等非 JSON 响应
    except urllib.error.HTTPError as e:
        return e.code, None

# 建一个临时会话用于验证
st, ses = api("/api/sessions", "POST", {"agentId": "deepseek-agent"})
sid = ses["id"]
print(f"临时会话 {sid}\n")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 950})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/chat/session/{sid}", wait_until="networkidle")
    page.wait_for_timeout(1800)

    print("【1】右上角不再有「会话覆盖」")
    header = page.locator(".chat-header")
    check("页面无「会话覆盖」文字", "会话覆盖" not in page.inner_text("body"))
    check("无「仅本会话」字样的面板", "仅本会话" not in page.inner_text("body"))
    check("header 只剩 agent 名与模型", header.count() == 1 and "deepseek" in header.inner_text().lower(),
          header.inner_text().replace(chr(10), " · ") if header.count() else "无 header")
    check("header 里没有按钮（覆盖入口已移除）", header.locator("button").count() == 0, f"buttons={header.locator('button').count()}")
    page.screenshot(path="/tmp/oa_no_session_settings.png")

    print("\n【2】对话仍然正常（真跑一轮 deepseek）")
    page.locator(".chat-main textarea").fill("只回复两个字：正常")
    page.locator(".chat-main textarea").press("Enter")
    reply = ""
    for _ in range(45):
        page.wait_for_timeout(1000)
        msgs = page.locator(".msg.assistant .bubble")
        if msgs.count() > 0:
            cur = msgs.last.inner_text()
            if cur and cur == reply:
                break
            reply = cur
    check("拿到模型回复", len(reply.strip()) > 0, reply[:40])

    print("\n【3】API：请求级覆盖参数已不接受（且不影响运行）")
    st, _ = api("/api/chat", "POST", {"agentId": "deepseek-agent", "sessionId": sid, "message": "x", "modelOverride": {"modelId": "不存在的模型"}})
    check("带 modelOverride 仍返回 200（该字段被忽略，不再切模型）", st == 200, f"status={st}")
    st, _ = api(f"/api/sessions/{sid}", "PATCH", {"modelOverride": {"modelId": "x"}})
    check("PATCH /api/sessions/[id] 已移除（405/404）", st in (404, 405), f"status={st}")

    check("无控制台错误", not errors, errors[:2])
    b.close()

api(f"/api/sessions/{sid}", "DELETE")
print(f"\n（已清理临时会话）\n通过 {len(ok)} / 失败 {len(bad)}")
for x in bad:
    print("  -", x)
