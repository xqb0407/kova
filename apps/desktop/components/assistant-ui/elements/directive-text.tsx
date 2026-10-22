"use client";

import type { FC } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type IconComponent = FC<{ className?: string }>;

export type DirectiveTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "mention";
      readonly type: string;
      readonly label: string;
      readonly id: string;
    };

export type DirectiveTextFormatter = {
  /** Parse text into alternating text and directive segments. */
  parse(text: string): readonly DirectiveTextSegment[];
};

export type CreateDirectiveTextOptions = {
  /** Maps a directive `type` to an icon component. */
  iconMap?: Record<string, IconComponent>;
  /** Icon rendered when `iconMap` has no entry for the segment type. */
  fallbackIcon?: IconComponent;
};

/** Creates a text component that parses directive syntax and renders inline chips. */
export function createDirectiveText(
  formatter: DirectiveTextFormatter,
  options?: CreateDirectiveTextOptions,
): FC<{ text: string }> {
  const iconMap = options?.iconMap;
  const fallbackIcon = options?.fallbackIcon;

  const Component: FC<{ text: string }> = ({ text }) => {
    const segments = formatter.parse(text);

    if (segments.length === 1 && segments[0]!.kind === "text") {
      return <>{text}</>;
    }

    return (
      <>
        {segments.map((seg, i) => {
          if (seg.kind === "text") {
            return (
              <span key={i} className="whitespace-pre-wrap">
                {seg.text}
              </span>
            );
          }

          const Icon = iconMap?.[seg.type] ?? fallbackIcon;
          return (
            <Tooltip key={i}>
              <TooltipTrigger
                render={
                  <span className="inline-flex max-w-full min-w-0 align-baseline">
                    <Badge
                      variant="secondary"
                      data-slot="directive-text-chip"
                      data-directive-type={seg.type}
                      data-directive-id={seg.id}
                      aria-label={`${seg.type}: ${seg.label}`}
                      className="aui-directive-chip items-baseline py-0.5 pr-2.5 pl-1.5 text-[13px] leading-none [&_svg]:self-center"
                    >
                      {Icon && <Icon />}
                      <span className="aui-directive-chip-label">
                        {seg.label}
                      </span>
                    </Badge>
                  </span>
                }
              />
              <TooltipContent side="top" className="max-w-96">
                <span className="text-xs break-words">{seg.label}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </>
    );
  };
  Component.displayName = "DirectiveText";
  return Component;
}
