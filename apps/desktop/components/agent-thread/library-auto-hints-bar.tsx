"use client";

/**
 * 输入框上方的「可能相关」资料库建议：草稿防抖后本地检索最近条目，点一下
 * 插入 `:library` 芯片。它补的是「模型/用户都没想到去搜」的召回缺口；
 * 发送端还有一份标题级保底（见 lib/composer/library-auto-hints 的隐藏块）。
 *
 * 不显示的情况：命令/提及开头、被用户主动忽略的同一查询、已引用的笔记。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { LibraryIcon, SparklesIcon, XIcon } from "lucide-react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  autoHintText,
  suggestLibraryEntries,
} from "@/lib/composer/library-auto-hints";
import {
  buildLibraryDirective,
  collectLibraryReferences,
  joinFsPath,
} from "@/lib/composer/library-reference";
import type { LibraryIndexEntry } from "@/lib/workspace/library-index";
import { useLibraryRoot } from "@/lib/workspace/library-root";
import { projectFolderFor } from "@/lib/workspace/library-save-note";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import { useLibraryAutoRecallEnabled } from "@/lib/settings/library-recall-pref";
import { insertOrAppendDirective } from "./cm-composer-input";
import { useT } from "@/lib/i18n";

const DEBOUNCE_MS = 300;
const MAX_HINTS = 3;

export const LibraryAutoHintsBar: FC<{ hidden?: boolean }> = ({ hidden }) => {
  const t = useT();
  const aui = useAui();
  const rootInfo = useLibraryRoot();
  const root = rootInfo?.root ?? null;
  const recallEnabled = useLibraryAutoRecallEnabled();
  const draft = useAuiState((s) => s.composer.text);
  const debounced = useDebouncedValue(draft, DEBOUNCE_MS);
  const query = autoHintText(debounced);
  const referenced = useMemo(
    () => new Set(collectLibraryReferences(debounced).map((item) => item.ref.rel)),
    [debounced],
  );
  const [hits, setHits] = useState<LibraryIndexEntry[]>([]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const seqRef = useRef(0);

  // 业务闭环：当前工作空间的知识优先，其次才是全局（与 @ 选择器同规则）
  const currentDir = useProjectWorkspaceDir();
  const preferPrefix = useMemo(
    () => (currentDir ? `${projectFolderFor(currentDir)}/` : undefined),
    [currentDir],
  );

  useEffect(() => {
    if (!recallEnabled || !root || !query || dismissed === query) {
      setHits((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const seq = ++seqRef.current;
    let alive = true;
    setHits((prev) => (prev.length === 0 ? prev : []));
    void suggestLibraryEntries(query, referenced, MAX_HINTS, preferPrefix).then(
      (next) => {
        if (!alive || seq !== seqRef.current) return;
        setHits(next);
      },
    );
    return () => {
      alive = false;
    };
  }, [dismissed, preferPrefix, query, recallEnabled, referenced, root]);

  if (hidden || !recallEnabled || !root || hits.length === 0) return null;

  const insert = (hit: LibraryIndexEntry) => {
    const directive = buildLibraryDirective({
      rel: hit.rel,
      name: hit.title || hit.name,
      absPath: joinFsPath(root, hit.rel),
    });
    if (insertOrAppendDirective(aui, directive)) {
      setDismissed(query);
      setHits([]);
    }
  };

  return (
    <div
      data-slot="library-auto-hints"
      className="flex min-w-0 flex-wrap items-center gap-1.5 px-1"
    >
      <span className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-2xs">
        <SparklesIcon className="size-3" />
        {t("library.hints.label")}
      </span>
      {hits.map((hit) => (
        <button
          key={hit.rel}
          type="button"
          title={t("library.hints.referenceTitle", { path: hit.rel })}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => insert(hit)}
          className="bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors"
        >
          <LibraryIcon className="size-3 shrink-0" />
          <span className="max-w-44 truncate">{hit.title || hit.name}</span>
        </button>
      ))}
      <button
        type="button"
        title={t("library.hints.dismissTitle")}
        aria-label={t("library.hints.dismissAria")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setDismissed(query);
          setHits([]);
        }}
        className="text-muted-foreground/60 hover:text-foreground inline-flex size-5 items-center justify-center rounded-full transition-colors"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
};
