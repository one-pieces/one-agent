"""客服组件端到端：宿主页面按钮 → 面板 → 真实对话 → 刷新恢复 → 关闭 → 来源拦截。"""
import json
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
AGENT = "deepseek-agent"
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
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


# 准备：开启组件、放开限流与来源
st, admin = api(f"/api/agents/{AGENT}/widget", "PUT", {
    "enabled": True,
    "title": "示例商城客服",
    "subtitle": "一般 1 分钟内回复",
    "welcome": "你好，我是示例商城的客服小助手～",
    "placeholder": "请描述你的问题",
    "primaryColor": "#2f6bff",
    "position": "right",
    "rateLimit": 60,
    "origins": "",
})
KEY = admin["settings"]["embedKey"]
print(f"嵌入 key = {KEY}\n")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

    print("【1】宿主页面：脚本注入")
    page.goto(f"{BASE}/widget-demo.html?agent={AGENT}&key={KEY}", wait_until="networkidle")
    page.wait_for_timeout(1500)
    launcher = page.locator("button.oa-widget-launcher")
    check("右下角出现客服按钮", launcher.count() == 1, f"count={launcher.count()}")
    box = launcher.bounding_box()
    vw = 1280
    vh = 900
    check("按钮位于右下（右 24px / 下 24px 内）",
          abs((vw - (box["x"] + box["width"])) - 24) <= 2 and abs((vh - (box["y"] + box["height"])) - 24) <= 2,
          f"右距={vw - (box['x'] + box['width']):.0f}px 下距={vh - (box['y'] + box['height']):.0f}px")
    check("按钮尺寸 56×56", round(box["width"]) == 56 and round(box["height"]) == 56, f"{box['width']}×{box['height']}")
    check("SDK 暴露 window.OneAgentChat", page.evaluate("typeof window.OneAgentChat === 'object'"))
    check("注入 iframe（面板）", page.locator("iframe.oa-widget-panel").count() == 1)
    check("面板初始隐藏", page.evaluate("!document.querySelector('iframe.oa-widget-panel').classList.contains('oa-open')"))
    check("宿主页面提示已就绪", "客服组件已就绪" in page.locator("#hint").inner_text(), page.locator("#hint").inner_text()[:60])
    page.screenshot(path="/tmp/oa_widget_host_closed.png")

    print("\n【2】点击按钮 → 面板打开 → 欢迎语")
    launcher.click()
    page.wait_for_timeout(1200)
    check("面板加上 oa-open", page.evaluate("document.querySelector('iframe.oa-widget-panel').classList.contains('oa-open')"))
    panel = page.frame_locator("iframe.oa-widget-panel")
    check("面板标题正确", "示例商城客服" in panel.locator(".oa-widget-head").inner_text(), panel.locator(".oa-widget-head").inner_text()[:40])
    check("显示欢迎语", "客服小助手" in panel.locator(".oa-widget-bubble").first.inner_text(), panel.locator(".oa-widget-bubble").first.inner_text()[:40])
    check("输入框占位符按配置", panel.locator("textarea").get_attribute("placeholder") == "请描述你的问题")
    page.screenshot(path="/tmp/oa_widget_host_open.png")

    print("\n【3】真实对话（deepseek）")
    panel.locator("textarea").fill("你们的退货政策是什么？只回一句")
    panel.locator("textarea").press("Enter")
    page.wait_for_timeout(1500)
    check("用户消息上屏", "退货政策" in panel.locator(".oa-widget-row.user .oa-widget-bubble").first.inner_text())
    page.screenshot(path="/tmp/oa_widget_host_chatting.png")

    # 发消息后欢迎语不再渲染 → 助手气泡就是回复本身，等它出现并停止增长
    reply = ""
    for _ in range(60):
        page.wait_for_timeout(1000)
        bubbles = panel.locator(".oa-widget-row.assistant .oa-widget-bubble")
        if bubbles.count() >= 1:
            current = bubbles.last.inner_text()
            if len(current.strip()) > 3 and current == reply:
                break
            reply = current
    check("收到模型回复", len(reply.strip()) > 3, reply[:70])
    page.screenshot(path="/tmp/oa_widget_host_replied.png")

    print("\n【4】关闭与重开")
    panel.locator(".oa-widget-close").click()
    page.wait_for_timeout(800)
    check("关闭后面板隐藏", page.evaluate("!document.querySelector('iframe.oa-widget-panel').classList.contains('oa-open')"))
    check("可编程打开（OneAgentChat.open）",
          page.evaluate("(window.OneAgentChat.open(), window.OneAgentChat.isOpen())") is True)
    page.wait_for_timeout(600)
    check("重开后历史仍在", panel.locator(".oa-widget-row.user .oa-widget-bubble").first.inner_text().find("退货政策") >= 0)

    print("\n【5】刷新页面 → 访客会话恢复")
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.locator("button.oa-widget-launcher").click()
    page.wait_for_timeout(1800)
    text = panel.locator(".oa-widget-body").inner_text()
    check("刷新后仍能看到上一轮对话", "退货政策" in text and len(text) > 20, text.replace("\n", " ")[:80])
    check("未出现错误横幅", "暂时无法使用" not in text)
    page.screenshot(path="/tmp/oa_widget_host_reloaded.png")

    print("\n【6】来源白名单拦截（把演示站的来源排除）")
    api(f"/api/agents/{AGENT}/widget", "PUT", {"origins": "https://www.example.com"})
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1200)
    page.locator("button.oa-widget-launcher").click()
    page.wait_for_timeout(1800)
    inside = panel.locator(".oa-widget-body").inner_text()
    check("面板内提示来源未授权", "来源未授权" in inside, inside.replace("\n", " ")[:100])
    check("未授权时不显示输入框", panel.locator("textarea").count() == 0)
    page.screenshot(path="/tmp/oa_widget_origin_blocked.png")
    api(f"/api/agents/{AGENT}/widget", "PUT", {"origins": ""})

    check("页面无预期外控制台错误", not [e for e in console_errors if "403" not in e and "Failed to load resource" not in e], console_errors[:2])
    browser.close()

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
if bad:
    print("失败项:")
    for b in bad:
        print("  -", b)
