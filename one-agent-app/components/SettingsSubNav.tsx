"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** 设置页左侧二级导航：供应商 / 日志 */
export default function SettingsSubNav() {
  const pathname = usePathname() ?? "";
  const items = [
    { href: "/settings/providers", label: "供应商", active: pathname.startsWith("/settings/providers") },
    { href: "/settings/logs", label: "日志", active: pathname.startsWith("/settings/logs") },
  ];

  return (
    <nav className="agent-subnav" aria-label="设置导航">
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          className={`agent-subnav-item${it.active ? " active" : ""}`}
          aria-current={it.active ? "page" : undefined}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
