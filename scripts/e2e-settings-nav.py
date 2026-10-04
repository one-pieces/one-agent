"""验证：导航精简为 Agent/知识库 + 底部设置；供应商与日志收进 /settings。"""
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


_, provs = api("/api/providers")
first_id = provs[0]["id"]

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 950})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    print("【1】左侧导航：只剩 Agent / 知识库，底部是设置")
    page.goto(f"{BASE}/chat", wait_until="networkidle")
    page.wait_for_timeout(1500)
    rail = page.locator("nav.app-nav")
    items = rail.locator("a.app-nav-item")
    labels = [items.nth(i).inner_text().strip() for i in range(items.count())]
    print("    导航项:", labels)
    check("导航项为 对话/Agents/知识库/设置", labels == ["对话", "Agents", "知识库", "设置"], str(labels))
    check("不再有「供应商」入口", "供应商" not in labels)
    check("不再有「日志」入口", "日志" not in labels)

    geo = page.evaluate("""() => {
      const rail = document.querySelector('nav.app-nav').getBoundingClientRect();
      const items = [...document.querySelectorAll('nav.app-nav a.app-nav-item')];
      const last = items[items.length - 1].getBoundingClientRect();
      const theme = document.querySelector('nav.app-nav button');
      return { railBottom: +rail.bottom.toFixed(1), lastTop: +last.top.toFixed(1), lastLabel: items[items.length-1].innerText.trim(),
               themeBottom: theme ? +theme.getBoundingClientRect().bottom.toFixed(1) : null, viewportH: innerHeight };
    }""")
    print("    几何:", json.dumps(geo))
    check("「设置」在导航最底部（接近视口底）", geo["viewportH"] - geo["railBottom"] < 40 and geo["lastLabel"] == "设置",
          f"rail 底部距视口 {round(geo['viewportH'] - geo['railBottom'])}px")
    check("主题开关在设置之上", geo["themeBottom"] is not None and geo["themeBottom"] <= geo["lastTop"] + 1,
          f"theme.bottom={geo['themeBottom']} settings.top={geo['lastTop']}")
    page.screenshot(path="/tmp/oa_nav_settings_bottom.png")

    print("\n【2】/settings 打开即供应商，二级导航可切换")
    page.goto(f"{BASE}/settings", wait_until="networkidle")
    page.wait_for_timeout(1200)
    check("/settings 跳到 /settings/providers", page.url.rstrip("/").endswith("/settings/providers"), page.url)
    check("页面标题是「设置」", page.locator("h1").first.inner_text().strip() == "设置", page.locator("h1").first.inner_text())
    subs = page.locator("nav.agent-subnav .agent-subnav-item")
    check("二级导航两项：供应商 / 日志",
          [subs.nth(i).inner_text().strip() for i in range(subs.count())] == ["供应商", "日志"],
          [subs.nth(i).inner_text().strip() for i in range(subs.count())])
    check("当前高亮「供应商」", "active" in (subs.nth(0).get_attribute("class") or ""))
    check("供应商列表渲染出来", page.locator(".card").count() == len(provs), f"{page.locator('.card').count()} / {len(provs)}")
    check("左侧导航「设置」高亮", "active" in (rail.locator("a.app-nav-item").last.get_attribute("class") or ""))
    page.screenshot(path="/tmp/oa_settings_providers.png")

    print("\n【3】切到日志")
    subs.nth(1).click()
    page.wait_for_timeout(1200)
    check("URL 变为 /settings/logs", page.url.rstrip("/").endswith("/settings/logs"), page.url)
    check("日志表格或空状态渲染", page.locator(".log-table").count() == 1 or "暂无请求" in page.inner_text("body"))
    check("当前高亮「日志」", "active" in (subs.nth(1).get_attribute("class") or ""))
    page.screenshot(path="/tmp/oa_settings_logs.png")

    print("\n【4】供应商的增改路径都在 /settings 下")
    page.goto(f"{BASE}/settings/providers", wait_until="networkidle")
    page.wait_for_timeout(1000)
    check("新建入口指向 /settings/providers/new",
          page.get_by_role("link", name="新建供应商").get_attribute("href") == "/settings/providers/new")
    check("编辑入口指向 /settings/providers/<id>",
          page.locator(".card", has_text=provs[0]["name"]).get_by_role("link", name="编辑").get_attribute("href") == f"/settings/providers/{first_id}",
          page.locator(".card", has_text=provs[0]["name"]).get_by_role("link", name="编辑").get_attribute("href"))
    page.get_by_role("link", name="新建供应商").click()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(800)
    check("新建页可打开", page.url.endswith("/settings/providers/new"), page.url)
    page.locator(".page input").nth(0).fill("设置页测试")
    page.locator(".page input").nth(1).fill("https://s.example.com/v1")
    page.get_by_role("button", name="创建供应商").click()
    try:
        page.wait_for_url("**/settings/providers", timeout=8000)
    except Exception:
        pass
    page.wait_for_timeout(1200)
    check("创建后回到 /settings/providers 且出现卡片",
          page.url.rstrip("/").endswith("/settings/providers") and page.locator(".card", has_text="设置页测试").count() == 1,
          page.url)

    print("\n【5】旧地址仍可用（重定向）")
    for old, expect in [("/providers", "/settings/providers"), ("/logs", "/settings/logs"), (f"/providers/{first_id}", f"/settings/providers/{first_id}")]:
        page.goto(f"{BASE}{old}", wait_until="networkidle")
        page.wait_for_timeout(600)
        check(f"{old} → {expect}", page.url.rstrip("/").endswith(expect.rstrip("/")), page.url)

    real_errors = [e for e in errors if "404" not in e]
    check("无意外控制台错误", not real_errors, real_errors[:2])
    b.close()

# 清理
_, rows = api("/api/providers")
for r in rows:
    if r["name"].startswith("设置页测试"):
        api(f"/api/providers/{r['id']}", "DELETE")
print("\n（已清理测试供应商）")
print(f"通过 {len(ok)} / 失败 {len(bad)}")
for x in bad:
    print("  -", x)
