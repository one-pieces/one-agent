import { createCodePlugin, type CodeHighlighterPlugin, type ThemeInput } from "@streamdown/code";

/**
 * 代码块高亮配色：与 streamdown 文档站（https://streamdown.ai/docs/code-blocks）完全一致的
 * 「geist」主题 —— 即 Vercel Geist 设计系统的代码配色。
 *
 * 来源：`@vercel/geistdocs`（MIT）里的 `geistShikiTheme`（文档站用它给代码块上色），
 * 原样搬过来以保持 token 分类一致（同样是对 `--shiki-*` CSS 变量的引用）。
 * 具体色值在 globals.css 的 :root / [data-theme="light"] 里定义（亮/暗两套）——
 * 主题只做「token 类别 → CSS 变量」的映射，切主题不需要换主题对象。
 */
const geistShikiTheme = {
  name: "geist",
  type: "dark",
  colors: {
    "editor.foreground": "var(--shiki-color-text, inherit)",
    "editor.background": "var(--shiki-color-background, transparent)",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: { foreground: "var(--shiki-token-comment)" },
    },
    {
      scope: [
        "constant",
        "entity.name.constant",
        "variable.other.constant",
        "variable.other.enummember",
        "variable.language",
        "entity",
      ],
      settings: { foreground: "var(--shiki-token-constant)" },
    },
    {
      scope: ["entity.name", "meta.export.default", "meta.definition.variable"],
      settings: { foreground: "var(--shiki-token-function)" },
    },
    {
      scope: [
        "variable.parameter.function",
        "meta.jsx.children",
        "meta.block",
        "meta.tag.attributes",
        "entity.name.section",
        "text",
        "punctuation.definition.tag",
        "punctuation.separator.inheritance.php",
        "punctuation.definition.tag.html",
        "punctuation.definition.tag.begin.html",
        "punctuation.definition.tag.end.html",
        "punctuation.section.embedded",
        "variable.parameter",
      ],
      settings: { foreground: "var(--shiki-token-parameter)" },
    },
    {
      scope: ["entity.name.tag", "support.class.component"],
      settings: { foreground: "var(--shiki-token-function)" },
    },
    {
      scope: "keyword",
      settings: { foreground: "var(--shiki-token-keyword)" },
    },
    {
      scope: ["storage", "storage.type", "storage.modifier"],
      settings: { foreground: "var(--shiki-token-keyword)" },
    },
    {
      scope: ["string", "string punctuation.section.embedded source", "attribute.value"],
      settings: { foreground: "var(--shiki-token-string)" },
    },
    {
      scope: [
        "punctuation",
        "punctuation.definition.string",
        "punctuation.definition.variable",
        "punctuation.definition.string.begin",
        "punctuation.definition.string.end",
        "punctuation.section.embedded.begin",
        "punctuation.section.embedded.end",
      ],
      settings: { foreground: "var(--shiki-token-punctuation)" },
    },
    {
      scope: "string.regexp",
      settings: { foreground: "var(--shiki-token-string-expression)" },
    },
    {
      scope: ["support.function", "entity.name.function", "meta.function-call.generic"],
      settings: { foreground: "var(--shiki-token-function)" },
    },
    {
      scope: "markup.underline.link",
      settings: { foreground: "var(--shiki-token-link)" },
    },
    {
      // Markdown 列表/任务项内容：shiki 的 markdown 语法把 `[x]` 之类的方括号内容
      // 记为 string.other.link.title.markdown，这里固定成列表项同色，避免 markdown 块花掉。
      scope: ["markup.list", "string.other.link.title.markdown", "string.other.link.description.markdown"],
      settings: { foreground: "var(--shiki-token-parameter)" },
    },
  ],
};

/** 亮/暗两个槽位共用同一套变量色主题（明暗差异由 CSS 变量决定）；第二个实例换个名字避免重名 */
export const codePlugin: CodeHighlighterPlugin = createCodePlugin({
  themes: [geistShikiTheme as ThemeInput, { ...geistShikiTheme, name: "geist-dark" } as ThemeInput],
});
