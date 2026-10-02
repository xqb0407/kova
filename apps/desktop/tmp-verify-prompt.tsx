/** 临时验证：从真实源码里抽出 TerminalCommandLine，渲染 HTML 确认 $ 高亮与空格 */
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("./components/assistant-ui/elements/tool-row.aui.tsx", import.meta.url),
  "utf8",
);
const m = /const TerminalCommandLine[\s\S]*?\n\);\n/.exec(src);
if (!m) throw new Error("TerminalCommandLine not found in source");

const transpiler = new Bun.Transpiler({ loader: "tsx" });
const js = transpiler.transformSync(
  `${m[0]}\nexport { TerminalCommandLine };`,
);
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

const { renderToStaticMarkup } = await import("react-dom/server");
const React = (await import("react")).default;

const html = renderToStaticMarkup(
  React.createElement(mod.TerminalCommandLine, {
    command: "npm run build\nls -la",
  }),
);
const preview = renderToStaticMarkup(
  React.createElement(
    "div",
    { className: "text-muted-foreground whitespace-pre-wrap" },
    React.createElement(mod.TerminalCommandLine, { command: "git status" }),
  ),
);
console.log("expandedHeader HTML:", JSON.stringify(html));
console.log("preview HTML:       ", JSON.stringify(preview));
