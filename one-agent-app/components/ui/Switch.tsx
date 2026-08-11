"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { clsx, type ClassValue } from "clsx";

/** 轻量 className 合并 */
function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/**
 * 开关（基于 radix-ui Switch 原语，样式对齐 eve：36×20 圆角 pill，
 * 开=蓝色/关=灰色，圆点 16px 滑动）。样式类定义在 globals.css（.ui-switch-*）。
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn("ui-switch", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className="ui-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
