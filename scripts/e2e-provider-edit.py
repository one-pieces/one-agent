"""验证供应商页：编辑/新建进入独立页面（不是弹窗），表单回填、保存回流、密钥不下发。"""
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


SECRET_KEY = "sk-edit-page-secret-9f3a"
st, temp = api("/api/providers", "POST", {
    "name": "编辑页测试供应商",
    "baseUrl": "https://editpage.example.com/v1",
    "apiKey": SECRET_KEY,
    "models": "m-a\nm-b",
})
temp_id = temp["id"]
print(f"临时供应商 {temp_id}\n")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 950})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    print("【1】列表页：编辑是链接（不是弹窗按钮）")
    page.goto(f"{BASE}/providers", wait_until="networkidle")
    page.wait_for_timeout(1200)
    row = page.locator(".card", has_text="编辑页测试供应商")
    edit_link = row.get_by_role("link", name="编辑")
    check("编辑是链接且指向 /providers/<id>", edit_link.count() == 1 and edit_link.get_attribute("href") == f"/providers/{temp_id}",
          edit_link.get_attribute("href") if edit_link.count() else "无")
    check("列表页没有弹窗", page.locator(".ui-dialog-content").count() == 0)
    check("「新建供应商」也指向独立页 /providers/new",
          page.get_by_role("link", name="新建供应商").get_attribute("href") == "/providers/new")

    print("\n【2】点编辑 → 进入编辑页")
    edit_link.click()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(900)
    check("URL 是编辑页", page.url.endswith(f"/providers/{temp_id}"), page.url)
    check("页面无弹窗、无遮罩", page.locator(".ui-dialog-content").count() == 0 and page.locator(".ui-dialog-overlay").count() == 0)
    check("标题是供应商名", page.locator("h1").inner_text().strip() == "编辑页测试供应商", page.locator("h1").inner_text())
    body = page.inner_text("body")
    check("显示引用情况（无引用时明确说明）", "引用" in body, [l for l in body.split("\n") if "引用" in l][:1])

    print("\n【3】表单回填与密钥安全")
    inputs = page.locator(".page input")
    check("名称/Base URL 已回填",
          inputs.nth(0).input_value() == "编辑页测试供应商" and inputs.nth(1).input_value() == "https://editpage.example.com/v1",
          f"{inputs.nth(0).input_value()} / {inputs.nth(1).input_value()}")
    check("模型清单已回填（两行）", page.locator(".page textarea").first.input_value() == "m-a\nm-b",
          repr(page.locator(".page textarea").first.input_value()))
    check("密钥输入框为空", page.locator(".page input[type=password]").input_value() == "")
    check("密钥占位提示「已保存」", "已保存" in (page.locator(".page input[type=password]").get_attribute("placeholder") or ""),
          page.locator(".page input[type=password]").get_attribute("placeholder"))
    check("**页面 HTML 里没有明文密钥**", SECRET_KEY not in page.content())
    check("保存按钮可用（必填已满足）", not page.get_by_role("button", name="保存修改").is_disabled())
    page.screenshot(path="/tmp/oa_provider_edit_page.png", full_page=True)

    print("\n【4】保存 → 回列表并生效")
    inputs.nth(0).fill("编辑页测试供应商（改名）")
    page.locator(".page textarea").first.fill("m-a\nm-b\nm-c")
    page.get_by_role("button", name="保存修改").click()
    try:
        page.wait_for_url(f"**/providers", timeout=8000)
    except Exception:
        pass
    page.wait_for_timeout(1500)
    check("保存后回到列表页", page.url.rstrip("/").endswith("/providers"), page.url)
    st, updated = api(f"/api/providers/{temp_id}")
    check("后端已更新（名称 + 3 个模型）", updated["name"] == "编辑页测试供应商（改名）" and updated["models"] == ["m-a", "m-b", "m-c"],
          f"{updated['name']} {updated['models']}")
    check("留空提交未清空密钥", updated["apiKey"] == SECRET_KEY)
    check("列表显示新名称与模型数", "模型 3 个" in page.locator(".card", has_text="编辑页测试供应商（改名）").inner_text())

    print("\n【5】新建页：/providers/new")
    page.get_by_role("link", name="新建供应商").click()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(800)
    check("进入 /providers/new", page.url.endswith("/providers/new"), page.url)
    check("表单为空", page.locator(".page input").nth(0).input_value() == "")
    check("必填未填时按钮禁用", page.get_by_role("button", name="创建供应商").is_disabled())
    page.locator(".page input").nth(0).fill("新建页测试")
    page.locator(".page input").nth(1).fill("https://newpage.example.com/v1")
    check("填完名称+地址后可创建", not page.get_by_role("button", name="创建供应商").is_disabled())
    page.get_by_role("button", name="创建供应商").click()
    try:
        page.wait_for_url("**/providers", timeout=8000)
    except Exception:
        pass
    page.wait_for_timeout(1500)
    check("创建后回到列表且出现新卡片", page.url.rstrip("/").endswith("/providers") and page.locator(".card", has_text="新建页测试").count() == 1)

    print("\n【6】409 场景：编辑页保存非法值给出错误提示")
    page.goto(f"{BASE}/providers/{temp_id}", wait_until="networkidle")
    page.wait_for_timeout(800)
    page.locator(".page input").nth(1).fill("不是URL")
    page.get_by_role("button", name="保存修改").click()
    page.wait_for_timeout(1200)
    check("非法 Base URL → 页内错误提示且停留原页", page.locator(".error-banner").count() == 1 and f"/providers/{temp_id}" in page.url,
          page.locator(".error-banner").inner_text()[:60] if page.locator(".error-banner").count() else "无提示")

    real_errors = [e for e in errors if "400" not in e and "404" not in e]
    check("无意外控制台错误（400 是上一步故意触发的）", not real_errors, real_errors[:2])
    b.close()

# 清理
api(f"/api/providers/{temp_id}", "DELETE")
_, rows = api("/api/providers")
for r in rows:
    if r["name"].startswith("新建页测试"):
        api(f"/api/providers/{r['id']}", "DELETE")
print("\n（已清理测试供应商）")
print(f"通过 {len(ok)} / 失败 {len(bad)}")
for x in bad:
    print("  -", x)
