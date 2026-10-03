"""验证供应商页：编辑/新建走弹窗，列表不被替换；弹窗交互（遮罩/Esc/取消/保存）正常。"""
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


# 造一个临时供应商做编辑对象
st, temp = api("/api/providers", "POST", {
    "name": "弹窗测试供应商",
    "baseUrl": "https://dialog.example.com/v1",
    "apiKey": "sk-dialog-test",
    "models": "m-a\nm-b",
})
temp_id = temp["id"]
print(f"临时供应商 {temp_id}\n")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 950})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/providers", wait_until="networkidle")
    page.wait_for_timeout(1500)

    print("【1】点「编辑」→ 弹窗")
    row = page.locator(".card", has_text="弹窗测试供应商")
    row.get_by_role("button", name="编辑").click()
    page.wait_for_timeout(900)
    dialog = page.locator(".ui-dialog-content")
    check("出现弹窗", dialog.count() == 1)
    check("有遮罩层", page.locator(".ui-dialog-overlay").count() == 1)
    check("标题为「编辑供应商：…」", "编辑供应商" in dialog.inner_text() and "弹窗测试供应商" in dialog.inner_text(),
          dialog.inner_text().split("\n")[0])
    check("页面上不再有内联面板", page.locator(".panel").count() == 0)
    check("字段已回填（名称/Base URL/模型清单）",
          dialog.locator("input").nth(0).input_value() == "弹窗测试供应商"
          and dialog.locator("input").nth(1).input_value() == "https://dialog.example.com/v1"
          and "m-a" in dialog.locator("textarea").first.input_value(),
          dialog.locator("input").nth(1).input_value())
    check("密钥不回填（占位提示已保存）",
          dialog.locator("input[type=password]").input_value() == ""
          and "已保存" in (dialog.locator("input[type=password]").get_attribute("placeholder") or ""),
          dialog.locator("input[type=password]").get_attribute("placeholder"))

    geo = page.evaluate("""() => {
      const d = document.querySelector('.ui-dialog-content').getBoundingClientRect();
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('弹窗测试供应商')).getBoundingClientRect();
      return { dialogW: +d.width.toFixed(1), dialogTop: +d.top.toFixed(1), cardTop: +card.top.toFixed(1), cardVisible: card.top < innerHeight };
    }""")
    print("    几何:", json.dumps(geo))
    check("弹窗为 wide 变体（≈980px）", 900 <= geo["dialogW"] <= 1000, f"{geo['dialogW']}px")
    check("列表仍在页面上（未被面板顶掉）", geo["cardVisible"] and geo["cardTop"] < geo["dialogTop"])
    page.screenshot(path="/tmp/oa_providers_dialog.png")

    print("\n【2】保存 → 弹窗关闭且列表更新")
    dialog.locator("input").nth(0).fill("弹窗测试供应商（改名）")
    dialog.locator("textarea").first.fill("m-a\nm-b\nm-c")
    dialog.get_by_role("button", name="保存").click()
    page.wait_for_timeout(1500)
    check("保存后弹窗关闭", page.locator(".ui-dialog-content").count() == 0)
    check("列表已刷新（改名 + 3 个模型）",
          page.locator(".card", has_text="弹窗测试供应商（改名）").count() == 1
          and "模型 3 个" in page.locator(".card", has_text="弹窗测试供应商（改名）").inner_text(),
          page.locator(".card", has_text="弹窗测试供应商（改名）").inner_text().replace("\n", " ")[:80])

    print("\n【3】关闭方式：取消 / Esc / 点遮罩")
    for how in ["取消", "Esc", "遮罩"]:
        page.locator(".card", has_text="弹窗测试供应商（改名）").get_by_role("button", name="编辑").click()
        page.wait_for_timeout(800)
        opened = page.locator(".ui-dialog-content").count() == 1
        if how == "取消":
            page.locator(".ui-dialog-content").get_by_role("button", name="取消").click()
        elif how == "Esc":
            page.keyboard.press("Escape")
        else:
            page.mouse.click(60, 60)
        page.wait_for_timeout(700)
        check(f"{how} 可关闭弹窗", opened and page.locator(".ui-dialog-content").count() == 0)

    print("\n【4】新建也走弹窗")
    page.get_by_role("button", name="＋ 新建供应商").click()
    page.wait_for_timeout(900)
    d2 = page.locator(".ui-dialog-content")
    check("新建弹窗出现且标题为「新建供应商」", d2.count() == 1 and "新建供应商" in d2.inner_text(), d2.inner_text().split("\n")[0] if d2.count() else "无")
    check("新建时字段为空", d2.locator("input").nth(0).input_value() == "")
    check("名称为空时保存按钮禁用", d2.get_by_role("button", name="保存").is_disabled())
    d2.locator("input").nth(0).fill("不该被创建的供应商")
    check("只填名称仍不可保存（Base URL 也必填）", d2.get_by_role("button", name="保存").is_disabled())
    d2.locator("input").nth(1).fill("https://tmp.example.com/v1")
    check("名称 + Base URL 都填后可保存", not d2.get_by_role("button", name="保存").is_disabled())
    d2.get_by_role("button", name="取消").click()
    page.wait_for_timeout(600)
    check("取消后未创建", page.locator(".card", has_text="不该被创建的供应商").count() == 0)

    check("无控制台错误", not errors, errors[:2])
    b.close()

st, _ = api(f"/api/providers/{temp_id}", "DELETE")
print(f"\n（已清理临时供应商 {temp_id}）")
print(f"通过 {len(ok)} / 失败 {len(bad)}")
for x in bad:
    print("  -", x)
