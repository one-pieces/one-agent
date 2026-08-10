"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
}

/**
 * 自研下拉选择器：替代原生 <select>（原生 option 弹出面板在 Chrome 等浏览器不受 CSS 控制）。
 * 支持：受控 value、键盘导航（↑↓/Enter/Escape）、点击外部关闭、选中打勾、主题跟随。
 */
export default function Select({ value, onChange, options, placeholder }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // 打开时聚焦高亮当前选中项
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  // 高亮项滚动进视口
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const choose = (index: number) => {
    const opt = options[index];
    if (opt) {
      onChange(opt.value);
      setOpen(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        setOpen(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + options.length) % options.length);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIndex >= 0) choose(activeIndex);
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className="select">
      <button
        type="button"
        className="select-trigger"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={selected ? "select-value" : "select-placeholder"}>
          {selected ? selected.label : placeholder ?? "请选择"}
        </span>
        <ChevronDownIcon size={15} className={`select-chevron${open ? " open" : ""}`} />
      </button>

      {open && (
        <ul ref={listRef} className="select-list" role="listbox">
          {options.map((opt, i) => (
            <li key={opt.value} role="option" aria-selected={opt.value === value}>
              <button
                type="button"
                className={`select-option${i === activeIndex ? " active" : ""}${opt.value === value ? " selected" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(i)}
              >
                <span className="select-option-label">{opt.label}</span>
                {opt.value === value && <CheckIcon size={14} className="select-check" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
