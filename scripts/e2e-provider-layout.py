"""供应商/列表卡片排版回归：多宽度下文字不溢出卡片、不压按钮、按钮不出界、元信息不被截断。

背景：.card-main 是 flex 子项且没有 min-width:0，长元信息（.card-sub 为 nowrap）在窄窗口下
不收缩 → 文字与右侧按钮挤出卡片边界（用户报的「文字错位」）。这里锁死该行为。
"""
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
WIDTHS = [1440, 1280, 1100, 991, 900]
ok, bad = [], []


def check(label, cond, detail=""):
    (ok if cond else bad).append(label)
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail else ""))


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1440, "height": 900})
    for w in WIDTHS:
        page.set_viewport_size({"width": w, "height": 900})
        page.goto(f"{BASE}/settings/providers", wait_until="networkidle")
        page.wait_for_timeout(1200)
        rows = page.evaluate("""() => [...document.querySelectorAll('.card')].map((card) => {
          const main = card.querySelector('.card-main');
          const subs = [...card.querySelectorAll('.card-sub')];
          const btns = [...card.querySelectorAll('a,button')];
          const cb = card.getBoundingClientRect();
          const mb = main.getBoundingClientRect();
          const first = btns.length ? btns[0].getBoundingClientRect() : null;
          return {
            cardRight: +cb.right.toFixed(1), cardW: +cb.width.toFixed(1), cardH: +cb.height.toFixed(1),
            mainRight: +mb.right.toFixed(1), mainW: +mb.width.toFixed(1),
            btnLeft: first ? +first.left.toFixed(1) : null,
            btnRight: first ? +btns[btns.length-1].getBoundingClientRect().right.toFixed(1) : null,
            subs: subs.map(s => ({ right: +s.getBoundingClientRect().right.toFixed(1), clipped: s.scrollWidth > s.clientWidth + 1,
                                   scrollW: s.scrollWidth, clientW: s.clientWidth, lines: Math.round(s.getBoundingClientRect().height / 18) })),
            titleAttrs: subs.filter(s => s.getAttribute('title')).length,
          };
        })""")
        print(f"\n=== 视口 {w}px ===")
        for i, r in enumerate(rows):
            over = r["subs"][0]["right"] > r["cardRight"] + 0.5
            press = r["btnLeft"] is not None and r["subs"][0]["right"] > r["btnLeft"]
            clipped = any(s["clipped"] for s in r["subs"])
            btnOutside = r["btnRight"] is not None and r["btnRight"] > r["cardRight"] + 0.5
            print(f"  card{i}: cardW={r['cardW']} cardH={r['cardH']} mainW={r['mainW']} sub0Right={r['subs'][0]['right']} "
                  f"btnLeft={r['btnLeft']} btnRight={r['btnRight']} cardRight={r['cardRight']} 行数={r['subs'][0]['lines']} "
                  f"{'溢出' if over else ''}{' 压按钮' if press else ''}{' 被截断' if clipped else ''}{' 按钮出界' if btnOutside else ''}")
            check(f"{w}px card{i} 文字不溢出卡片", not over, f"sub.right={r['subs'][0]['right']} vs card.right={r['cardRight']}")
            check(f"{w}px card{i} 文字不压按钮", not press, f"btn.left={r['btnLeft']}")
            check(f"{w}px card{i} 按钮在卡片内", not btnOutside, f"btn.right={r['btnRight']}")
            check(f"{w}px card{i} 元信息未被截断（信息完整）", not clipped, f"scrollW={r['subs'][0]['scrollW']} clientW={r['subs'][0]['clientW']}")
        if w in (1440, 991):
            page.screenshot(path=f"/tmp/oa_prov_fixed_{w}.png")
            print(f"    截图 /tmp/oa_prov_fixed_{w}.png")
    b.close()

print(f"\n通过 {len(ok)} / 失败 {len(bad)}")
for x in bad:
    print("  -", x)
