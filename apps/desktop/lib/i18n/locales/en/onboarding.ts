/**
 * 英文词典：引导流程。形状对齐 zh/onboarding.ts。
 */
import { zhOnboarding } from "../zh/onboarding";

export const enOnboarding: typeof zhOnboarding = {
  flow: {
    stepOf: "Step {step} of {total}",
    done: "Done",
    skip: "Skip",
  },
  welcome: {
    title: "Two minutes to a ready workspace",
    subtitle: "Kova runs locally and works with your own model providers.",
    start: "Get started",
    later: "Later",
  },
  sections: {
    model: {
      title: "Model provider",
      desc: "Pick a provider, add an API key, choose a default model",
      missing: "Add one in Settings → Models to start chatting",
    },
    workspace: {
      title: "Workspace",
      desc: "The default directory where the agent reads and writes files",
      missing: "Switch anytime from the top bar",
    },
    personalization: {
      title: "Personalization",
      desc: "Set how you're addressed and pick a reply style",
      missing: "Fill in anytime in Settings → Personalization",
    },
    appMode: {
      title: "Work mode",
      desc: "Coding, work or design — changeable later",
      missing: "Defaults to Coding; change it in Settings → General",
    },
    appearance: {
      title: "Appearance",
      desc: "Dark or light, plus an accent color",
      missing: "Follows the system; change it in Settings → Appearance",
    },
  },
  done: {
    title: "You're all set",
    subtitle: "Everything can be changed later in Settings — it's yours now.",
    rowDone: "{title} · {summary}",
    rowMissing: "{title} not configured — {missing}",
    tipLead: "Try asking the composer to \"help me figure out how to run this project\", or press ",
    tipTrail: " for slash commands. Browse Plugins / Experts / Skills in the sidebar to see what else Kova can do.",
    start: "Start using Kova",
    back: "Go back and adjust",
  },
  model: {
    titleProvider: "Connect a model provider",
    titleModel: "Pick a model",
    descProvider:
      "Kova works through your own model provider. Pick one, paste an API key, and start chatting.",
    descKey: "Paste the provider's API key — it is stored only in your local credential store and never uploaded anywhere.",
    descModel: "This only sets the default model for new chats; switch anytime next to the composer.",
    noticeNotDesktop: "Model setup must be done in the Kova desktop app.",
    noticeNoProviders:
      "No model providers found. You can skip this and add one later in Settings → Models.",
    configured: "Configured",
    keyPlaceholder: "Paste the {provider} API key",
    save: "Save",
    noKeyHint:
      "No key yet? Skip for now — use another provider or add it later in Settings → Models.",
    noticeNoModels:
      "No models available right now (the catalog may still be loading, or nothing matches this provider). You can skip this.",
    importHint: "Already configured elsewhere? Bring those providers straight over.",
    import: "Import from other tools",
    pickFailed:
      "Couldn't select this model (it may lack credentials or isn't in the provider's catalog). Try another, or check Settings → Models.",
    hintEnter: "Press Enter to save",
    hintCustom: "Custom providers can be added in Settings → Models",
  },
  workspace: {
    title: "Choose a workspace",
    desc: "Point Kova at a default workspace: it reads and writes files, runs commands and inspects git inside this directory. Pick a project you're active on; skipping is fine and you can switch from the top bar anytime.",
    noticeNotDesktop:
      "Not a desktop environment — local folders can't be picked here. Switch anytime from the top bar in the app.",
    empty: "No directory selected (skipping is fine)",
    change: "Change",
    browse: "Browse",
  },
  personalization: {
    title: "Make it feel like your teammate",
    desc: "Set how you're addressed and the tone. Persona and custom instructions are long-form — better written later in Settings → Personalization.",
    yourName: "What should it call you",
    yourNameDesc: "How the AI addresses you in chat",
    aiName: "AI's name",
    aiNameDesc: "The name the AI uses for itself in chat",
    placeholder: "Leave empty to skip",
    styleLabel: "Reply style",
    summaryAiName: "AI goes by {name}",
    summaryYourName: "calls you {name}",
    summaryStyleSuffix: "{style} tone",
    summaryFallback: "Default name and tone",
  },
  appMode: {
    title: "What will you mainly use it for",
    desc: "Default mode: switching applies immediately to new chats and chats that haven't set their own mode; a single chat can override it from the top bar. Change it anytime in Settings → General.",
    noticeDegraded:
      "This sidecar version doesn't support work modes — switching only affects the UI, prompts won't follow.",
    code: "Coding",
    codeDesc: "For development: full tooling and detail, with Git always on",
    work: "Work",
    workDesc: "For everyday office work: delivery-oriented replies",
    design: "Design",
    designDesc: "For UI design: mockups and high-fidelity prototypes first",
    themePackError:
      "Failed to extract the built-in design themes: {error}. Retry manually in Settings → Agent → Design themes.",
    themeExtracting: "Extracting built-in design themes…",
    themeReady:
      "{count} built-in design themes are ready — pick one in Settings → Agent → Design themes, or per chat from the theme pill next to the composer.",
  },
  appearance: {
    title: "Pick a look you like",
    desc: "Just a starting point — light/dark, font size and chat width are all adjustable later in Settings → Appearance.",
    themeLabel: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
    accentLabel: "Accent color",
    accentDefault: "Default (follows theme)",
    summaryJoin: "{theme} · {accent}",
  },
};
