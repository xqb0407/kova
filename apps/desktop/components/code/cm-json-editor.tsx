"use client";

import { useEffect, useMemo, useState, type CSSProperties, type FC } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, placeholder as cmPlaceholder } from "@codemirror/view";
import { jsonParseLinter } from "@codemirror/lang-json";
import { linter } from "@codemirror/lint";
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
 * 可编辑 JSON 编辑器（CodeMirror）：MCP 配置等结构化 JSON 的输入场景。
 * 与 cm-markdown-editor 共用主题/字号（「外观 → 代码设置」）；额外挂
 * jsonParseLinter——语法错误在编辑器内画红波浪线（延迟解析，不打断输入），
 * 语义/条目校验由调用方负责（编辑器只管"是不是合法 JSON"）。
 */
export const JsonCodeEditor: FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** 编辑器固定高度（@uiw/react-codemirror 的 height，内部自行滚动） */
  height?: string;
}> = ({ value, onChange, placeholder, className, height }) => {
  const prefs = useUiPrefs();
  const dark = useHtmlDark();
  // json 语言扩展懒加载（language-data 按 mcp.json 命中）
  const [lang, setLang] = useState<Extension[]>([]);
  useEffect(() => {
    let alive = true;
    void languageForPath("mcp.json").then((exts) => {
      if (alive) setLang(exts);
    });
    return () => {
      alive = false;
    };
  }, []);

  const extensions = useMemo(
    () => [
      EditorView.lineWrapping,
      linter(jsonParseLinter(), { delay: 500 }),
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
          bracketMatching: true,
          closeBrackets: true,
          highlightSelectionMatches: false,
          searchKeymap: false,
        }}
        extensions={extensions}
      />
    </div>
  );
};
