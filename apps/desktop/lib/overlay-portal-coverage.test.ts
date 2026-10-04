import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 浮层遮挡登记的结构守卫。
 *
 * 这条测试存在的原因是一次真实漏项：`<OcclusionSlot />` 当时被放在
 * `DialogContent` 里而不是 `DialogPortal` 里，于是直接用 `DialogPortal`
 * 自组浮层的调用方——截图预览 `image-data.tsx` 的全屏放大层——完全绕过了
 * 登记，浏览器子 webview 盖上来，预览被压在下面。本仓库没有 DOM 测试环境
 * （happy-dom / jsdom 都没装），渲染断言写不了；但漏项的性质是"放错位置"，
 * 位置本身可以从源码判定，所以在这里钉死。
 *
 * 不变量：**每个 Portal 开标签的下一个元素子节点都必须是 `<OcclusionSlot />`**。
 * 放在 Content 里不算数——那正是漏掉自组浮层调用方的原因。
 */

const UI_DIR = join(import.meta.dir, "..", "components", "ui");

/** 会浮到主 webview 之上的浮层组件，一个都不能少 */
const FLOATING_FILES = [
  "dialog.tsx",
  "alert-dialog.tsx",
  "sheet.tsx",
  "popover.tsx",
  "dropdown-menu.tsx",
  "context-menu.tsx",
  "select.tsx",
] as const;

/** 只匹配真正渲染 portal 的原语标签（`DialogPrimitive.Portal` / `AlertDialog.Portal`）。
 *  不能匹配 `<DialogPortal>` 这类包装组件的**调用**——它的首个元素子节点是
 *  Overlay/Positioner 才对，slot 由包装函数内部自己渲染。 */
const PORTAL_OPEN = /<([A-Za-z][\w]*\.Portal)\b[^>]*>/g;

/** 注释里会出现 `<OcclusionSlot/>` 这样的字面量（解释坑时顺手写的），
 *  结构守卫必须只看代码，否则会被自己的注释数出一份。整行 `//` 开头才剥，
 *  免得误伤字符串里的 `https://`。 */
function stripComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 开标签闭合后允许空白与换行，再取下一个 token */
function firstChildAfter(source: string, endIndex: number): string {
  const rest = source.slice(endIndex).replace(/^\s*/, "");
  const m = /^<([A-Za-z][\w.]*)/.exec(rest);
  return m?.[1] ?? "";
}

describe("浮层 Portal 的遮挡登记", () => {
  for (const file of FLOATING_FILES) {
    test(`${file}：每个 Portal 的首个子节点都是 OcclusionSlot`, () => {
      const source = stripComments(readFileSync(join(UI_DIR, file), "utf8"));
      const portals = [...source.matchAll(PORTAL_OPEN)];

      // 文件里一个 Portal 都没有 = 浮层被改写掉了，守卫失效，必须报出来
      expect(portals.length).toBeGreaterThan(0);

      const offenders = portals
        .map((m) => ({ tag: m[1], first: firstChildAfter(source, m.index! + m[0].length) }))
        .filter((p) => p.first !== "OcclusionSlot");

      expect(offenders).toEqual([]);
    });
  }

  test("登记位数量与 portal 渲染点一一对应，没有多挂在 Content 里", () => {
    // 多出来的那一个就是漏在 Content 里的登记位——上一次漏项的直接成因
    for (const file of FLOATING_FILES) {
      const source = stripComments(readFileSync(join(UI_DIR, file), "utf8"));
      const slots = (source.match(/<OcclusionSlot\s*\/>/g) ?? []).length;
      const portals = (source.match(PORTAL_OPEN) ?? []).length;
      expect({ file, slots, portals }).toEqual({ file, slots: portals, portals });
    }
  });

  // 往 Portal 里塞登记位时踩过的第二个坑：JSX 的显式子节点会覆盖 {...props} 里
  // 的 children。写成 <Portal {...props}><OcclusionSlot /></Portal>，调用方
  // 传进来的整棵子树就被悄悄丢掉——截图预览弹窗变成空壳，点什么都没反应，
  // 而上面两条守卫全绿。必须解构出 children 并显式渲染。
  const WRAPPER_PORTALS = [
    "dialog.tsx",
    "alert-dialog.tsx",
    "sheet.tsx",
    "dropdown-menu.tsx",
  ] as const;

  test("包装 Portal 必须解构并显式渲染 children，否则会覆盖调用方的子树", () => {
    for (const file of WRAPPER_PORTALS) {
      const source = stripComments(readFileSync(join(UI_DIR, file), "utf8"));
      // 解构出 children
      expect({ file, destructures: /\{\s*children\s*,\s*\.\.\./.test(source) }).toEqual({
        file,
        destructures: true,
      });
      // 且真的把它渲染出来了（OcclusionSlot 之后）
      expect({
        file,
        renders: /<OcclusionSlot\s*\/>\s*\{children\}/.test(source),
      }).toEqual({ file, renders: true });
    }
  });
});
