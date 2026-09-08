"use client";

import { useState, type FC, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAui } from "@assistant-ui/react";
import {
  ChartColumnIcon,
  CloudSunIcon,
  CodeXmlIcon,
  LightbulbIcon,
  PencilLineIcon,
} from "lucide-react";

type SuggestionGroup = {
  label: string;
  icon: ReactNode;
  options: { label: string; prompt: string }[];
};

const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    label: "Weather",
    icon: <CloudSunIcon />,
    options: [
      {
        label: "in San Francisco",
        prompt: "What's the weather in San Francisco?",
      },
      { label: "in Singapore", prompt: "What's the weather in Singapore?" },
      { label: "in Tokyo", prompt: "What's the weather in Tokyo?" },
      { label: "in London", prompt: "What's the weather in London?" },
    ],
  },
  {
    label: "Code",
    icon: <CodeXmlIcon />,
    options: [
      {
        label: "explain React hooks",
        prompt: "Explain React hooks like useState and useEffect",
      },
      {
        label: "write a debounce function",
        prompt: "Write a debounce function in TypeScript",
      },
      {
        label: "review a useEffect cleanup",
        prompt: "Show me the right way to clean up a subscription in useEffect",
      },
    ],
  },
  {
    label: "Write",
    icon: <PencilLineIcon />,
    options: [
      {
        label: "a birthday card message",
        prompt:
          "Help me write a birthday card message for a friend in the notepad",
      },
      {
        label: "a product announcement",
        prompt: "Draft a short product announcement for a new dark mode",
      },
      {
        label: "release notes",
        prompt:
          "Write release notes for a bugfix release of a React component library",
      },
      {
        label: "a PR description",
        prompt:
          "Write a pull request description for a change that adds keyboard shortcuts",
      },
    ],
  },
  {
    label: "Analyze",
    icon: <ChartColumnIcon />,
    options: [
      {
        label: "React vs Vue vs Svelte",
        prompt: "Compare React, Vue, and Svelte in a table",
      },
      {
        label: "GDP of US, China, Japan",
        prompt:
          "Compare the GDP of the United States, China, and Japan in a table",
      },
      {
        label: "pros and cons of SSR",
        prompt: "What are the pros and cons of server-side rendering?",
      },
    ],
  },
  {
    label: "Brainstorm",
    icon: <LightbulbIcon />,
    options: [
      {
        label: "side project ideas",
        prompt: "Brainstorm five side project ideas for a React developer",
      },
      {
        label: "names for a dev tool",
        prompt: "Brainstorm names for a developer tools startup",
      },
      {
        label: "talk topics",
        prompt: "Brainstorm talk topics for a React meetup",
      },
    ],
  },
];

const suggestionChipClass =
  "aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors [&_svg]:size-4";

export const ThreadSuggestions: FC = () => {
  const aui = useAui();
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const expandedGroup = SUGGESTION_GROUPS.find(
    (group) => group.label === expandedLabel,
  );

  const sendPrompt = (prompt: string) => {
    if (aui.thread.getState().isRunning) return;
    aui.thread.append({
      content: [{ type: "text", text: prompt }],
      runConfig: aui.composer.getState().runConfig,
    });
  };

  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col gap-2 px-4">
      <div className="w-full scrollbar-none overflow-x-auto">
        <div className="mx-auto flex w-max items-center gap-2">
          {SUGGESTION_GROUPS.map((group) => (
            <Button
              key={group.label}
              variant="ghost"
              className={cn(
                suggestionChipClass,
                group.label === expandedLabel && "bg-muted",
              )}
              onClick={() =>
                setExpandedLabel(
                  group.label === expandedLabel ? null : group.label,
                )
              }
            >
              {group.icon}
              {group.label}
            </Button>
          ))}
        </div>
      </div>
      {expandedGroup && (
        <div
          key={expandedGroup.label}
          className="fade-in slide-in-from-top-1 animate-in w-full scrollbar-none overflow-x-auto duration-200"
        >
          <div className="mx-auto flex w-max items-center gap-2">
            {expandedGroup.options.map((option) => (
              <Button
                key={option.label}
                variant="ghost"
                className={suggestionChipClass}
                onClick={() => sendPrompt(option.prompt)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};