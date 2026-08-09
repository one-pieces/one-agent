import { z } from "zod";
import { defineTool } from "../define.ts";

/**
 * 安全算术表达式求值（无 eval）。
 * 支持：数字（含小数）、+ - * / % ^、括号、一元负号。
 */
export function evaluate(expression: string): number {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new Error("空表达式");
  return evalRpn(shuntingYard(tokens));
}

type Token = { type: "num"; value: number } | { type: "op"; value: string };

function tokenize(expr: string): Token[] {
  const s = expr.replace(/\s+/g, "");
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
      const numStr = s.slice(i, j);
      if (!/^(\d+(\.\d+)?|\.\d+)$/.test(numStr)) throw new Error(`非法数字: ${numStr}`);
      tokens.push({ type: "num", value: parseFloat(numStr) });
      i = j;
    } else if ("+-*/%^()".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
    } else {
      throw new Error(`非法字符: ${ch}`);
    }
  }
  // 一元 +/-：直接吸收后随数字（-3 → num(-3)）；否则降级为 0 +/- x
  const out: Token[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.type === "op" && (t.value === "+" || t.value === "-")) {
      const prev = out[out.length - 1];
      const isUnary = prev === undefined || (prev.type === "op" && prev.value !== ")");
      if (isUnary) {
        const next = tokens[k + 1];
        if (next && next.type === "num") {
          out.push({ type: "num", value: t.value === "-" ? -next.value : next.value });
          k++;
          continue;
        }
        out.push({ type: "num", value: 0 });
        out.push(t);
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

function shuntingYard(tokens: Token[]): Token[] {
  const prec: Record<string, number> = { "+": 2, "-": 2, "*": 3, "/": 3, "%": 3, "^": 4 };
  const rightAssoc = new Set(["^"]);
  const output: Token[] = [];
  const ops: string[] = [];
  for (const t of tokens) {
    if (t.type === "num") {
      output.push(t);
      continue;
    }
    const op = t.value;
    if (op === "(") {
      ops.push(op);
      continue;
    }
    if (op === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") output.push({ type: "op", value: ops.pop()! });
      if (!ops.length) throw new Error("括号不匹配");
      ops.pop();
      continue;
    }
    while (ops.length) {
      const top = ops[ops.length - 1]!;
      if (top === "(") break;
      const topPrec = prec[top] ?? 0;
      const opPrec = prec[op] ?? 0;
      if (opPrec < topPrec || (opPrec === topPrec && !rightAssoc.has(op))) {
        output.push({ type: "op", value: ops.pop()! });
      } else break;
    }
    ops.push(op);
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === "(" || op === ")") throw new Error("括号不匹配");
    output.push({ type: "op", value: op });
  }
  return output;
}

function evalRpn(rpn: Token[]): number {
  const stack: number[] = [];
  for (const t of rpn) {
    if (t.type === "num") {
      stack.push(t.value);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) throw new Error("表达式不完整");
    switch (t.value) {
      case "+": stack.push(a + b); break;
      case "-": stack.push(a - b); break;
      case "*": stack.push(a * b); break;
      case "/":
        if (b === 0) throw new Error("除以零");
        stack.push(a / b);
        break;
      case "%": stack.push(a % b); break;
      case "^": stack.push(Math.pow(a, b)); break;
      default: throw new Error(`未知运算符 ${t.value}`);
    }
  }
  if (stack.length !== 1) throw new Error("表达式不完整");
  return stack[0]!;
}

export const calculatorTool = defineTool({
  name: "calculator",
  description:
    "计算数学表达式并返回数值结果。支持运算符 + - * / % ^ 和括号、小数。示例：\"(1+2)*3\"、\"2^10\"、\"100/7\"。",
  schema: z.object({ expression: z.string().min(1).max(200) }),
  execute(_ctx, { expression }) {
    try {
      return { ok: true, output: evaluate(expression) };
    } catch (err) {
      return { ok: false, output: null, error: `表达式无效: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
