"""验证：单列侧边栏（线框图结构）+ 主区跟随导航。"""
import json
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
        with urllib.request.urlopen(req, timeout=60) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        return e.code, None


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 950})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    print("【1】侧边栏结构：会话树在主体，底部 亮色 / 知识库 / 设置")
    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(1800)
    geo = page.evaluate("""() => {
      const q = (s) => document.querySelector(s);
      const box = (el) => el ? el.getBoundingClientRect() : null;
      const sb = q('.app-sidebar');
      return {
        sidebar: box(sb) && { w: +box(sb).width.toFixed(1), x: box(sb).x, right: +box(sb).right.toFixed(1), h: +box(sb).height.toFixed(1) },
        shellDisplay: getComputedStyle(q('.app-shell')).display,
        titleRows: document.querySelectorAll('.app-sidebar-title').length,
        navRows: document.querySelectorAll('.app-sidebar-nav-item').length,
        divider: document.querySelectorAll('.app-sidebar-divider').length,
        sidebarY: +box(q('.app-sidebar')).y.toFixed(1),
        firstGroupY: box(q('.sidebar-group-head')) ? +box(q('.sidebar-group-head')).y.toFixed(1) : null,
        treeY: box(q('.app-sidebar-tree')) ? +box(q('.app-sidebar-tree')).y.toFixed(1) : null,
        bottomY: box(q('.app-sidebar-bottom')) ? +box(q('.app-sidebar-bottom')).y.toFixed(1) : null,
        bottomItems: [...document.querySelectorAll('.app-sidebar-bottom-item')].map(e => e.textContent.trim()),
        bottomYs: [...document.querySelectorAll('.app-sidebar-bottom-item')].map(e => +e.getBoundingClientRect().y.toFixed(1)),
        mainX: box(q('.app-main')) ? +box(q('.app-main')).x.toFixed(1) : null,
        mainW: box(q('.app-main')) ? +box(q('.app-main')).width.toFixed(1) : null,
        oldNav: document.querySelectorAll('.app-nav').length,
        groups: document.querySelectorAll('.sidebar-group-head').length,
        subs: document.querySelectorAll('.sidebar-subitem').length,
      };
    }""")
    print("    几何:", json.dumps(geo, ensure_ascii=False))
    check("外壳仍是 flex 全高（height=100vh）", geo["shellDisplay"] == "flex")
    check("侧边栏单列 300px，主区在右", geo["sidebar"]["w"] == 300 and geo["mainX"] == geo["sidebar"]["right"],
          f"sidebar={geo['sidebar']['w']} main.x={geo['mainX']} sidebar.right={geo['sidebar']['right']}")
    check("旧的 56px 图标导航栏已不存在", geo["oldNav"] == 0)
    check("顶部的 Agent 标题已去掉", geo["titleRows"] == 0, f"命中 {geo['titleRows']} 个")
    check("侧边栏最上面一行是「工作区」",
          page.locator(".sidebar-title").first.inner_text().strip() == "工作区", page.locator(".sidebar-title").first.inner_text())
    check("顶部不再有导航项与横线", geo["navRows"] == 0 and geo["divider"] == 0,
          f"nav={geo['navRows']} divider={geo['divider']}")
    check("会话树是侧边栏最上面的内容（紧贴侧边栏顶部）",
          geo["firstGroupY"] is not None and geo["firstGroupY"] - geo["sidebarY"] < 60,
          f"sidebar.y={geo['sidebarY']} 首个分组 y={geo['firstGroupY']}")
    check("顺序：会话树 → 底部行", geo["treeY"] < geo["bottomY"], f"{geo['treeY']} < {geo['bottomY']}")
    check("会话树是 Agent 分组 + 缩进对话", geo["groups"] >= 2 and geo["subs"] >= 2, f"{geo['groups']} 组 / {geo['subs']} 条")
    check("底部三项且依次为 亮色 / 知识库 / 设置",
          geo["bottomItems"] == ["亮色", "知识库", "设置"] or geo["bottomItems"] == ["暗色", "知识库", "设置"],
          str(geo["bottomItems"]))
    check("知识库在设置上面（像素 y 更小）", geo["bottomItems"][-2] == "知识库" and geo["bottomItems"][-1] == "设置"
          and geo["bottomYs"][-2] < geo["bottomYs"][-1], f"{geo['bottomYs']}")
    page.screenshot(path="/tmp/oa_new_sidebar_chat.png")

    print("\n【2】主区跟随导航：知识库")
    page.get_by_role("link", name="知识库").click()
    page.wait_for_url("**/knowledge", timeout=8000)
    page.wait_for_timeout(1500)
    check("主区显示知识库页（h1=知识库）", page.locator(".app-main h1").first.inner_text().strip() == "知识库",
          page.locator(".app-main h1").first.inner_text())
    check("底部「知识库」高亮", "active" in (page.locator(".app-sidebar-bottom-item", has_text="知识库").get_attribute("class") or ""))
    check("侧边栏仍在（未随路由消失）", page.locator(".app-sidebar").count() == 1 and page.locator(".sidebar-group-head").count() >= 2)
    page.screenshot(path="/tmp/oa_new_sidebar_knowledge.png")

    print("\n【3】主区跟随导航：设置")
    page.locator(".app-sidebar-bottom-item", has_text="设置").click()
    page.wait_for_url("**/settings/providers", timeout=8000)
    page.wait_for_timeout(1200)
    check("主区显示设置页（h1=设置）", page.locator(".app-main h1").first.inner_text().strip() == "设置",
          page.locator(".app-main h1").first.inner_text())
    check("底部「设置」高亮", "active" in (page.locator(".app-sidebar-bottom-item", has_text="设置").get_attribute("class") or ""))

    print("\n【4】点会话 → 主区就地打开（不跳路由）")
    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(600)
    page.wait_for_timeout(1500)
    target = page.locator(".sidebar-subitem").filter(has_not_text="0 条消息").first
    if target.count() == 0:
        target = page.locator(".sidebar-subitem").first
    title = target.locator(".sidebar-item-title").inner_text().strip()
    target.click()
    page.wait_for_timeout(2500)
    check("URL 仍是 /chat（未跳转）", page.url.rstrip("/").endswith("/chat"), page.url)
    check("主区渲染出对话（有输入框）", page.locator(".app-main textarea").count() >= 1)
    check("被点的会话高亮", page.locator(".sidebar-subitem.active").count() >= 1)
    check("高亮的就是点的那条", title in (page.locator(".sidebar-subitem.active").inner_text() or ""), title)
    page.screenshot(path="/tmp/oa_new_sidebar_session.png")

    print("\n【5】树里 ＋ 新建 → 主区就地打开新对话")
    before = page.locator(".sidebar-subitem").count()
    page.locator(".sidebar-group-head").nth(1).hover()
    page.locator(".sidebar-group-head").nth(1).locator(".sidebar-item-delete").click()
    page.wait_for_timeout(2500)
    check("新会话出现在树里", page.locator(".sidebar-subitem").count() == before + 1,
          f"{page.locator('.sidebar-subitem').count()} / {before + 1}")
    check("主区切到新对话（仍有输入框）", page.locator(".app-main textarea").count() >= 1)
    # 清理：删掉刚建的临时会话
    new_row = page.locator(".sidebar-subitem.active").first
    if new_row.count():
        page.once("dialog", lambda d: d.accept())
        new_row.hover()
        new_row.locator(".sidebar-item-delete").click()
        page.wait_for_timeout(1500)
    check("临时会话已清理", page.locator(".sidebar-subitem").count() == before,
          f"{page.locator('.sidebar-subitem').count()} / {before}")

    print("\n【6】其它路由仍可用")
    for path, expect in [("/agents", "Agents"), ("/settings/logs", "设置")]:
        page.goto(f"{BASE}{path}", wait_until="networkidle")
        page.wait_for_timeout(1200)
        check(f"{path} 正常且侧边栏在", expect in page.inner_text(".app-main") and page.locator(".app-sidebar").count() == 1)
    # 树里点会话应从非 /chat 路由跳到 /chat/session/<id>
    page.locator(".sidebar-subitem").first.click()
    page.wait_for_timeout(2500)
    check("非 /chat 路由点会话 → 跳 /chat/session/<id>", "/chat/session/" in page.url, page.url)
    check("主区渲染对话", page.locator(".app-main textarea").count() >= 1)

    real_errors = [e for e in errors if "404" not in e]
    check("无意外控制台错误", not real_errors, real_errors[:2])
    b.close()

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
for x in bad:
    print("  -", x)
