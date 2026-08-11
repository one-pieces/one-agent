"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import { clsx, type ClassValue } from "clsx";

/** 轻量 className 合并（项目无 Tailwind，仅做过滤/拼接） */
function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
}

/**
 * 下拉选择器（基于 radix-ui Select 原语）
 * 替代自研 components/Select.tsx：radix 内置 Portal、键盘导航（↑↓/Enter/Escape）、
 * 点击外部关闭、焦点管理；样式走 globals.css（.ui-select-*，手写 CSS 风格）。
 * API 与旧组件一致：受控 value / onChange / options / placeholder。
 */
export default function Select({ value, onChange, options, placeholder, className }: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange}>
      <SelectPrimitive.Trigger className={cn("ui-select-trigger", className)} aria-label={placeholder}>
        <SelectPrimitive.Value placeholder={placeholder ?? "请选择"} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="ui-select-chevron" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="ui-select-content" position="popper" align="start" sideOffset={4}>
          <SelectPrimitive.Viewport className="ui-select-viewport">
            {options.map((opt) => (
              <SelectPrimitive.Item key={opt.value} value={opt.value} className="ui-select-item">
                <SelectPrimitive.ItemText>{opt.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check className="ui-select-check" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
