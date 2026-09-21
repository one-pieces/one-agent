"""one-agent 规划能力冒烟测试（真实浏览器 + 真实模型）。

覆盖：AgentForm 规划开关（含持久化状态与 todo 自动启用）、plan 工具 → 方案文档落盘 →
聊天页方案面板渲染、todo 工具调用、合成消息不渲染成用户消息。

前置：
  1. 已配置好 deepseek 的 agent（默认读 `deepseek-agent` 的 model 配置：provider/baseUrl/
     modelId/apiKey）——脚本运行时从 app 里取，密钥不落仓库、不打印；
     也可用环境变量覆盖：SMOKE_MODEL_SOURCE / SMOKE_MODEL_ID / SMOKE_MODEL_BASE_URL；
     **不要用本地 ollama 跑测试**（弱模型的空响应/幻觉会把 UI 问题误判成后端问题）；
  2. dev server 已启动：cd one-agent-app && pnpm dev（默认 http://localhost:3000）；
  3. 已存在 agent-smoke（`planning.mode=prompt`、启用 todo/plan/read/ls/tree/write；
     脚本会在缺失时用 API 自动创建）；
  4. Playwright 可用：python3 -m playwright install chromium。

运行：
  python3 scripts/smoke-planning.py            # 退出码 0 = 全绿
环境变量：
  BASE=http://localhost:3000                   # 指向别的地址
"""
import re
import sys
import time

from playwright.sync_api import sync_playwright

import os

BASE = os.environ.get("BASE", "http://localhost:3000")
results = []


def _workspace_dir():
    """会话工作区根目录（与 app 的 data/ 同级）。"""
    import pathlib as _p

    return str(_p.Path(__file__).resolve().parent.parent / "one-agent-app" / "data" / "workspace")


def resolve_model():
    """冒烟用模型：默认取 SMOKE_MODEL_SOURCE（默认 deepseek-agent）的 model 配置。

    密钥只在运行时从 app 读出来直接用于建 agent，不写进仓库、不打印。
    """
    import json as _json
    import os as _os
    import urllib.request as _u

    src = _os.environ.get("SMOKE_MODEL_SOURCE", "deepseek-agent")
    req = _u.Request(f"{BASE}/api/agents/{src}")
    with _u.urlopen(req, timeout=30) as resp:
        ref = _json.loads(resp.read())["model"]
    model = {
        "provider": ref.get("provider", "openai-compatible"),
        "baseUrl": _os.environ.get("SMOKE_MODEL_BASE_URL", ref["baseUrl"]),
        "modelId": _os.environ.get("SMOKE_MODEL_ID", ref["modelId"]),
        "apiKey": ref["apiKey"],
        "temperature": 0.2,
    }
    if not model["apiKey"]:
        raise SystemExit(f"参考 agent {src} 没有 apiKey，无法建冒烟 agent")
    print(f"冒烟模型: {model['modelId']} @ {model['baseUrl']}（来自 {src}）")
    return model


def ensure_agent_and_session():
    """保证冒烟用的 agent 与会话存在（agent 已存在则复用 + 同步模型配置），返回 sessionId。"""
    import json as _json
    import urllib.request as _u

    def call(path, method="GET", body=None):
        data = _json.dumps(body).encode() if body is not None else None
        req = _u.Request(f"{BASE}{path}", data=data, method=method, headers={"content-type": "application/json"})
        with _u.urlopen(req, timeout=30) as resp:
            return _json.loads(resp.read())

    model = resolve_model()
    cfg = {
        "id": "agent-smoke",
        "name": "冒烟测试助手",
        "instructions": "你是测试助手。需要时使用工具，并简洁总结结果。",
        "model": model,
        "tools": [{"name": n, "enabled": True} for n in ["todo", "plan", "read", "ls", "tree", "write"]],
        "maxIterations": 8,
        "memory": {"strategy": "compaction", "contextWindowTokens": 32000, "thresholdPercent": 0.75},
        "planning": {"mode": "prompt"},
    }
    try:
        existing = call("/api/agents/agent-smoke")
        # 已存在：只同步模型配置（模型换了也能直接跑，不必删 agent）
        if existing.get("model", {}).get("modelId") != model["modelId"]:
            print(f"  已存在的 agent-smoke 模型为 {existing['model'].get('modelId')} → 同步为 {model['modelId']}")
            call("/api/agents/agent-smoke", "PATCH", {**existing, "model": model})
    except Exception:  # noqa: BLE001 —— 不存在则创建
        call("/api/agents", "POST", cfg)
    return call("/api/sessions", "POST", {"agentId": "agent-smoke"})["id"]


SID = ensure_agent_and_session()


def check(step, ok, detail=""):
    results.append((step, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + step + (f"   [{detail}]" if detail else ""), flush=True)


def switch_state(locator):
    return locator.get_attribute("aria-checked")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.set_default_timeout(30_000)

    # ── 1) 编辑页：规划/todo 开关状态来自持久化配置（API 创建时 planning.mode=prompt） ──
    page.goto(f"{BASE}/agents/agent-smoke")
    page.wait_for_selector("h3:has-text('规划')")
    page.wait_for_selector(".tool-item code:has-text('planning')")
    planning_row = page.locator(".tool-item", has=page.locator("code", has_text="planning")).first
    planning_sw = planning_row.locator('[data-slot="switch"]')
    todo_row = page.locator(".tool-item", has=page.locator("code", has_text="todo")).first
    todo_sw = todo_row.locator('[data-slot="switch"]')

    check("编辑页渲染出「规划（自规划规程）」区块", planning_row.count() == 1)
    check("编辑页 planning 开关 = 开启（来自持久化配置）", switch_state(planning_sw) == "true", f"aria-checked={switch_state(planning_sw)}")
    check("编辑页 todo 开关 = 开启", switch_state(todo_sw) == "true", f"aria-checked={switch_state(todo_sw)}")
    page.screenshot(path="/tmp/oa_smoke_1_agent_edit.png", full_page=False)

    # ── 2) 新建页：关掉 todo → 打开规划 → todo 自动回勾（表单侧自动启用逻辑） ──
    page.goto(f"{BASE}/agents/new")
    page.wait_for_selector(".tool-item code:has-text('planning')")
    page.wait_for_function("() => document.querySelectorAll('.tool-item').length > 8")  # 工具目录已加载
    todo_new = page.locator(".tool-item", has=page.locator("code", has_text="todo")).first.locator('[data-slot="switch"]')
    planning_new = page.locator(".tool-item", has=page.locator("code", has_text="planning")).first.locator('[data-slot="switch"]')

    check("新建页 planning 默认关闭", switch_state(planning_new) == "false", f"aria-checked={switch_state(planning_new)}")
    if switch_state(todo_new) == "true":
        todo_new.click()
        page.wait_for_timeout(200)
    check("新建页 todo 可关闭（准备验证自动回勾）", switch_state(todo_new) == "false", f"aria-checked={switch_state(todo_new)}")

    planning_new.click()
    page.wait_for_timeout(300)
    check("打开 planning → 开关为开", switch_state(planning_new) == "true")
    check("打开 planning → todo 自动回勾（与 kernel 自动启用一致）", switch_state(todo_new) == "true", f"aria-checked={switch_state(todo_new)}")
    page.screenshot(path="/tmp/oa_smoke_2_agent_new.png", full_page=False)

    # ── 3) 聊天页：真实模型（本地 Ollama qwen2.5-7b）→ plan 工具 → 方案面板 ──
    page.goto(f"{BASE}/chat/session/{SID}")
    page.wait_for_selector("footer.chat-footer textarea")
    check("聊天页加载成功", page.locator("footer.chat-footer textarea").count() == 1)

    prompt = (
        "请用 plan 工具写一份 markdown 方案文档，目标是：把工作区里的 hello.txt 内容从 foo 改成 bar。"
        "方案里要包含目标、步骤、验证方式。写完后只汇报保存路径和建议，先不要执行。"
    )
    page.fill("footer.chat-footer textarea", prompt)
    page.click("footer.chat-footer button.btn.primary")

    # 等流式开始（停止按钮出现）→ 等结束（停止按钮消失）
    try:
        page.wait_for_selector("footer.chat-footer button.btn.danger", timeout=20_000)
        check("模型开始流式响应", True)
    except Exception as exc:  # noqa: BLE001
        check("模型开始流式响应", False, str(exc)[:120])
    try:
        page.wait_for_selector("footer.chat-footer button.btn.danger", state="detached", timeout=300_000)
        check("流式响应结束（≤300s）", True)
    except Exception as exc:  # noqa: BLE001
        check("流式响应结束（≤300s）", False, str(exc)[:120])

    page.wait_for_timeout(1500)  # 等面板刷新（轮次结束后 loadPlan）
    cards = page.locator("details.tool-card")
    card_names = [cards.nth(i).locator("summary").inner_text().split("\n")[0] for i in range(cards.count())]
    assistant_text = page.locator(".msg.assistant .bubble").last.inner_text() if page.locator(".msg.assistant .bubble").count() else ""
    print(f"   工具卡片: {card_names}")
    print(f"   助手回答: {assistant_text[:200]!r}", flush=True)

    check("模型调用了工具", len(card_names) > 0, f"cards={card_names}")
    check("其中包含 plan 工具调用", any("plan" in n for n in card_names), f"cards={card_names}")

    plan_panel = page.locator("details.plan-panel")
    try:
        page.wait_for_selector("details.plan-panel", timeout=15_000)
        check("方案面板出现", True)
        summary = plan_panel.locator("summary").inner_text()
        check("面板显示方案路径（.oneagent/plans/*.md）", bool(re.search(r"\.oneagent/plans/.+\.md", summary)), summary.replace("\n", " ")[:120])
        plan_panel.locator("summary").click()
        page.wait_for_timeout(400)
        body = plan_panel.locator(".plan-panel-body").inner_text()
        check("面板正文渲染了 markdown 内容", len(body.strip()) > 40, f"{len(body)} 字符")
        check("正文包含模型写入的关键词", ("bar" in body) or ("hello.txt" in body), body[:120].replace("\n", " "))
        import glob as _glob, os as _os
        _files = _glob.glob(f"{_workspace_dir()}/{SID}/.oneagent/plans/*.md")
        check("磁盘上确实生成了方案文件", len(_files) > 0, ", ".join(_os.path.basename(f) for f in _files))
    except Exception as exc:  # noqa: BLE001
        check("方案面板出现", False, str(exc)[:160])
    page.screenshot(path="/tmp/oa_smoke_3_chat_plan.png", full_page=False)

    # ── 4) 第二轮：todo 工具 → 计划清单（工具卡片 + 结果） ──
    try:
        page.fill("footer.chat-footer textarea", "请用 todo 工具把刚才的方案拆成 3 个步骤，第一步标为 in_progress。")
        page.click("footer.chat-footer button.btn.primary")
        page.wait_for_selector("footer.chat-footer button.btn.danger", timeout=20_000)
        page.wait_for_selector("footer.chat-footer button.btn.danger", state="detached", timeout=300_000)
        page.wait_for_timeout(800)
        cards2 = page.locator("details.tool-card")
        names2 = [cards2.nth(i).locator("summary").inner_text().split("\n")[0] for i in range(cards2.count())]
        check("第二轮调用了 todo 工具", any("todo" in n for n in names2), f"cards={names2}")
        page.screenshot(path="/tmp/oa_smoke_4_todo.png", full_page=False)
    except Exception as exc:  # noqa: BLE001
        check("第二轮调用了 todo 工具", False, str(exc)[:160])

    # ── 5) 合成消息不应作为用户消息渲染（前端过滤） ──
    user_msgs = page.locator(".msg.user .bubble")
    texts = [user_msgs.nth(i).inner_text() for i in range(user_msgs.count())]
    check("用户消息里没有内核合成快照", not any("你的任务清单在上下文压缩后被保留" in t for t in texts), f"{len(texts)} 条用户消息")

    browser.close()

failed = [name for name, ok, _ in results if not ok]
print("\n=== 汇总 ===")
print(f"通过 {len(results) - len(failed)}/{len(results)}")
if failed:
    print("失败项：")
    for name in failed:
        print("  -", name)
sys.exit(1 if failed else 0)
