"""验证消息 id 不再撞车：同一会话重复发同一句话 + 浏览器无 React key 警告。"""
import json, urllib.request, urllib.error
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
    with urllib.request.urlopen(req, timeout=180) as r:
        txt = r.read().decode()
        try:
            return r.status, (json.loads(txt) if txt else None)
        except json.JSONDecodeError:
            return r.status, txt

st, ses = api("/api/sessions", "POST", {"agentId": "deepseek-agent"})
sid = ses["id"]
print(f"临时会话 {sid}\n")

SAME = "只回复一个字：好"
for i in range(2):
    api("/api/chat", "POST", {"agentId": "deepseek-agent", "sessionId": sid, "message": SAME})
    print(f"  第 {i+1} 次发送完成")

st, full = api(f"/api/sessions/{sid}")
msgs = full["messages"]
ids = [m["id"] for m in msgs]
print("\n消息序列:")
for m in msgs:
    print(f"  {m['role']:9s} id={m['id'][:8]}…  {str(m.get('content'))[:26]!r}")

check("消息条数 = system + 2 轮 x 2 条", len(msgs) == 5, f"{len(msgs)}")
check("所有消息 id 唯一（不再复用同一个 id）", len(set(ids)) == len(ids), f"唯一 {len(set(ids))}/{len(ids)}")
users = [m for m in msgs if m["role"] == "user"]
check("两条内容相同的用户消息 id 不同", users[0]["id"] != users[1]["id"], f"{users[0]['id'][:8]} vs {users[1]['id'][:8]}")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 950})
    warnings = []
    page.on("console", lambda m: warnings.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/chat/session/{sid}", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.locator(".chat-main textarea").fill(SAME)
    page.locator(".chat-main textarea").press("Enter")
    page.wait_for_timeout(9000)
    dup = [w for w in warnings if "same key" in w]
    check("浏览器无 React key 重复警告", not dup, dup[:1])
    check("页面渲染出 4+ 条消息", page.locator(".msg").count() >= 4, f"{page.locator('.msg').count()}")
    b.close()

api(f"/api/sessions/{sid}", "DELETE")
print(f"\n（已清理临时会话）\n通过 {len(ok)} / 失败 {len(bad)}")
for x in bad: print("  -", x)
