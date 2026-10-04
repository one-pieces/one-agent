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
    _, live = api("/api/sessions?summary=1")
    live_ids = [s["id"] for s in live]
    dom_ids = set(page.evaluate("[...document.querySelectorAll('.sidebar-subitem')].map(e => e.dataset.sessionId)"))
    missing = [sid for sid in live_ids if sid not in dom_ids]
    check("后端每条会话在树里都有对应行（按 session id 子集核对，可并行跑）",
          not missing and len(dom_ids) >= len(live_ids), f"后端 {len(live_ids)} 条 / 页面 {len(dom_ids)} 行 / 缺 {missing[:3]}")
    check("全局页脚统计已去掉（改为每行显示条数）", page.locator(".sidebar-count").count() == 0)
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
    check("侧边栏行只有消息条数（无 ↑/↓ token 统计）", "↑" not in sidebar_text and "↓" not in sidebar_text)

    print("\n【2】点 Agent 行 → 收起（按 agent id / session id 判定，可并行跑）")
    # 选一个有会话的分组做收起/展开实验
    first = None
    for i in range(heads.count()):
        cand = heads.nth(i)
        if cand.evaluate("el => el.nextElementSibling && el.nextElementSibling.querySelectorAll('.sidebar-subitem').length > 0"):
            first = cand
            break
    first = first or heads.first
    first_name = first.inner_text().split("\n")[0].strip()
    target_agent = first.get_attribute("data-agent-id")
    child_ids = first.evaluate("el => [...el.nextElementSibling.querySelectorAll('.sidebar-subitem')].map(e => e.dataset.sessionId)")
    child_id = child_ids[0] if child_ids else ""
    sublist_sel = f'.sidebar-group-head[data-agent-id="{target_agent}"] + ul.sidebar-sublist .sidebar-subitem'
    first.click()
    page.wait_for_timeout(600)
    check("收起后该 Agent 的子列表清空（按 data-agent-id 定位）",
          page.locator(sublist_sel).count() == 0, f"{first_name} 子列表 {page.locator(sublist_sel).count()} 行")
    check("该 Agent 下的具体会话行（同一 session id）已不在 DOM",
          bool(child_id) and page.locator(f'.sidebar-subitem[data-session-id="{child_id}"]').count() == 0,
          f"{child_id}")
    check("aria-expanded=false", first.get_attribute("aria-expanded") == "false", first.get_attribute("aria-expanded"))
    rot = page.evaluate("getComputedStyle(document.querySelector('.sidebar-chevron')).transform")
    not_rotated = rot in ("none", "") or rot.startswith("matrix(1, 0, 0, 1")
    check("展开箭头存在且未旋转（收起态）", page.locator(".sidebar-chevron").count() >= 1 and not_rotated, rot)
    check("其它行首图标（bot/对话/地球）已移除", page.locator(".sidebar-item-icon").count() == 0)

    print("\n【3】再点一次 → 展开")
    first.click()
    page.wait_for_timeout(600)
    check("展开后该会话行回来（同一 session id）",
          bool(child_id) and page.locator(f'.sidebar-subitem[data-session-id="{child_id}"]').count() == 1, f"{child_id}")
    check("展开后子列表非空（按 data-agent-id 定位）", page.locator(sublist_sel).count() >= 1,
          f"{page.locator(sublist_sel).count()} 行")
    check("aria-expanded=true", first.get_attribute("aria-expanded") == "true")
    rot2 = page.evaluate("getComputedStyle(document.querySelector('.sidebar-chevron')).transform")
    check("箭头旋转 90°（展开态）", rot2 != rot, f"{rot} → {rot2}")

    print("\n【4】收起状态刷新后保持")
    first.click()
    page.wait_for_timeout(400)
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1800)
    collapsed_name = page.locator(".sidebar-group-head").first.inner_text().split("\n")[0].strip()
    check("刷新后仍是收起态", page.locator(f'.sidebar-group-head[data-agent-id="{target_agent}"]').get_attribute("aria-expanded") == "false", collapsed_name)
    check("刷新后该会话行仍隐藏（同一 session id）",
          bool(child_id) and page.locator(f'.sidebar-subitem[data-session-id="{child_id}"]').count() == 0, f"{child_id}")
    # 还原成展开
    page.locator(f'.sidebar-group-head[data-agent-id="{target_agent}"]').click()
    page.wait_for_timeout(600)
    check("还原后该会话行回来", bool(child_id) and page.locator(f'.sidebar-subitem[data-session-id="{child_id}"]').count() == 1, f"{child_id}")

    print("\n【5】点对话 → 右侧内联展示（/chat 不跳路由）；点 ＋ → 新建")
    target = page.locator(".sidebar-subitem").filter(has_not_text="0 条消息").first
    target_title = target.inner_text().split("\n")[0].strip()
    target.click()
    page.wait_for_timeout(2000)
    check("点对话在右侧内联展示且不跳路由", page.url.rstrip("/").endswith("/chat") and page.locator(".chat-body").count() == 1,
          f"{target_title} → {page.url}")

    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(1500)
    _, before_rows = api("/api/sessions?summary=1")
    before_ids = {s["id"] for s in before_rows}
    plus_head = page.locator(".sidebar-group-head").first
    plus_agent = plus_head.get_attribute("data-agent-id")
    plus_head.hover()
    plus_head.locator("button").first.click()
    check("点 ＋ 新建会话并在右侧就地打开", page.url.rstrip("/").endswith("/chat") and page.locator(".chat-body").count() == 1, page.url)
    # 新建后主区就地打开它 → 树里「当前高亮的那条」就是我自己建的（不看全局计数）
    page.wait_for_selector(".sidebar-subitem.active", timeout=10000)
    page.wait_for_timeout(1200)
    new_id = page.locator(".sidebar-subitem.active").first.get_attribute("data-session-id") or ""
    _, after_rows = api("/api/sessions?summary=1")
    row_data = next((s for s in after_rows if s["id"] == new_id), None)
    check("新建的会话就是当前高亮那条（属于刚点 ＋ 的 Agent，且是本次新增）",
          bool(new_id) and new_id not in before_ids and row_data is not None and row_data["agentId"] == plus_agent,
          f"new_id={new_id} agent={row_data['agentId'] if row_data else None} 期望={plus_agent}")
    check("新建的会话行在树里（按 data-session-id 定位）",
          bool(new_id) and page.locator(f'.sidebar-subitem[data-session-id="{new_id}"]').count() == 1, new_id)
    # 清理：只删自己建的这条（不碰其它脚本/别人的会话）
    if new_id:
        api(f"/api/sessions/{new_id}", "DELETE")
        print(f"    （已清理本次新建的会话 {new_id}）")
    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(1200)
    check("自己建的会话已从树里消失（其它会话不受影响）",
          not new_id or page.locator(f'.sidebar-subitem[data-session-id="{new_id}"]').count() == 0, new_id)
    errors.clear()

    print("\n【6】单列侧边栏：agent 上下文页也常驻同一棵会话树")
    page.goto(f"{BASE}/chat/agent/agent-shop-cs", wait_until="networkidle")
    page.wait_for_timeout(1500)
    check("侧边栏标题固定为「工作区」（不再随 agent 变）", page.locator(".sidebar-title").inner_text().strip() == "工作区", page.locator(".sidebar-title").inner_text())
    check("仍是平铺分组（单列侧边栏统一模式）", page.locator(".sidebar-group-head").count() >= 2,
          f"{page.locator('.sidebar-group-head').count()} 组")
    check("该 agent 的分组在树里", page.locator(".sidebar-group-head", has_text="电商平台客服").count() == 1)
    _, shop_rows = api("/api/sessions?summary=1")
    shop_ids = [s["id"] for s in shop_rows if s["agentId"] == "agent-shop-cs"]
    dom_now = set(page.evaluate("[...document.querySelectorAll('.sidebar-subitem')].map(e => e.dataset.sessionId)"))
    check("该 Agent 的每条会话在树里都有行（按 id 核对）+ 不再有全局计数行",
          all(sid in dom_now for sid in shop_ids) and page.locator(".sidebar-count").count() == 0,
          f"该 agent {len(shop_ids)} 条")
    check("无控制台错误", not errors, errors[:2])
    b.close()

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
if bad:
    print("失败项:")
    for x in bad:
        print("  -", x)
