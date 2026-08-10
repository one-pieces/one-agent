"use client";

import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";

const THEME_KEY = "one-agent:theme";

function applyTheme(theme: "dark" | "light") {
  if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
}

/** 主题切换（暗色为默认；亮色通过 <html data-theme="light"> + CSS 变量覆盖） */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light") {
      setTheme("light");
      applyTheme("light");
    }
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  };

  return (
    <button
      className="app-nav-item app-nav-theme"
      onClick={toggle}
      title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
      aria-label="切换主题"
    >
      {theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />}
      <span>{theme === "dark" ? "亮色" : "暗色"}</span>
    </button>
  );
}
