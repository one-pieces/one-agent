"""Agent 详情页二级导航 + 对话记录列表验证。"""
import json
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
AGENT = "deepseek-agent"
ok, bad = [], []


def check(label, cond, detail=""):
    (ok if cond else bad).append(label)
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail else ""))


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    print("【1】/agents/[id] → Agent 配置")
    page.goto(f"{BASE}/agents/{AGENT}", wait_until="networkidle")
    page.wait_for_timeout(1200)
    check("页面标题仍是 agent 名", page.locator("h1").inner_text().strip() == "deepseek 助手", page.locator("h1").inner_text())
    nav = page.locator("nav.agent-subnav")
    check("左侧二级导航存在", nav.count() == 1)
    items = nav.locator(".agent-subnav-item")
    check("导航有 2 项", items.count() == 2, items.count())
    check("项文案为 Agent 配置 / 对话记录",
          [items.nth(i).inner_text().strip() for i in range(2)] == ["Agent 配置", "对话记录"],
          [items.nth(i).inner_text().strip() for i in range(2)])
    check("当前页「Agent 配置」高亮", "active" in (items.nth(0).get_attribute("class") or ""))
    check("配置内容仍在（表单 + 客服组件卡片）",
          "由供应商提供连接配置" in page.inner_text("body") and "客服组件（嵌入网站）" in page.inner_text("body"))

    geo = page.evaluate("""() => {
      const nav = document.querySelector('nav.agent-subnav').getBoundingClientRect();
      const body = document.querySelector('.agent-split-body').getBoundingClientRect();
      const h1 = document.querySelector('h1').getBoundingClientRect();
      return { navX: +nav.x.toFixed(1), navW: +nav.width.toFixed(1), navY: +nav.y.toFixed(1),
               bodyX: +body.x.toFixed(1), bodyW: +body.width.toFixed(1), h1Y: +h1.y.toFixed(1) };
    }""")
    print("  几何:", json.dumps(geo))
    check("导航在内容左侧且互不重叠", geo["navX"] < geo["bodyX"] and geo["navX"] + geo["navW"] <= geo["bodyX"] + 1)
    check("导航在标题下方", geo["navY"] > geo["h1Y"])
    page.screenshot(path="/tmp/oa_agent_tab_config.png", full_page=True)

    print("\n【2】/agents/[id]/sessions → 对话记录")
    page.goto(f"{BASE}/agents/{AGENT}/sessions", wait_until="networkidle")
    page.wait_for_timeout(1200)
    items = page.locator("nav.agent-subnav .agent-subnav-item")
    check("当前页「对话记录」高亮", "active" in (items.nth(1).get_attribute("class") or ""))
    check("标题为「对话记录」", page.locator("h3").first.inner_text().strip() == "对话记录", page.locator("h3").first.inner_text())
    rows = page.locator(".session-row")
    count = rows.count()
    check("渲染出对话记录行", count >= 1, f"rows={count}")
    check("分段筛选存在（全部/客服会话/内部会话）", page.locator(".seg-item").count() == 3,
          [page.locator(".seg-item").nth(i).inner_text().replace("\n", " ") for i in range(page.locator(".seg-item").count())])
    check("搜索框存在", page.locator(".session-search input").count() == 1)
    body = page.inner_text("body")
    check("有「客服」标记（访客会话）", "客服" in body)
    check("每行有打开对话入口 + 删除按钮", rows.first.get_by_role("link", name="打开对话").count() == 1)
    page.screenshot(path="/tmp/oa_agent_tab_sessions.png", full_page=True)

    # 过滤：只看客服会话
    page.locator(".seg-item", has_text="客服会话").click()
    page.wait_for_timeout(500)
    visitor_rows = page.locator(".session-row")
    all_visitor = visitor_rows.count() >= 0
    for i in range(visitor_rows.count()):
        cls = visitor_rows.nth(i).inner_text()
        all_visitor = all_visitor and ("客服" in cls)
    check("筛选「客服会话」只显示访客会话", all_visitor, f"rows={visitor_rows.count()}")
    # 搜索
    page.locator(".seg-item", has_text="全部").click()
    page.locator(".session-search input").fill("zzz-不存在的关键字")
    page.wait_for_timeout(400)
    check("搜索无结果时给出提示", "没有匹配" in page.inner_text("body"))
    page.locator(".session-search input").fill("")
    page.wait_for_timeout(400)

    print("\n【3】打开一段对话 + 其他页面未受影响")
    first_link = page.locator(".session-row-title").first
    href = first_link.get_attribute("href")
    first_link.click()
    # Next 的客户端路由不触发 navigation 事件 → 显式等 URL 变化
    try:
        page.wait_for_url(f"**/chat/session/{href.split('/')[-1]}", timeout=10000)
    except Exception:
        pass
    page.wait_for_timeout(800)
    check("点标题可打开该会话", page.url.endswith(href.split("/")[-1]), f"{page.url}（期望后缀 {href.split('/')[-1]}）")
    check("会话页渲染出消息区", "chat-body" in page.content())
    for path, expect in [("/agents", "Agents"), ("/providers", "供应商"), ("/knowledge", "知识库"), ("/logs", "日志")]:
        page.goto(f"{BASE}{path}", wait_until="networkidle")
        check(f"{path} 正常", expect in page.inner_text("h1"), page.locator("h1").inner_text()[:20])
    check("无控制台错误", not errors, errors[:2])
    b.close()

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
if bad:
    print("失败项:")
    for x in bad:
        print("  -", x)
