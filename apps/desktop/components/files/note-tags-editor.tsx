"use client";

/**
 * 资料库文件的标签编辑行（查看器，资料库根下的文件才显示）。
 *
 * 元数据在 `library_file_meta`（只存标题/标签，不存正文）：标签编辑即时保存，
 * `@` 选择器据此按 tag 搜索。文件已被外部删除（watcher/刷新标记 missing）时
 * 不给编辑，只给「移除元数据」；文件恢复后标签自动回来，无需重建。
 *
 * 视觉：Notion 式属性行——按标签名取确定色相的实底粉彩小方块（圆角 4px、
 * 同色系深字，无边框无色点），添加/输入态是不带描边的中性灰 chip 退居其次。
 * 深浅主题用 light-dark() 一套内联样式覆盖（layout bootstrap 会设 color-scheme）。
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  libraryFileMetaDelete,
  libraryFileMetaGet,
  libraryFileMetaSet,
  normalizeNoteTags,
} from "@/lib/workspace/library-note-meta";

/** 标签色相：同名稳定同色，不同标签尽量分散 */
function tagHue(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash * 31 + tag.charCodeAt(i)) % 360;
  }
  return hash;
}

/** 药丸底色/文字（Notion 式实底粉彩：浅色=淡底深字，深色=暗底亮字） */
function tagChipStyle(tag: string): CSSProperties {
  const hue = tagHue(tag);
  return {
    backgroundColor: `light-dark(hsl(${hue} 72% 88%), hsl(${hue} 42% 26%))`,
    color: `light-dark(hsl(${hue} 50% 30%), hsl(${hue} 65% 78%))`,
  };
}

/** 可见标签上限：超出收成 +N（悬浮看全部），避免查看器一行被标签占满 */
const MAX_VISIBLE_TAGS = 3;

export const NoteTagsEditor: FC<{
  cwd: string;
  rel: string;
  className?: string;
  /** 标签变化后同步到文件自身（原生笔记的 envelope.tags） */
  onChange?: (tags: string[]) => void;
}> = ({ cwd, rel, className, onChange }) => {
  const t = useT();
  const [load, setLoad] = useState<
    | { status: "loading" }
    | { status: "ready"; tags: string[]; missing: boolean }
  >({ status: "loading" });
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 最新标签列表镜像：撤销 toast 的回调要读当前值，不能读移除那一刻的闭包 */
  const tagsRef = useRef<string[]>([]);
  tagsRef.current = load.status === "ready" ? load.tags : [];

  useEffect(() => {
    let alive = true;
    setLoad({ status: "loading" });
    setInput("");
    setAdding(false);
    void libraryFileMetaGet(cwd, rel)
      .then((meta) => {
        if (!alive) return;
        setLoad({
          status: "ready",
          // 读侧也归一化：历史数据里可能存在 `-123` 这类与 `123` 视觉重复的
          // 脏标签（旧版「# + 空格」归一化顺序的产物），展示前先收敛
          tags: normalizeNoteTags(meta?.tags ?? []),
          missing: meta?.missing ?? false,
        });
      })
      .catch(() => {
        if (alive) setLoad({ status: "ready", tags: [], missing: false });
      });
    return () => {
      alive = false;
    };
  }, [cwd, rel]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const save = (tags: string[]) => {
    const normalized = normalizeNoteTags(tags);
    setLoad({ status: "ready", tags: normalized, missing: false });
    void libraryFileMetaSet(cwd, rel, { tags: normalized }).catch(() => {});
    onChange?.(normalized);
  };

  const addTag = (raw?: string) => {
    const value = (raw ?? input).trim();
    setInput("");
    setAdding(false);
    if (!value) return;
    if (load.status !== "ready") return;
    const before = load.tags;
    const next = normalizeNoteTags([...before, value]);
    // 归一化后没有新增（重复标签/纯符号）→ 不写库
    if (next.length === before.length) return;
    save(next);
  };

  const removeTag = (tag: string) => {
    if (load.status !== "ready") return;
    save(load.tags.filter((item) => item !== tag));
    toast.add({
      title: t("library.noteTags.removed", { tag }),
      status: "neutral",
      duration: 5000,
      action: {
        label: t("library.noteTags.undo"),
        onClick: () => {
          // 期间又手动加回去就不重复插
          if (tagsRef.current.includes(tag)) return;
          save([...tagsRef.current, tag]);
        },
      },
    });
  };

  if (load.status !== "ready") return null;

  // 文件已被外部删除：不给编辑（改了也没意义），只留清理入口
  if (load.missing) {
    return (
      <div
        className={cn(
          "text-muted-foreground/70 flex min-w-0 items-center gap-2 text-xs",
          className,
        )}
      >
        <span>{t("library.noteTags.missing")}</span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          onClick={() => {
            void libraryFileMetaDelete(cwd, [rel]).then(() =>
              setLoad({ status: "ready", tags: [], missing: true }),
            );
          }}
        >
          {t("library.noteTags.removeMeta")}
        </Button>
      </div>
    );
  }

  const visibleTags = load.tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTags = load.tags.slice(MAX_VISIBLE_TAGS);

  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
    >
      {visibleTags.map((tag) => {
        return (
          <span
            key={tag}
            style={tagChipStyle(tag)}
            className="group/tag inline-flex h-6 max-w-44 items-center gap-1 rounded pl-2 pr-1 text-xs font-medium leading-none"
          >
            <span className="truncate">#{tag}</span>
            <button
              type="button"
              title={t("library.noteTags.removeTitle", { tag })}
              aria-label={t("library.noteTags.removeAria", { tag })}
              className="hover:bg-foreground/10 grid size-4 shrink-0 place-items-center rounded-sm opacity-50 transition-opacity group-hover/tag:opacity-100 focus-visible:opacity-100"
              onClick={() => removeTag(tag)}
            >
              <XIcon className="size-3" strokeWidth={2.25} />
            </button>
          </span>
        );
      })}

      {hiddenTags.length > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="text-muted-foreground bg-muted/70 hover:bg-muted inline-flex h-6 cursor-default items-center rounded px-2 text-xs font-medium tabular-nums"
              >
                +{hiddenTags.length}
              </span>
            }
          />
          <TooltipContent side="top" align="end" className="max-w-64">
            {/* tooltip 底色是 foreground，条目用 text-background；色点保留色相 */}
            <div className="flex max-h-48 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
              {load.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-background inline-flex items-center gap-1 text-xs font-medium"
                >
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: `hsl(${tagHue(tag)} 72% 62%)` }}
                  />
                  #{tag}
                </span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {load.tags.length < 20 ? (
        adding ? (
          /* 输入态 = 彩色标签的「中性幽灵 chip」：矩形淡灰底、无边框——
             之前灰底+灰环两层描边又厚又笨；聚焦时底色略加深即可 */
          <span className="bg-muted/70 focus-within:bg-hover inline-flex h-6 items-center gap-0.5 rounded px-2 transition-colors">
            {/* 固定 # 前缀：标签展示时就带 #，输入时不用自己敲；敲了也会被归一化去掉 */}
            <span className="text-muted-foreground/60 text-xs font-semibold">
              #
            </span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                // 逗号/回车即添加（中文输入法的逗号在 compositionend 后原样进来）
                if (e.target.value.endsWith(",")) {
                  addTag(e.target.value.slice(0, -1));
                  return;
                }
                setInput(e.target.value);
              }}
              onKeyDown={(e) => {
                // IME 组合中：回车是确认候选词，不是添加标签
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setInput("");
                  setAdding(false);
                } else if (e.key === "Backspace" && !input) {
                  setAdding(false);
                }
              }}
              onBlur={() => {
                // 失焦视为提交：有内容就加，没内容就收起
                if (input.trim()) addTag();
                else setAdding(false);
              }}
              aria-label={t("library.noteTags.addAria")}
              placeholder={t("library.noteTags.placeholder")}
              spellCheck={false}
              className="text-foreground placeholder:text-muted-foreground/50 w-24 bg-transparent text-xs outline-none"
            />
          </span>
        ) : (
          /* 添加入口：淡灰底幽灵 chip（无边框），和输入态同一族——真实标签
             （粉彩实底）是唯一的主角，空态一律退后 */
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-muted-foreground bg-muted/40 hover:bg-muted hover:text-foreground inline-flex h-6 items-center gap-1 rounded px-2 text-xs font-medium transition-colors"
          >
            <PlusIcon className="size-3" strokeWidth={2.25} />
            {t("library.noteTags.addLabel")}
          </button>
        )
      ) : null}
    </div>
  );
};
