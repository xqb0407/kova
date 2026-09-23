"use client";

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FC,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
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
 * CodeMirror 只读代码视图：面板 diff 已迁到 @pierre/diffs（panel-diff.tsx），
 * 这里保留给设置页代码预览与后续的文件内容预览，主题/行号/换行/字号
 * 同样取自「外观 → 代码设置」。
 */

/**
 * 代码设置（外观 → 代码设置）→ CodeMirror 渲染参数。
 * forceDark 供设置页"浅色/深色预览"双卡片强制指定配色，不跟随界面。
 */
function useCodeSettings(forceDark?: boolean) {
  const prefs = useUiPrefs();
  const htmlDark = useHtmlDark();
  const dark = forceDark ?? htmlDark;
  return {
    dark,
    themeName: resolveCodeThemeName(prefs, dark),
    lineNumbers: prefs.codeLineNumbers,
    wrap: prefs.codeWrap,
    fontSize: prefs.codeFontSize,
  };
}

/** 语言扩展按文件名懒加载（未命中=纯文本） */
function useLanguage(path?: string): Extension[] {
  const [lang, setLang] = useState<Extension[]>([]);
  useEffect(() => {
    if (!path) {
      setLang([]);
      return;
    }
    let alive = true;
    void languageForPath(path).then((exts) => {
      if (alive) setLang(exts);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return lang;
}

const BASIC_SETUP = (lineNumbers: boolean) => ({
  lineNumbers,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  bracketMatching: false,
  closeBrackets: false,
  highlightSelectionMatches: false,
  searchKeymap: false,
});

/** 长行自动换行：lineWrapping + 词内断行（窄面板里 base64 等长 token 也不溢出） */
const WRAP_EXTENSION = [
  EditorView.lineWrapping,
  EditorView.theme({ "& .cm-content": { overflowWrap: "anywhere" } }),
];

function Shell({
  value,
  extensions,
  settings,
  className,
  height,
}: {
  value: string;
  extensions: Extension[];
  settings: ReturnType<typeof useCodeSettings>;
  className?: string;
  /** 容器定高（如 "72vh"）：编辑器内部滚动（行号 sticky 跟随）；不传自适应内容高 */
  height?: string;
}) {
  return (
    <div
      className={cn("aui-cm-code overflow-hidden", className)}
      style={{ "--cm-font-size": `${settings.fontSize + 2}px` } as CSSProperties}
    >
      <CodeMirror
        value={value}
        editable={false}
        readOnly
        theme="none"
        height={height}
        basicSetup={BASIC_SETUP(settings.lineNumbers)}
        extensions={extensions}
      />
    </div>
  );
}

/**
 * 只读代码视图（带语法高亮，语言按文件名懒加载）：设置页代码预览、
 * 「我的文件」文件预览用。
 */
export const CodeMirrorCode: FC<{
  value: string;
  path: string;
  className?: string;
  forceDark?: boolean;
  height?: string;
}> = ({ value, path, className, forceDark, height }) => {
  const settings = useCodeSettings(forceDark);
  const lang = useLanguage(path);
  const extensions = useMemo(
    () => [
      ...(settings.wrap ? WRAP_EXTENSION : []),
      ...lang,
      codeThemeExtension(settings.themeName, settings.dark),
    ],
    [settings.wrap, settings.themeName, settings.dark, lang],
  );
  return (
    <Shell
      value={value}
      extensions={extensions}
      settings={settings}
      className={className}
      height={height}
    />
  );
};
