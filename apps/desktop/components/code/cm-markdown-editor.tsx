"use client";

import { useEffect, useMemo, useState, type CSSProperties, type FC } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, placeholder as cmPlaceholder } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { cn } from "@/lib/utils";
import {
  codeThemeExtension,
  languageForPath,
  resolveCodeThemeName,
} from "@/lib/markdown/code-theme";
import { useHtmlDark } from "@/lib/settings/use-html-dark";
import { useUiPrefs } from "@/lib/settings/ui-prefs";
import "@/app/styles/codemirror.css";

/**
 * 可编辑 Markdown 编辑器（CodeMirror）：人设/人格描述等 Markdown 文本的编辑场景。
 * 与只读视图 cm-code.tsx 共用主题/字号配置（「外观 → 代码设置」）与 codemirror.css，
 * 容器加 aui-cm-edit 恢复编辑光标（aui-cm-code 对只读视图隐藏了 caret）。
 */
export const MarkdownEditor: FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 编辑器固定高度（@uiw/react-codemirror 的 height，内部自行滚动） */
  height?: string;
}> = ({ value, onChange, placeholder, className, height }) => {
  const prefs = useUiPrefs();
  const dark = useHtmlDark();
  // markdown 语言扩展懒加载（language-data 按 persona.md 命中）
  const [lang, setLang] = useState<Extension[]>([]);
  useEffect(() => {
    let alive = true;
    void languageForPath("persona.md").then((exts) => {
      if (alive) setLang(exts);
    });
    return () => {
      alive = false;
    };
  }, []);

  const extensions = useMemo(
    () => [
      EditorView.lineWrapping,
      ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      ...lang,
      codeThemeExtension(resolveCodeThemeName(prefs, dark), dark),
    ],
    [placeholder, lang, prefs, dark],
  );

  return (
    <div
      className={cn("aui-cm-code aui-cm-edit overflow-hidden", className)}
      style={{ "--cm-font-size": `${prefs.codeFontSize}px` } as CSSProperties}
    >
      <CodeMirror
        className="h-full"
        value={value}
        onChange={onChange}
        editable
        theme="none"
        height={height}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          bracketMatching: false,
          closeBrackets: false,
          highlightSelectionMatches: false,
          searchKeymap: false,
        }}
        extensions={extensions}
      />
    </div>
  );
};
