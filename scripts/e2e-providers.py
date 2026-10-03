"""供应商模块端到端验证：列表/新建/编辑（留空不清密钥）/被引用拒绝删除/agent 下拉选择。"""
import json
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def api(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


ok = []
bad = []


def check(label, cond, detail=""):
    (ok if cond else bad).append(f"{label}{(' — ' + str(detail)) if detail else ''}")
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail else ""))


print("【1】API：列表 / 新建 / 编辑 / 删除")
# 清理历史遗留的测试供应商（否则同名卡片会让定位器命中多个）
for r in api("/api/providers")[1]:
    if r["name"].startswith("UI 建的供应商"):
        api(f"/api/providers/{r['id']}", "DELETE")

st, provs = api("/api/providers")
check("GET /api/providers 200", st == 200, f"status={st}")
check("列表不带明文密钥", all("apiKey" not in p for p in provs), f"keys={[list(p.keys())[:3] for p in provs][:1]}")
base_count = len(provs)

st, created = api("/api/providers", "POST", {
    "name": "E2E 供应商",
    "kind": "openai-compatible",
    "baseUrl": "https://e2e.example.com/v1",
    "apiKey": "sk-e2e-原密钥",
    "models": "e2e-model-a\n e2e-model-b , e2e-model-a",
})
check("POST 新建 201", st == 201, f"status={st} id={created.get('id')}")
pid = created.get("id", "")
check("新建后带明文密钥（回显给表单用）", created.get("apiKey") == "sk-e2e-原密钥")
check("模型清单去重保序", created.get("models") == ["e2e-model-a", "e2e-model-b"], created.get("models"))

st, listed = api("/api/providers")
check("新建后出现在列表且计数 +1", len(listed) == base_count + 1, f"{base_count} -> {len(listed)}")
check("列表项标记 hasApiKey", [p for p in listed if p["id"] == pid][0]["hasApiKey"] is True)

st, got = api(f"/api/providers/{pid}")
check("GET 单个带明文密钥", st == 200 and got["apiKey"] == "sk-e2e-原密钥")

st, patched = api(f"/api/providers/{pid}", "PATCH", {"name": "E2E 供应商（改名）", "notes": "限速 60 rpm"})
check("PATCH 改名成功", st == 200 and patched["name"] == "E2E 供应商（改名）", patched.get("name"))
check("PATCH 未传 apiKey → 密钥保持不变", patched["apiKey"] == "sk-e2e-原密钥")

st, wrong = api(f"/api/providers/{pid}", "PATCH", {"baseUrl": "不是URL"})
check("PATCH 非法 baseUrl → 400", st == 400, json.dumps(wrong, ensure_ascii=False))

st, cleared = api(f"/api/providers/{pid}", "PATCH", {"apiKey": ""})
check("PATCH apiKey 传空串 → 清空", st == 200 and cleared["apiKey"] == "")

print("\n【2】删除保护：被 agent 引用的供应商不能删")
st, agents = api("/api/agents")
referenced = next(a["providerId"] for a in agents if a.get("providerId"))
st, resp = api(f"/api/providers/{referenced}", "DELETE")
check("删除被引用的供应商 → 409", st == 409, f"status={st}")
check("错误信息说明原因", "agent" in json.dumps(resp, ensure_ascii=False), json.dumps(resp, ensure_ascii=False)[:120])
st, _ = api(f"/api/providers/{referenced}")
check("被引用的供应商仍在", st == 200)

st, _ = api(f"/api/providers/{pid}", "DELETE")
check("删除未被引用的供应商 → 200", st == 200)
st, _ = api(f"/api/providers/{pid}")
check("删除后 GET 404", st == 404, f"status={st}")

print("\n【3】UI：/providers 页面")
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 1000})
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/providers", wait_until="networkidle")
    check("页面标题为「供应商」", page.locator("h1").inner_text().strip() == "供应商", page.locator("h1").inner_text())
    cards = page.locator(".card")
    check("列表渲染出供应商卡片", cards.count() == base_count, f"cards={cards.count()} expected={base_count}")
    check("导航栏出现「供应商」入口", page.locator("a", has_text="供应商").count() >= 1)

    page.screenshot(path="/tmp/oa_providers_list.png", full_page=True)

    # 新建（独立页面 /providers/new）
    page.get_by_role("link", name="新建供应商").click()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(700)
    check("新建走独立页面", page.url.endswith("/providers/new") and page.locator(".ui-dialog-content").count() == 0, page.url)
    page.locator(".page input").nth(0).fill("UI 建的供应商")
    page.locator(".page input").nth(1).fill("https://ui.example.com/v1")
    page.locator(".page input[type=password]").fill("sk-ui-key")
    page.locator(".page textarea").first.fill("ui-model-1\nui-model-2")
    page.screenshot(path="/tmp/oa_providers_form.png", full_page=True)
    page.get_by_role("button", name="创建供应商").click()
    try:
        page.wait_for_url("**/providers", timeout=8000)
    except Exception:
        pass
    page.wait_for_timeout(1200)
    check("新建后列表出现新卡片", page.locator(".card", has_text="UI 建的供应商").count() == 1)
    check("卡片显示模型数量与默认模型", "模型 2 个" in page.locator(".card", has_text="UI 建的供应商").inner_text())

    # 编辑：独立页面 + 密钥留空 = 不改
    page.locator(".card", has_text="UI 建的供应商").get_by_role("link", name="编辑").click()
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(900)
    check("编辑走独立页面", "/providers/" in page.url and page.locator(".ui-dialog-content").count() == 0, page.url)
    check("编辑时密钥不回填（避免暴露）", page.locator(".page input[type=password]").input_value() == "")
    check("编辑时显示「已保存」占位", "已保存" in (page.locator(".page input[type=password]").get_attribute("placeholder") or ""), page.locator(".page input[type=password]").get_attribute("placeholder"))
    check("字段已回填（名称/地址/模型）",
          page.locator(".page input").nth(0).input_value() == "UI 建的供应商" and "ui-model-1" in page.locator(".page textarea").first.input_value(),
          page.locator(".page input").nth(0).input_value())
    page.locator(".page input").nth(0).fill("UI 建的供应商（改）")
    page.get_by_role("button", name="保存修改").click()
    try:
        page.wait_for_url("**/providers", timeout=8000)
    except Exception:
        pass
    page.wait_for_timeout(1200)
    row = page.locator(".card", has_text="UI 建的供应商（改）")
    check("改名生效且已回到列表页", row.count() == 1 and page.url.rstrip("/").endswith("/providers"))
    check("留空保存后密钥仍在", "已配密钥" in row.inner_text(), row.inner_text().split("\n")[1][:80])

    # 删除被引用的 → 报错横幅
    protected_name = [p for p in api("/api/providers")[1] if p["id"] == referenced][0]["name"]
    page.locator(".card", has_text=protected_name).locator("button.btn.danger").click()
    page.wait_for_timeout(1200)
    check("删除被引用供应商 → 页面报错且卡片仍在", page.locator(".error-banner").count() == 1 and page.locator(".card", has_text=protected_name).count() == 1,
          page.locator(".error-banner").inner_text()[:90] if page.locator(".error-banner").count() else "无横幅")
    page.screenshot(path="/tmp/oa_providers_delete_blocked.png", full_page=True)

    # 清理 UI 建的
    page.locator(".card", has_text="UI 建的供应商（改）").locator("button.btn.danger").click()
    page.wait_for_timeout(1200)
    check("删除未被引用的供应商成功", page.locator(".card", has_text="UI 建的供应商（改）").count() == 0)

    print("\n【4】UI：Agent 表单的供应商下拉")
    # 用 deepseek-agent 自己引用的供应商名做断言（不是随便挑一个）
    _, agents_now = api("/api/agents")
    ds = [a for a in agents_now if a["id"] == "deepseek-agent"][0]
    ds_provider = [p for p in api("/api/providers")[1] if p["id"] == ds["providerId"]][0]
    ds_name = ds_provider["name"]
    page.goto(f"{BASE}/agents/deepseek-agent", wait_until="networkidle")
    page.wait_for_timeout(800)
    body = page.inner_text("body")
    check("模型段标注由供应商提供", "由供应商提供连接配置" in body)
    check("下拉显示当前供应商", ds_name in body, f"期望 {ds_name}")
    check("引用供应商时不显示内联 kind/baseUrl/API Key", "Base URL:" in body and page.locator("input[type=password]").count() == 0,
          f"password inputs={page.locator('input[type=password]').count()}")
    page.screenshot(path="/tmp/oa_agent_provider_dropdown.png", full_page=True)

    # 切到「自定义」→ 内联字段出现
    page.locator("button", has_text=ds_name).first.click()
    page.wait_for_timeout(500)
    page.get_by_role("option", name="自定义（本 agent 自己保存连接配置）").click()
    page.wait_for_timeout(500)
    check("切到自定义 → 出现内联 Base URL / API Key", page.locator("input[type=password]").count() == 1)
    page.screenshot(path="/tmp/oa_agent_provider_custom.png", full_page=True)

    # 切回供应商并保存 → providerId 保持
    page.locator("button", has_text="自定义（本 agent 自己保存连接配置）").first.click()
    page.wait_for_timeout(500)
    page.get_by_role("option", name=ds_name).first.click()
    page.wait_for_timeout(400)
    page.get_by_role("button", name="保存").first.click()
    page.wait_for_timeout(1500)
    st, after = api("/api/agents/deepseek-agent")
    check("保存后 agent 仍引用该供应商", after.get("providerId") == ds["providerId"],
          f"{after.get('providerId')} vs {ds['providerId']}")

    real_errors = [e for e in errors if "409" not in e]
    check("页面无意外控制台错误（409 为删除保护的预期响应）", not real_errors, real_errors[:2])
    browser.close()

print("\n【5】真实对话：走 provider 解析路径跑一轮 deepseek")
import urllib.error  # noqa: E402

req = urllib.request.Request(
    f"{BASE}/api/chat",
    data=json.dumps({
        "agentId": "deepseek-agent",
        "sessionId": "session-provider-e2e",
        "message": "只回复两个字：可用",
    }).encode(),
    method="POST",
)
req.add_header("content-type", "application/json")
chunks = []
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        while True:
            line = r.readline()
            if not line:
                break
            s = line.decode(errors="ignore").strip()
            if s.startswith("data:"):
                chunks.append(s[5:].strip())
except urllib.error.HTTPError as e:
    chunks.append(f"HTTP {e.code}: {e.read().decode()[:200]}")

text = "".join(chunks)
check("对话请求成功返回（无 4xx/5xx）", not text.startswith("HTTP "), text[:80] if text.startswith("HTTP ") else "")
check("返回内容包含模型输出", "可用" in text, text[-160:].replace("\n", " ")[:160])
check("会话已落库", any(s.get("id") == "session-provider-e2e" for s in api("/api/sessions")[1]))

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
if bad:
    print("失败项：")
    for b in bad:
        print("  -", b)
