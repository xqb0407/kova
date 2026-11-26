"use client";

/**
 * 编辑器内的自定义下拉：块类型 / 代码语言。
 * 不用原生 <select>：字号、间距、深色模式与浮层样式都无法和编辑器统一，
 * 代码语言还需要可搜索。
 */

import { useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { KEYS } from "platejs";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export const CODE_LANGUAGES = [
  ["", "plain"],
  ["ts", "TypeScript"],
  ["tsx", "TSX"],
  ["js", "JavaScript"],
  ["jsx", "JSX"],
  ["json", "JSON"],
  ["bash", "Bash"],
  ["css", "CSS"],
  ["html", "HTML"],
  ["md", "Markdown"],
  ["python", "Python"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["java", "Java"],
  ["c", "C"],
  ["cpp", "C++"],
  ["sql", "SQL"],
  ["yaml", "YAML"],
] as const;

const triggerClass =
  "hover:bg-hover text-foreground inline-flex h-8 items-center gap-1 rounded-md bg-transparent px-2 text-xs font-medium outline-none transition-colors";

export function BlockTypePicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (type: string) => void;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const options = [
    { value: KEYS.p, label: t("library.editor.block.paragraph") },
    { value: KEYS.h1, label: t("library.editor.block.heading1") },
    { value: KEYS.h2, label: t("library.editor.block.heading2") },
    { value: KEYS.h3, label: t("library.editor.block.heading3") },
  ];
  const current =
    options.find((option) => option.value === value) ?? options[0]!;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("library.editor.bubble.turnInto")}
            className={cn(triggerClass, "mr-1", className)}
          >
            {current.label}
            <ChevronDownIcon className="text-muted-foreground size-3.5" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-40 gap-0 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
            className={cn(
              "hover:bg-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
              option.value === value && "bg-selected",
            )}
          >
            <CheckIcon
              className={cn(
                "size-3.5",
                option.value === value
                  ? "text-foreground"
                  : "text-transparent",
              )}
            />
            {option.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function CodeLanguagePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (lang: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const current = CODE_LANGUAGES.find(([lang]) => lang === value);
  const label = current && current[0] ? current[1] : t("library.editor.code.plain");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("library.editor.code.language")}
            className="hover:bg-hover text-muted-foreground inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs transition-colors"
          >
            {label}
            <ChevronDownIcon className="size-3" />
          </button>
        }
      />
      <PopoverContent align="start" className="w-56 gap-0 p-0">
        <Command>
          <CommandInput
            placeholder={t("library.editor.code.searchLanguage")}
          />
          <CommandList className="max-h-64">
            <CommandEmpty>{t("library.editor.slash.empty")}</CommandEmpty>
            <CommandGroup>
              {CODE_LANGUAGES.map(([lang, name]) => (
                <CommandItem
                  key={lang || "plain"}
                  value={`${name} ${lang}`}
                  onSelect={() => {
                    onChange(lang);
                    setOpen(false);
                  }}
                  className="gap-2 text-xs"
                >
                  <CheckIcon
                    className={cn(
                      "size-3.5",
                      lang === value ? "text-foreground" : "text-transparent",
                    )}
                  />
                  {lang ? name : t("library.editor.code.plain")}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
