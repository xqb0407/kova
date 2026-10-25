"use client";

/**
 * 资料库文件的标签编辑行（查看器，资料库根下的文件才显示）。
 *
 * 元数据在 `library_file_meta`（只存标题/标签，不存正文）：标签编辑即时保存，
 * `@` 选择器据此按 tag 搜索。文件已被外部删除（watcher/刷新标记 missing）时
 * 不给编辑，只给「移除元数据」；文件恢复后标签自动回来，无需重建。
 *
 * 视觉：彩色药丸（按标签名取确定色相，色点 + 淡色底 + 描边）+ 明确的
 * 「＋ 标签」入口；点 × 删除后给一条可撤销的 toast。
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

/** 药丸底色/描边（半透明色相在上面两种主题下都成立；文字用主题前景色） */
function tagChipStyle(tag: string): CSSProperties {
  const hue = tagHue(tag);
  return {
    backgroundColor: `hsl(${hue} 72% 55% / 0.16)`,
    boxShadow: `inset 0 0 0 1px hsl(${hue} 62% 55% / 0.32)`,
  };
}

/** 可见标签上限：超出收成 +N（悬浮看全部），避免查看器一行被标签占满 */
const MAX_VISIBLE_TAGS = 3;

export const NoteTagsEditor: FC<{
  cwd: string;
  rel: string;
  className?: string;
}> = ({ cwd, rel, className }) => {
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
      title: `已移除 #${tag}`,
      status: "neutral",
      duration: 5000,
      action: {
        label: "撤销",
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
        <span>文件已不存在（可能被移动或删除），标签已停用</span>
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
          移除元数据
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
        const hue = tagHue(tag);
        return (
          <span
            key={tag}
            style={tagChipStyle(tag)}
            className="group/tag text-foreground inline-flex h-7 max-w-44 items-center gap-1.5 rounded-full pl-2.5 pr-1.5 text-[13px] font-medium leading-none"
          >
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: `hsl(${hue} 68% 48%)` }}
            />
            <span className="truncate">#{tag}</span>
            <button
              type="button"
              title={`移除 #${tag}`}
              aria-label={`移除标签 ${tag}`}
              className="hover:bg-foreground/10 grid size-5 shrink-0 place-items-center rounded-full opacity-65 transition-opacity group-hover/tag:opacity-100"
              onClick={() => removeTag(tag)}
            >
              <XIcon className="size-3.5" strokeWidth={2.25} />
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
                className="text-muted-foreground bg-muted/70 hover:bg-muted inline-flex h-7 cursor-default items-center rounded-full px-2.5 text-xs font-medium tabular-nums"
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
          <span className="bg-muted/70 ring-border/70 focus-within:ring-ring/50 inline-flex h-7 items-center gap-1 rounded-full px-2.5 ring-1 ring-inset transition-shadow focus-within:ring-2">
            {/* 固定 # 前缀：标签展示时就带 #，输入时不用自己敲；敲了也会被归一化去掉 */}
            <span className="text-muted-foreground/70 text-[13px] font-semibold">
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
              aria-label="添加标签"
              placeholder="标签名"
              spellCheck={false}
              className="text-foreground placeholder:text-muted-foreground/60 w-24 bg-transparent text-[13px] outline-none"
            />
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-muted-foreground hover:text-foreground border-border/80 hover:border-foreground/30 hover:bg-muted/60 inline-flex h-7 items-center gap-1 rounded-full border border-dashed px-2.5 text-[13px] font-medium transition-colors"
          >
            <PlusIcon className="size-3.5" strokeWidth={2.25} />
            标签
          </button>
        )
      ) : null}
    </div>
  );
};
