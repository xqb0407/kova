import { useHydrated } from "@/components/assistant-ui/elements/surfaces";
import { Icon } from "@/components/ui/icon";
import type { TextMessagePartProps } from "@assistant-ui/react-native";
import * as Clipboard from "expo-clipboard";
import {
  CheckIcon,
  CopyIcon,
  Maximize2Icon,
  XIcon,
} from "lucide-react-native";
import {
  type FC,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  MarkedLexer,
  type MarkedStyles,
  MarkedTokenizer,
  Renderer,
  useMarkdown,
  type useMarkdownHookOptions,
} from "react-native-marked";
import remend from "remend";
import { useCSSVariable, useUniwind } from "uniwind";
import { useTheme } from "@/components/ui/theme";
import { CODE_PALETTE, highlightCode } from "@/lib/markdown/code-highlight";
import { useSmoothText } from "@/lib/markdown/use-smooth-text";

/** 打字机两次「渲染提交」之间的最小间隔（ms）：markdown 重解析的成本闸门 */
const STREAM_INTERVAL_MS = 50;

/** 块切分的词法分析（注入给增量缓存；空块被过滤掉，不参与渲染与复用） */
const lexMarkdownBlocks = (text: string) =>
  MarkedLexer(text, { gfm: true })
    .filter((token) => token.type !== "space")
    .map((token) => ({ raw: token.raw, type: token.type }));
const MONOSPACE = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

type ListToken = NonNullable<ReturnType<MarkedTokenizer["list"]>>;
type ListItemToken = ListToken["items"][number];

// react-native-marked renders a list item from its inline tokens and knows no
// checkbox token, so a task item gets its box folded into the text it owns.
// marked queues inline lexing by value when a token is created, so the folded
// text is queued again into a fresh array, which is the one the parser reads.
const foldTaskBox = (item: ListItemToken, lexer: MarkedTokenizer["lexer"]) => {
  const box = item.checked ? "☑" : "☐";
  const boxIndex = item.tokens.findIndex((token) => token.type === "checkbox");
  const target = item.tokens[boxIndex === -1 ? 0 : boxIndex + 1];
  if (!target || (target.type !== "text" && target.type !== "paragraph")) {
    return;
  }
  const text = `${box} ${target.text.replace(/^\[[ xX]\][ \t]+/, "")}`;
  target.text = text;
  target.raw = text;
  target.tokens = lexer.inline(text, []);
};

export class TaskListTokenizer extends MarkedTokenizer {
  override list(src: string) {
    const list = super.list(src);
    if (list) {
      for (const item of list.items) {
        if (item.task) foldTaskBox(item, this.lexer);
      }
    }
    return list;
  }
}

const taskListTokenizer = new TaskListTokenizer();

const CodeBlock: FC<{ code: string; language: string | undefined }> = ({
  code,
  language,
}) => {
  const [isCopied, setIsCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const unmountedRef = useRef(false);
  // 词法着色：桌面/web 端的 Shiki 管线在 RN 没有对应物，走 lib/markdown/
  // code-highlight 的零依赖分词器；语言不认识/块过大自动回退纯文本。
  const { scheme, colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toks = useMemo(() => highlightCode(code, language), [code, language]);
  const palette = CODE_PALETTE[scheme === "dark" ? "dark" : "light"];

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      clearTimeout(resetTimerRef.current);
    };
  }, []);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(code);
    } catch {
      return;
    }
    if (unmountedRef.current) return;
    setIsCopied(true);
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setIsCopied(false), 2000);
  };

  // 代码正文的着色渲染：行内与弹层共用一份（弹层只是同一段代码的宽松版式）
  const codeText = (
    <Text
      className="text-foreground text-[13px] leading-5"
      style={{ fontFamily: MONOSPACE }}
    >
      {toks
        ? toks.map((tok, i) =>
            tok.c && palette[tok.c] ? (
              <Text key={i} style={{ color: palette[tok.c] }}>
                {tok.v}
              </Text>
            ) : (
              <Text key={i}>{tok.v}</Text>
            ),
          )
        : code}
    </Text>
  );

  return (
    <View className="aui-md-code-block border-border bg-muted/50 my-2 overflow-hidden rounded-xl border">
      <View className="aui-md-code-header border-border/50 flex-row items-center justify-between border-b py-1 pr-1 pl-3.5">
        <Text className="text-muted-foreground text-xs font-medium lowercase">
          {language || "text"}
        </Text>
        <View className="flex-row items-center">
          {/* 展开：手机屏宽下横滚读长代码很难受，点开全屏弹层从容看/选/复制 */}
          <Pressable
            onPress={() => setExpanded(true)}
            className="active:bg-muted size-7 items-center justify-center rounded-md"
            accessibilityRole="button"
            accessibilityLabel="展开代码"
          >
            <Icon
              as={Maximize2Icon}
              className="text-muted-foreground size-3.5"
            />
          </Pressable>
          <Pressable
            onPress={copy}
            className="active:bg-muted size-7 items-center justify-center rounded-md"
            accessibilityRole="button"
            accessibilityLabel="Copy code"
          >
            <Icon
              as={isCopied ? CheckIcon : CopyIcon}
              className="text-muted-foreground size-4"
            />
          </Pressable>
        </View>
      </View>
      <Pressable onPress={() => setExpanded(true)} accessibilityLabel="展开代码">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="px-3.5 py-3"
        >
          {codeText}
        </ScrollView>
      </Pressable>

      <Modal
        transparent
        visible={expanded}
        animationType="fade"
        onRequestClose={() => setExpanded(false)}
      >
        <View
          className="flex-1"
          style={{ backgroundColor: colors.overlay }}
        >
          <View
            className="bg-background border-border m-3 flex-1 overflow-hidden rounded-2xl border"
            style={{ marginTop: insets.top + 12, marginBottom: insets.bottom + 12 }}
          >
            <View className="border-border/50 flex-row items-center justify-between border-b py-1 pr-1 pl-4">
              <Text className="text-muted-foreground text-xs font-medium lowercase">
                {language || "text"}
              </Text>
              <View className="flex-row items-center">
                <Pressable
                  onPress={copy}
                  className="active:bg-muted size-8 items-center justify-center rounded-md"
                  accessibilityRole="button"
                  accessibilityLabel="Copy code"
                >
                  <Icon
                    as={isCopied ? CheckIcon : CopyIcon}
                    className="text-muted-foreground size-4"
                  />
                </Pressable>
                <Pressable
                  onPress={() => setExpanded(false)}
                  className="active:bg-muted size-8 items-center justify-center rounded-md"
                  accessibilityRole="button"
                  accessibilityLabel="关闭代码弹层"
                >
                  <Icon as={XIcon} className="text-muted-foreground size-4" />
                </Pressable>
              </View>
            </View>
            {/* 纵向滚外层、横向滚内层：长代码两个方向都能读 */}
            <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }}
              >
                {codeText}
              </ScrollView>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
};

// One renderer per parse: the constructor takes the text it renders so the
// memo that creates it stays keyed on that text under React Compiler, and the
// key ordinal restarts with each instance.
class MarkdownRenderer extends Renderer {
  keyIndex = 0;

  constructor(_source: string) {
    // 受控实验（debug-chat-text-pan-scroll / 假设A）：iOS 上 selectable
    // 文本附生的原生交互手势会吃掉从文字上起步的 pan，列表不接管滚动。
    super({ selectable: false });
  }

  override getKey(): string {
    return `md-${this.keyIndex++}`;
  }

  override code(text: string, language?: string): ReactNode {
    return <CodeBlock key={this.getKey()} code={text} language={language} />;
  }
}

const asColor = (value: string | number | undefined) =>
  typeof value === "string" ? value : undefined;

type MarkdownTextVariant = "muted";

// The theme and the variables come from the CSSOM, so they apply from the first render after hydration.
const useMarkdownOptions = (
  variant?: MarkdownTextVariant,
): useMarkdownHookOptions => {
  const hydrated = useHydrated();
  const { theme } = useUniwind();
  const variables = useCSSVariable([
    "--color-foreground",
    "--color-primary",
    "--color-muted",
    "--color-muted-foreground",
    "--color-border",
  ]);
  const [foreground, primary, muted, mutedForeground, border] = hydrated
    ? variables
    : [];
  const colorScheme = hydrated && theme === "dark" ? "dark" : "light";

  return useMemo(() => {
    const text = asColor(variant === "muted" ? mutedForeground : foreground);
    const link = asColor(primary);
    const code = asColor(muted);
    const rule = asColor(border);
    const colors =
      text && link && code && rule
        ? { text, link, code, border: rule }
        : undefined;

    const bodyText =
      variant === "muted"
        ? { fontSize: 14, lineHeight: 24 }
        : { fontSize: 16, lineHeight: 26 };
    const styles: MarkedStyles = {
      text: bodyText,
      paragraph: { paddingVertical: 4 },
      li: bodyText,
      list: { paddingVertical: 4 },
      link: { fontStyle: "normal", textDecorationLine: "underline" },
      codespan: {
        fontFamily: MONOSPACE,
        fontSize: 14,
        borderRadius: 4,
        paddingHorizontal: 4,
      },
      blockquote: {
        borderLeftWidth: 2,
        paddingLeft: 12,
        marginVertical: 4,
        opacity: 1,
      },
      hr: { height: 1, marginVertical: 12, borderWidth: 0 },
      h1: {
        fontSize: 24,
        lineHeight: 32,
        fontWeight: "600",
        marginTop: 16,
        marginBottom: 4,
        paddingBottom: 0,
        borderBottomWidth: 0,
      },
      h2: {
        fontSize: 20,
        lineHeight: 28,
        fontWeight: "600",
        marginTop: 14,
        marginBottom: 4,
        paddingBottom: 0,
        borderBottomWidth: 0,
      },
      h3: { fontSize: 18, lineHeight: 26, fontWeight: "600", marginTop: 12 },
      h4: { fontSize: 16, lineHeight: 26, fontWeight: "600", marginTop: 10 },
      h5: { fontSize: 16, lineHeight: 26, fontWeight: "600", marginTop: 8 },
      h6: { fontSize: 16, lineHeight: 26, fontWeight: "600", marginTop: 8 },
      tableCell: { paddingHorizontal: 8, paddingVertical: 6 },
    };

    const options: useMarkdownHookOptions = {
      colorScheme,
      styles,
      tokenizer: taskListTokenizer,
    };
    if (colors) {
      options.theme = { colors };
    }
    return options;
  }, [colorScheme, variant, foreground, primary, muted, mutedForeground, border]);
};

const MarkdownBlock = memo(
  // Each top-level block is re-lexed on its own, so a streaming update re-renders
  // only the block it touched; reference-style link definitions therefore do not
  // resolve across blocks.
  ({ raw, options }: { raw: string; options: useMarkdownHookOptions }) => {
    const renderer = useMemo(() => new MarkdownRenderer(raw), [raw]);
    const elements = useMarkdown(raw, { ...options, renderer });
    return <>{elements}</>;
  },
);
MarkdownBlock.displayName = "MarkdownBlock";

// Streaming tail repair mirrors the web renderer's tailBoundedRemend: marked
// shows an unclosed construct (`**bold`, `code, [link(`, a half-typed table)
// as literal text until it closes, so the block being streamed into gets
// remended on the fly. remend is a pure string library with no DOM usage, so
// it is safe on RN. A closer appended after a settled code span or an unclosed
// html block would corrupt already-stable content, and a closer appended after
// a settled table row would surface as a stray extra row, so those block types
// are skipped; a half-typed row does not lex as a table at all and is still
// repaired.
const REMEND_UNSAFE_TYPES = new Set(["code", "html", "table"]);

// marked 认表的前提是分隔行（|---|---|）完整，在那之前整个半截表按
// 段落 lex——流式时表头已经打出来、分隔行还没到（或还没打完）的窗口里，
// 用户看到的就是 | Name | Age | 这种原始文本。web 端 streamdown 的
// parseIncompleteMarkdown 会替半截表合成一行分隔行，表头打完立刻出
// 表格骨架；这里给 RN 端补同款行为：表头行完整（首尾都是 |）且第二行
// 还没出现时，按表头列数合成一条分隔行喂给 lexer。真分隔行一到，
// 合成行被原文取代，肉眼只是骨架长出了第一列数据。
const repairPartialTable = (raw: string): string => {
  const lines = raw.split("\n");
  if (lines.length !== 1) return raw;
  const header = lines[0].trim();
  if (!header.startsWith("|") || !header.endsWith("|")) return raw;
  const cols = header.split("|").length - 2;
  if (cols < 1) return raw;
  return `${header}\n|${" --- |".repeat(cols)}`;
};

type MarkdownTextProps = TextMessagePartProps & {
  variant?: MarkdownTextVariant;
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ text, status, variant }) => {
  const running = status.type === "running";
  // 打字机推进（移植官方 web 的 TextStreamAnimator，见 lib/markdown/use-smooth-text）：
  // 每帧推进、最多每 50ms 提交一次渲染，积压大就快、积压小就慢——连续的打字机
  // 观感，同时把 markdown 重解析的成本压在提交节流上。
  const shownText = useSmoothText(text, running, { minCommitMs: STREAM_INTERVAL_MS });
  // 揭示进度落后于真实文本时，尾部仍是「半截结构」——remend/半截表修补按这个判定，
  // 不能只看 status（打字机在 status 转 complete 之后还会继续追一小段）
  const revealing = running || shownText !== text;
  const options = useMarkdownOptions(variant);

  const blocks = useMemo(
    () =>
      MarkedLexer(shownText, { gfm: true }).filter(
        (token) => token.type !== "space",
      ),
    [shownText],
  );

  const lastIndex = blocks.length - 1;

  return (
    <View className="aui-md-root">
      {blocks.map((token, index) => {
        let raw = token.raw;
        if (revealing && index === lastIndex) {
          // 尾部块可能还是半截结构（未闭合的行内标记 / 表头等）：按块类型
          // 决定修不修、怎么修（见上方注释）
          const tokenType = token.type;
          if (tokenType === "paragraph") {
            const repaired = repairPartialTable(raw);
            // 合成出分隔行的半截表已是完整表结构，不再走 remend；
            // 普通段落照旧做行内闭合修补
            raw = repaired !== raw ? repaired : remend(raw);
          } else if (!REMEND_UNSAFE_TYPES.has(tokenType)) {
            raw = remend(raw);
          }
        }
        return <MarkdownBlock key={index} raw={raw} options={options} />;
      })}
    </View>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
