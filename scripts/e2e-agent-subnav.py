"""验证 Agent 详情页二级导航：Agent 配置 / 工具 / 知识库 / 客服组件 / 对话记录，点击展示对应内容。"""
import json
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
AGENT = "agent-shop-cs"          # 有知识库关联 + 客服组件配置，便于断言
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
        with urllib.request.urlopen(req, timeout=90) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        return e.code, None


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 950})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    print("【1】二级导航项目与顺序")
    page.goto(f"{BASE}/agents/{AGENT}", wait_until="networkidle")
    page.wait_for_timeout(1500)
    nav = page.locator("nav.agent-subnav")
    labels = [nav.locator("a").nth(i).inner_text().strip() for i in range(nav.locator("a").count())]
    check("导航为 配置/工具/知识库/客服组件/对话记录",
          labels == ["Agent 配置", "工具", "知识库", "客服组件", "对话记录"], str(labels))
    hrefs = [nav.locator("a").nth(i).get_attribute("href") for i in range(nav.locator("a").count())]
    check("链接指向各子页",
          hrefs == [f"/agents/{AGENT}", f"/agents/{AGENT}/tools", f"/agents/{AGENT}/knowledge",
                    f"/agents/{AGENT}/widget", f"/agents/{AGENT}/sessions"], str(hrefs))
    check("默认高亮 Agent 配置", "active" in (nav.locator("a").nth(0).get_attribute("class") or ""))

    print("\n【2】配置页只剩基础配置（工具/知识库/客服组件已移出）")
    body = page.inner_text(".agent-split-body")
    check("有基础配置标题", "基础配置" in body)
    check("配置页不再出现工具开关列表", page.locator(".agent-split-body .tool-item-switch").count() == 0,
          f"{page.locator('.agent-split-body .tool-item-switch').count()} 个开关")
    check("配置页不再出现客服组件卡片", "嵌入网站" not in body and "复制嵌入代码" not in body)
    check("提示指向子页", "工具、知识库、客服组件已分到左侧" in body)
    page.screenshot(path="/tmp/oa_subnav_config.png")

    print("\n【3】工具页：列表 + 规划开关 + 保存往返")
    nav.get_by_role("link", name="工具").click()
    page.wait_for_url(f"**/agents/{AGENT}/tools", timeout=8000)
    page.wait_for_timeout(1500)
    check("URL 是 /tools", page.url.endswith(f"/agents/{AGENT}/tools"), page.url)
    check("高亮切到「工具」", "active" in (nav.locator("a").nth(1).get_attribute("class") or ""))
    switches = page.locator(".tool-item-switch")
    check("工具开关列表渲染", switches.count() >= 5, f"{switches.count()} 项")
    check("含危险工具标记", page.locator(".danger-tag").count() >= 1)
    check("有规划开关", page.get_by_text("规划（自规划规程）").count() == 1)
    page.screenshot(path="/tmp/oa_subnav_tools.png")

    before = api(f"/api/agents/{AGENT}")[1]
    # 找一个当前开启的非关键工具（bash 在 agent-shop-cs 上本来是关的，这里开/关都验证一遍）
    target = "ls"
    row = page.locator(".tool-item-switch", has=page.locator(f"code:text-is('{target}')"))
    was_on = next((t["enabled"] for t in before["tools"] if t["name"] == target), False)
    row.hover()
    row.locator("button").first.click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="保存工具配置").click()
    page.wait_for_timeout(2000)
    after = api(f"/api/agents/{AGENT}")[1]
    now_on = next((t["enabled"] for t in after["tools"] if t["name"] == target), False)
    check(f"切换 {target} 后保存生效（{was_on} → {now_on}）", now_on != was_on, f"{was_on} → {now_on}")
    check("只改了工具段（名称/指令未被波及）", after["name"] == before["name"] and after["instructions"] == before["instructions"])
    check("工具页有保存成功提示", "已保存" in page.inner_text(".agent-split-body"))
    # 还原
    row2 = page.locator(".tool-item-switch", has=page.locator(f"code:text-is('{target}')"))
    row2.hover()
    row2.locator("button").first.click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="保存工具配置").click()
    page.wait_for_timeout(2000)
    restored = api(f"/api/agents/{AGENT}")[1]
    check("已还原原值", next((t["enabled"] for t in restored["tools"] if t["name"] == target), None) == was_on)

    print("\n【4】知识库页：关联状态与保存往返（含 knowledge_search 自动增删）")
    nav.get_by_role("link", name="知识库").click()
    page.wait_for_url(f"**/agents/{AGENT}/knowledge", timeout=8000)
    page.wait_for_timeout(1500)
    check("URL 是 /knowledge", page.url.endswith(f"/agents/{AGENT}/knowledge"), page.url)
    check("高亮切到「知识库」", "active" in (nav.locator("a").nth(2).get_attribute("class") or ""))
    kb_rows = page.locator(".tool-item-switch")
    check("知识库列表渲染", kb_rows.count() >= 1, f"{kb_rows.count()} 个")
    linked_before = api(f"/api/agents/{AGENT}")[1]["knowledgeBaseIds"] or []
    check("页面忠实反映已关联状态（开关为开）", "已自动启用 knowledge_search" in page.inner_text(".agent-split-body") or not linked_before,
          str(linked_before))
    page.screenshot(path="/tmp/oa_subnav_knowledge.png")
    # 取消关联 → 保存 → knowledge_search 应被移除；再恢复
    kb_rows.first.hover()
    kb_rows.first.locator("button").first.click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="保存知识库关联").click()
    page.wait_for_timeout(2200)
    after_kb = api(f"/api/agents/{AGENT}")[1]
    check("取消关联后 knowledgeBaseIds 清空", (after_kb["knowledgeBaseIds"] or []) == [], str(after_kb["knowledgeBaseIds"]))
    check("knowledge_search 工具被移除", not any(t["name"] == "knowledge_search" for t in after_kb["tools"]))
    rows2 = page.locator(".tool-item-switch")
    rows2.first.hover()
    rows2.first.locator("button").first.click()
    page.wait_for_timeout(300)
    page.get_by_role("button", name="保存知识库关联").click()
    page.wait_for_timeout(2200)
    restored_kb = api(f"/api/agents/{AGENT}")[1]
    check("恢复关联成功", (restored_kb["knowledgeBaseIds"] or []) == linked_before, str(restored_kb["knowledgeBaseIds"]))
    check("knowledge_search 工具回来了", any(t["name"] == "knowledge_search" and t["enabled"] for t in restored_kb["tools"]))

    print("\n【5】客服组件页")
    nav.get_by_role("link", name="客服组件").click()
    page.wait_for_url(f"**/agents/{AGENT}/widget", timeout=8000)
    page.wait_for_timeout(2000)
    check("URL 是 /widget", page.url.endswith(f"/agents/{AGENT}/widget"), page.url)
    check("高亮切到「客服组件」", "active" in (nav.locator("a").nth(3).get_attribute("class") or ""))
    widget_text = page.inner_text(".agent-split-body")
    check("渲染出客服组件卡片（嵌入代码/来源白名单）",
          "嵌入网站" in widget_text or "嵌入代码" in widget_text or "embed" in widget_text.lower(),
          widget_text.replace("\n", " ")[:70])
    page.screenshot(path="/tmp/oa_subnav_widget.png")

    print("\n【6】对话记录页仍可用")
    nav.get_by_role("link", name="对话记录").click()
    page.wait_for_url(f"**/agents/{AGENT}/sessions", timeout=8000)
    page.wait_for_timeout(1500)
    check("URL 是 /sessions", page.url.endswith(f"/agents/{AGENT}/sessions"), page.url)
    check("高亮切到「对话记录」", "active" in (nav.locator("a").nth(4).get_attribute("class") or ""))
    check("会话列表渲染", page.locator(".card").count() >= 1 or "暂无" in page.inner_text(".agent-split-body"))
    page.screenshot(path="/tmp/oa_subnav_sessions.png")

    real_errors = [e for e in errors if "404" not in e]
    check("无意外控制台错误", not real_errors, real_errors[:2])
    b.close()

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
for x in bad:
    print("  -", x)
