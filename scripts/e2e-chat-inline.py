"""验证 /chat 点对话是右侧内联展示（不跳路由）+ 刷新保持 + 交互可用。"""
import json
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
ok, bad = [], []


def check(label, cond, detail=""):
    (ok if cond else bad).append(label)
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail else ""))


def api(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        return e.code, None


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 950})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(2000)

    print("【1】初始：右侧是空状态")
    check("URL 停在 /chat", page.url.rstrip("/").endswith("/chat"), page.url)
    check("右侧显示空状态引导", "点任意一条即可在右侧查看" in page.inner_text(".empty-state"), page.inner_text(".empty-state")[:60])

    print("\n【2】点侧边栏里的对话 → 右侧内联展示，不跳路由")
    # 选一条**有内容**的对话（副标题含「N 条消息」且不是 0 条）
    target = page.locator(".sidebar-subitem").filter(has_not_text="0 条消息").first
    if target.count() == 0:
        target = page.locator(".sidebar-subitem").first
    title = target.inner_text().split("\n")[0].strip()
    target.click()
    page.wait_for_timeout(2500)
    check("URL 仍是 /chat（没有跳到 /chat/session/…）", page.url.rstrip("/").endswith("/chat"), page.url)
    check("右侧渲染出对话正文（.chat-body 存在）", page.locator(".chat-body").count() == 1)
    check("右侧显示的是被点的那条对话", title[:8] in page.inner_text(".chat-main"), f"标题={title[:20]}")
    check("空状态已消失", page.locator(".empty-state").count() == 0)
    check("该行在侧边栏高亮", "active" in (target.get_attribute("class") or ""), target.get_attribute("class"))
    check("输入框可用", page.locator(".chat-main textarea").count() == 1)
    page.screenshot(path="/tmp/oa_chat_inline.png")

    print("\n【3】切到另一条对话")
    second = page.locator(".sidebar-subitem").filter(has_not_text="0 条消息").nth(1)
    if second.count() == 0:
        second = page.locator(".sidebar-subitem").nth(1)
    t2 = second.inner_text().split("\n")[0].strip()
    second.click()
    page.wait_for_timeout(2500)
    check("仍停在 /chat", page.url.rstrip("/").endswith("/chat"), page.url)
    check("右侧换成了第二条对话", t2[:8] in page.inner_text(".chat-main"), f"标题={t2[:20]}")

    print("\n【4】刷新后仍停在同一段对话")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(2500)
    check("刷新后右侧仍是那段对话", page.locator(".chat-body").count() == 1 and t2[:8] in page.inner_text(".chat-main"), page.url)

    print("\n【5】用临时会话验证：内联对话里发消息（真跑一轮 deepseek）→ 删除后右侧清空")
    st, temp = api("/api/sessions", "POST", {"agentId": "agent-shop-cs"})
    temp_id = temp["id"]
    print(f"    （新建临时会话 {temp_id}）")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(2200)
    # 新会话标题是「新对话」（不显示 session id）；刚建的最活跃 → 排在第一行
    row = page.locator(".sidebar-subitem").first
    check("新会话出现在侧边栏且标题为「新对话」", "新对话" in row.inner_text() and temp_id not in row.inner_text(),
          row.inner_text().replace(chr(10), " · ")[:50])
    row.click()
    page.wait_for_timeout(2500)
    check("点它同样内联展示、不跳路由", page.url.rstrip("/").endswith("/chat") and page.locator(".chat-body").count() == 1, page.url)

    before = page.locator(".msg").count()
    page.locator(".chat-main textarea").fill("只回复两个字：收到")
    page.locator(".chat-main textarea").press("Enter")
    page.wait_for_timeout(1000)
    reply = ""
    for _ in range(45):
        page.wait_for_timeout(1000)
        msgs = page.locator(".msg.assistant .bubble")
        if msgs.count() > 0:
            cur = msgs.last.inner_text()
            if cur and cur == reply:
                break
            reply = cur
    check("消息数增加", page.locator(".msg").count() > before, f"{before} → {page.locator('.msg').count()}")
    check("拿到了模型回复", len(reply.strip()) > 0, reply[:40])
    check("侧边栏该对话标题/token 已更新", temp_id not in page.locator(".sidebar-subitem", has_text="收到").inner_text() if page.locator(".sidebar-subitem", has_text="收到").count() else False,
          page.locator(".sidebar-subitem", has_text="收到").inner_text().replace(chr(10), " ")[:60] if page.locator(".sidebar-subitem", has_text="收到").count() else "未找到")
    page.screenshot(path="/tmp/oa_chat_inline_chat.png")

    print("\n【6】删除当前打开的对话 → 右侧回到空状态")
    page.on("dialog", lambda d: d.accept())
    target_row = page.locator(".sidebar-subitem", has_text="收到")   # 聊过之后标题变成首条用户消息
    if target_row.count() == 0:
        target_row = page.locator(".sidebar-subitem").first
    target_row.first.hover()
    target_row.first.locator("button").click()
    page.wait_for_timeout(2500)
    check("删除后右侧回到空状态", page.locator(".empty-state").count() == 1, f"chat-body={page.locator('.chat-body').count()}")
    check("URL 仍是 /chat", page.url.rstrip("/").endswith("/chat"), page.url)
    check("临时会话已从侧边栏消失", page.locator(".sidebar-subitem", has_text="收到").count() == 0)

    print("\n【7】深链页面（/chat/session/…）仍然可用")
    sid = [s["id"] for s in api("/api/sessions?agentId=agent-shop-cs")[1]][0]
    page.goto(f"{BASE}/chat/session/{sid}", wait_until="networkidle")
    page.wait_for_timeout(1500)
    check("直接打开会话 URL 正常", page.locator(".chat-body").count() == 1, page.url)
    check("此时侧边栏是该 Agent 的会话列表（非平铺）", page.locator(".sidebar-group-head").count() == 0)
    check("无控制台错误", not [e for e in errors if "404" not in e], errors[:2])
    b.close()

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
if bad:
    print("失败项:")
    for x in bad:
        print("  -", x)
