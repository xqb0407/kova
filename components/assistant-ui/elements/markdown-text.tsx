"use client";

import { type FC, memo, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  StreamdownTextPrimitive,
  useStreamdownPreProps,
} from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import "@/app/styles/markdown.css";

const MarkdownTextImpl = () => {
  return (
    <div
      className={cn(
        "aui-markdown",
        "overflow-hidden wrap-break-word",
        "[&_li>p]:inline [&_li>p]:mb-0",
      )}
    >
      <StreamdownTextPrimitive
        plugins={{ code, math, mermaid, cjk }}
        className="aui-md text-[14px]"
        shikiTheme={["github-light", "github-dark"]}
        components={{
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto my-3 border rounded-md">
              <table
                className=" w-full text-md [&>thead]:bg-muted [&>thead>tr>th]:bg-muted"
                {...props}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th
              className="text-left font-medium px-3 py-2 bg-[#f0f0f0]"
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td
              className="px-3 py-2 border-t text-an-foreground"
              {...props}
            >
              {children}
            </td>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              className="  pl-3 italic mb-2 text-sm border-l-2 border-an-border-color text-foreground/70"
              {...props}
            >
              {children}
            </blockquote>
          ),
        }}
      />
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
