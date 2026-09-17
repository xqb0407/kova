"use client";

import { type ComponentProps } from "react";
import { AskUserQuestions, type AskUserQuestion } from "@/components/ui/ask-user-questions";

// Generated from a fluidfunctionalism.com playground preset —
// swap the questions for your own.
const questions: AskUserQuestion[] = [
  {
    id: "role",
    title: "How do you plan to use Fluid Functionalism?",
    options: [
      { id: "design", title: "Designer", description: "Prototyping flows and pages" },
      { id: "eng", title: "Engineer", description: "Shipping production UI" },
      { id: "pm", title: "PM", description: "Aligning the team on patterns" },
      { id: "founder", title: "Founder", description: "Bootstrapping a product" },
    ],
  },
  {
    id: "drew",
    title: "What drew you to Fluid Functionalism?",
    options: [
      { id: "motion", title: "Motion", description: "Springs that feel alive" },
      { id: "craft", title: "Craft", description: "Pixel-level polish" },
      { id: "tokens", title: "Tokens", description: "Shape and elevation systems" },
    ],
  },
  {
    id: "recommend",
    title: "Would you recommend Fluid Functionalism to a teammate?",
    options: [
      { id: "yes", title: "Yes", description: "Already have" },
      { id: "soon", title: "Soon", description: "Once it covers more ground" },
      { id: "unsure", title: "Not sure yet", description: "Still evaluating" },
    ],
  },
];

export function QuestionFlow(
  props: Omit<ComponentProps<typeof AskUserQuestions>, "questions">
) {
  return <AskUserQuestions questions={questions} {...props} />;
}
