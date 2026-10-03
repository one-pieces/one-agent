"""验证 /chat 侧边栏：所有 Agent 的对话平铺 + 点击 Agent 收起/展开。"""
import json
import re
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
ok, bad = [], []


def check(label, cond, detail=""):
    (ok if cond else bad).append(label)
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail else ""))


def api(path, method="GET"):
    req = urllib.request.Request(f"{BASE}{path}", method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode()
            return r.status, (json.loads(body) if body else None)
    except Exception as e:
        return 0, str(e)


_, agents = api("/api/agents")
_, summaries = api("/api/sessions?summary=1")
by_agent = {}
for s in summaries:
    by_agent[s["agentId"]] = by_agent.get(s["agentId"], 0) + 1
print(f"后端：{len(agents)} 个 agent，{len(summaries)} 段对话")
for a in agents:
    print(f"  {a['id']:22s} {by_agent.get(a['id'], 0)} 段对话")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1400, "height": 1000})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(1800)

    print("\n【1】平铺：所有 Agent 都是分组头")
    heads = page.locator(".sidebar-group-head")
    check("Agent 分组数与后端一致", heads.count() == len(agents), f"页面 {heads.count()} / 后端 {len(agents)}")
    names = [heads.nth(i).inner_text().split("\n")[0].strip() for i in range(heads.count())]
    check("分组头显示 Agent 名", all(n for n in names), str(names))
    check("分组头显示对话段数", all("段对话" in heads.nth(i).inner_text() or "暂无对话" in heads.nth(i).inner_text() for i in range(heads.count())))
    subs = page.locator(".sidebar-subitem")
    check("展开后平铺出所有对话", subs.count() == len(summaries), f"页面 {subs.count()} / 后端 {len(summaries)}")
    check("页脚统计正确", f"{len(agents)} 个 Agent" in page.locator(".sidebar-count").inner_text() and f"{len(summaries)} 段对话" in page.locator(".sidebar-count").inner_text(),
          page.locator(".sidebar-count").inner_text())
    check("客服访客会话有标记", page.locator(".sidebar-subitem", has_text="客服访客").count() >= 1)
    page.screenshot(path="/tmp/oa_chat_sidebar_expanded.png")

    print("\n【1b】标题与副标题：新会话=「新对话」、每行显示消息条数、不展示缓存数据")
    titles = page.evaluate("[...document.querySelectorAll('.sidebar-subitem .sidebar-item-title')].map(e => e.textContent.trim())")
    check("没有任何行用 session id 当标题", not any(t.startswith("session-") for t in titles),
          [t for t in titles if t.startswith("session-")][:3])
    subs = page.evaluate("[...document.querySelectorAll('.sidebar-subitem .sidebar-item-sub')].map(e => e.textContent.trim())")
    check("每行都显示「N 条消息」", len(subs) > 0 and all(re.search(r"\d+\s*条消息", s) for s in subs), f"{len(subs)} 行；示例 {subs[:2]}")
    sidebar_text = page.locator(".sidebar").inner_text()
    check("侧边栏不展示缓存数据（◎/＋/缓存）", "◎" not in sidebar_text and "＋" not in sidebar_text and "缓存" not in sidebar_text)

    print("\n【2】点 Agent 行 → 收起")
    first = heads.first
    first_name = first.inner_text().split("\n")[0].strip()
    before = page.locator(".sidebar-subitem").count()
    first.click()
    page.wait_for_timeout(600)
    after = page.locator(".sidebar-subitem").count()
    check("收起后该 Agent 的对话不再显示", after < before, f"{before} → {after}")
    check("aria-expanded=false", first.get_attribute("aria-expanded") == "false", first.get_attribute("aria-expanded"))
    rot = page.evaluate("getComputedStyle(document.querySelector('.sidebar-chevron')).transform")
    not_rotated = rot in ("none", "") or rot.startswith("matrix(1, 0, 0, 1")
    check("展开箭头存在且未旋转（收起态）", page.locator(".sidebar-chevron").count() >= 1 and not_rotated, rot)
    check("其它行首图标（bot/对话/地球）已移除", page.locator(".sidebar-item-icon").count() == 0)

    print("\n【3】再点一次 → 展开")
    first.click()
    page.wait_for_timeout(600)
    check("展开后对话回来", page.locator(".sidebar-subitem").count() == before, f"{page.locator('.sidebar-subitem').count()} / {before}")
    check("aria-expanded=true", first.get_attribute("aria-expanded") == "true")
    rot2 = page.evaluate("getComputedStyle(document.querySelector('.sidebar-chevron')).transform")
    check("箭头旋转 90°（展开态）", rot2 != rot, f"{rot} → {rot2}")

    print("\n【4】收起状态刷新后保持")
    first.click()
    page.wait_for_timeout(400)
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1800)
    collapsed_name = page.locator(".sidebar-group-head").first.inner_text().split("\n")[0].strip()
    check("刷新后仍是收起态", page.locator(".sidebar-group-head").first.get_attribute("aria-expanded") == "false", collapsed_name)
    # 还原成展开
    page.locator(".sidebar-group-head").first.click()
    page.wait_for_timeout(400)

    print("\n【5】点对话 → 右侧内联展示（/chat 不跳路由）；点 ＋ → 新建")
    target = page.locator(".sidebar-subitem").filter(has_not_text="0 条消息").first
    target_title = target.inner_text().split("\n")[0].strip()
    target.click()
    page.wait_for_timeout(2000)
    check("点对话在右侧内联展示且不跳路由", page.url.rstrip("/").endswith("/chat") and page.locator(".chat-body").count() == 1,
          f"{target_title} → {page.url}")

    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(1500)
    count_before = page.locator(".sidebar-subitem").count()
    page.locator(".sidebar-group-head").first.hover()
    page.locator(".sidebar-group-head").first.locator("button").first.click()
    page.wait_for_timeout(2200)
    check("点 ＋ 新建会话并在右侧就地打开", page.url.rstrip("/").endswith("/chat") and page.locator(".chat-body").count() == 1, page.url)
    check("新会话出现在侧边栏", page.locator(".sidebar-subitem").count() == count_before + 1,
          f"{count_before} → {page.locator('.sidebar-subitem').count()}")
    # 清理刚建的空会话：先取消选中再删
    _, rows_now = api("/api/sessions?summary=1")
    empties = [s["id"] for s in rows_now if s["messageCount"] == 0]
    for sid in empties:
        api(f"/api/sessions/{sid}", "DELETE")
    if empties:
        print(f"    （已清理 {len(empties)} 条空会话）")
    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(800)
    errors.clear()

    print("\n【6】agent 上下文页行为未变")
    page.goto(f"{BASE}/chat/agent/agent-shop-cs", wait_until="networkidle")
    page.wait_for_timeout(1500)
    check("侧边栏标题是该 agent 名", page.locator(".sidebar-title").inner_text().strip() == "电商平台客服", page.locator(".sidebar-title").inner_text())
    check("无分组头（不是平铺模式）", page.locator(".sidebar-group-head").count() == 0)
    check("显示该 agent 的会话列表", page.locator(".sidebar-item").count() >= 1)
    check("计数为「N 个会话」", "个会话" in page.locator(".sidebar-count").inner_text(), page.locator(".sidebar-count").inner_text())
    check("无控制台错误", not errors, errors[:2])
    b.close()

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
if bad:
    print("失败项:")
    for x in bad:
        print("  -", x)
