/*!
 * one-agent 客服组件 SDK（无依赖，约 7KB）
 *
 * 用法（粘贴到客户网站任意页面）：
 *   <script src="https://<one-agent 地址>/widget.js"
 *           data-agent="agent-xxxx" data-key="wk_xxxx" async></script>
 *
 * 可选属性：
 *   data-host      指定 one-agent 地址（默认取脚本自身的域名）
 *   data-position  left | right（默认 right，右下角）
 *   data-color     主题色 #RRGGBB（默认组件后台配置）
 *   data-label     按钮无障碍标签（默认「打开在线客服」）
 *   data-auto-open "true" 时加载后自动展开面板
 *
 * 提供全局 API：window.OneAgentChat.{open, close, toggle, isOpen, on, off}
 * 事件：ready | open | close | unread
 *
 * 实现要点：按钮与面板都注入宿主页面，但**面板内容是 iframe**（同源 one-agent 页面），
 * 因此客户网站的 CSS 不会影响对话界面，反之亦然；两边用 postMessage 通信。
 */
(function () {
  "use strict";

  if (window.OneAgentChat && window.OneAgentChat.__oa) return;

  var CURRENT = document.currentScript;
  if (!CURRENT) {
    var all = document.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf("/widget.js") !== -1) {
        CURRENT = all[i];
        break;
      }
    }
  }
  if (!CURRENT) return;

  var attr = function (name, fallback) {
    var v = CURRENT.getAttribute("data-" + name);
    return v === null || v === "" ? fallback : v;
  };

  var AGENT_ID = attr("agent", "");
  var EMBED_KEY = attr("key", "");
  if (!AGENT_ID || !EMBED_KEY) {
    console.warn("[one-agent] 缺少 data-agent / data-key，客服组件未启动");
    return;
  }

  var scriptUrl = new URL(CURRENT.src, window.location.href);
  var BASE = (attr("host", scriptUrl.origin) || scriptUrl.origin).replace(/\/+$/, "");
  var POSITION = attr("position", "right") === "left" ? "left" : "right";
  var COLOR = attr("color", "");
  var LABEL = attr("label", "打开在线客服");
  var AUTO_OPEN = attr("auto-open", "") === "true";
  var IFRAME_ORIGIN = new URL(BASE).origin;
  var Z = 2147483000;

  // ── 宿主页面样式（全部限定在 oa-widget-* 命名空间下）──
  var css =
    ".oa-widget-launcher{position:fixed;bottom:24px;" + POSITION + ":24px;width:56px;height:56px;border-radius:50%;" +
    "background:" + (COLOR || "#2f6bff") + ";color:#fff;border:none;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.24);" +
    "display:flex;align-items:center;justify-content:center;z-index:" + (Z + 1) + ";transition:transform .16s ease,box-shadow .16s ease;padding:0}" +
    ".oa-widget-launcher:hover{transform:scale(1.05)}" +
    ".oa-widget-launcher:focus-visible{outline:2px solid #fff;outline-offset:2px}" +
    ".oa-widget-launcher svg{width:26px;height:26px;display:block}" +
    ".oa-widget-badge{position:absolute;top:-2px;" + POSITION + ":-2px;min-width:18px;height:18px;border-radius:9px;background:#e5484d;color:#fff;" +
    "font:600 11px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;padding:0 5px;box-sizing:border-box}" +
    ".oa-widget-panel{position:fixed;bottom:96px;" + POSITION + ":24px;width:380px;height:min(600px,calc(100vh - 140px));" +
    "border:none;border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.32);background:#fff;z-index:" + Z + ";" +
    "opacity:0;transform:translateY(8px) scale(.99);pointer-events:none;transition:opacity .18s ease,transform .18s ease;overflow:hidden}" +
    ".oa-widget-panel.oa-open{opacity:1;transform:none;pointer-events:auto}" +
    "@media (max-width:480px){.oa-widget-panel{inset:0;bottom:0;width:100%;height:100%;border-radius:0;transform:none}" +
    ".oa-widget-launcher{bottom:18px;" + POSITION + ":18px}}" +
    "@media (prefers-reduced-motion:reduce){.oa-widget-panel,.oa-widget-launcher{transition:none}}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ── 启动按钮 ──
  var launcher = document.createElement("button");
  launcher.className = "oa-widget-launcher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", LABEL);
  launcher.setAttribute("aria-expanded", "false");
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
    "</svg>";

  var badge = document.createElement("span");
  badge.className = "oa-widget-badge";
  badge.style.display = "none";
  launcher.appendChild(badge);

  // ── 面板（iframe：内容来自 one-agent 站点）──
  var panel = document.createElement("iframe");
  panel.className = "oa-widget-panel";
  panel.setAttribute("title", "在线客服");
  panel.setAttribute("allow", "clipboard-write");
  panel.src =
    BASE + "/embed/chat?agentId=" + encodeURIComponent(AGENT_ID) + "&key=" + encodeURIComponent(EMBED_KEY) +
    (COLOR ? "&color=" + encodeURIComponent(COLOR) : "") + "&position=" + POSITION;
  panel.setAttribute("loading", "lazy");

  var open = false;
  var ready = false;
  var unread = 0;
  var listeners = { ready: [], open: [], close: [], unread: [] };
  var pendingOpen = AUTO_OPEN;

  function emit(event) {
    var args = Array.prototype.slice.call(arguments, 1);
    (listeners[event] || []).forEach(function (fn) {
      try {
        fn.apply(null, args);
      } catch (e) {
        console.error("[one-agent] 事件回调异常:", e);
      }
    });
  }

  function post(type, payload) {
    if (!panel.contentWindow) return;
    var msg = { type: "oa:" + type };
    if (payload) for (var k in payload) msg[k] = payload[k];
    panel.contentWindow.postMessage(msg, IFRAME_ORIGIN);
  }

  function setOpen(next) {
    if (next === open) return;
    open = next;
    panel.classList.toggle("oa-open", open);
    launcher.setAttribute("aria-expanded", open ? "true" : "false");
    launcher.setAttribute("aria-label", open ? "关闭在线客服" : LABEL);
    post(open ? "open" : "close");
    post("visibility", { open: open });
    if (open) {
      unread = 0;
      renderBadge();
      post("focus");
    }
    emit(open ? "open" : "close");
  }

  function renderBadge() {
    badge.textContent = unread > 9 ? "9+" : String(unread);
    badge.style.display = unread > 0 ? "block" : "none";
  }

  launcher.addEventListener("click", function () {
    setOpen(!open);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && open) setOpen(false);
  });

  // ── 与 iframe 通信：只接受来自我们这个 iframe 的消息 ──
  window.addEventListener("message", function (event) {
    if (event.source !== panel.contentWindow) return;
    var data = event.data || {};
    switch (data.type) {
      case "oa:ready":
        ready = true;
        emit("ready", data);
        if (pendingOpen) {
          pendingOpen = false;
          setOpen(true);
        }
        break;
      case "oa:close":
        setOpen(false);
        break;
      case "oa:unread":
        if (!open) {
          unread = typeof data.count === "number" ? data.count : unread + 1;
          renderBadge();
          emit("unread", unread);
        }
        break;
      case "oa:event":
        emit(data.name, data.payload);
        break;
      default:
        break;
    }
  });

  function mount() {
    if (!document.body) return;
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    // iframe 已加载但没收到 ready（比如组件被关闭/未授权）→ 由父页面兜底提示
    setTimeout(function () {
      if (!ready) post("ping");
    }, 3000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  window.OneAgentChat = {
    __oa: true,
    agentId: AGENT_ID,
    baseUrl: BASE,
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    toggle: function () {
      setOpen(!open);
    },
    isOpen: function () {
      return open;
    },
    on: function (event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
      return this;
    },
    off: function (event, fn) {
      listeners[event] = (listeners[event] || []).filter(function (f) {
        return f !== fn;
      });
      return this;
    },
  };
})();
