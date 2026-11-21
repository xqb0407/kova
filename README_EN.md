# Kova

[简体中文](README.md) | English

A cross-platform desktop AI assistant: an Electron shell + a Next.js/assistant-ui
frontend + a local pi-agent sidecar (talking to the host over stdio NDJSON).
Model API keys are supplied by the user and stored locally; conversations and
data never leave your machine unless you connect them elsewhere.

**Keywords**: cross-platform desktop AI assistant · pi agent runtime
(pi-ai / pi-agent-core) · MCP (Model Context Protocol) · ACP · Electron +
Next.js + assistant-ui · local-first encrypted secret storage · DingTalk /
Feishu / WeCom bots · cloudflared tunnel · Expo mobile pairing

Three-layer architecture: **main process** (Electron/Node — command routing,
windows, terminal, filesystem, notifications, tray) · **renderer**
(Next.js + assistant-ui chat surface) · **sidecar** (pi-agent — the AI agent
runtime, compiled to a single bun binary).

**Features**

- **Conversations**: streaming chat, per-file checkpoint rollback, memory as
  items, custom agents, goal mode
- **Unified inbox**: cross-session approvals, questions, paused goals, and
  finished automation/sub-agent/background-task runs; approve/answer/resume/
  retry in place, with read/archive state shared across devices
- **Agent runtime**: embedded [pi](https://github.com/earendil-works/pi)
  sidecar — tool calls, approval boundaries, sub-agents, MCP (Model Context Protocol)
- **ACP**: the same sidecar binary can run as a standard ACP agent via `--acp`
  for editors such as Zed (stdio JSON-RPC; see [docs/acp.md](docs/acp.md))
- **Plugin system**: packaged distribution of skills / MCP / hooks / sub-agents /
  UI panels (directory & git marketplaces; official plugins live in a separate repo)
- **IM channels**: DingTalk / Feishu (Lark) / WeCom bot integration (webhook & stream)
- **Remote access**: Expo mobile app pairing, cloudflared tunnel supervision, SSH remote projects
- **Security**: encrypted local secret store, secret injection & redaction, MCP
  secret-injection boundary (see
  [docs/secrets-storage-hardening.md](docs/secrets-storage-hardening.md))

## Project layout

```
apps/desktop/            Frontend (Next.js; desktop-bridge/ implements the
                         desktop bridge — invoke/events/windows/dialogs/paths)
apps/electron/           Electron shell
  main/                  Main process: command routing & system capabilities
                         (fs/sqlite/pty/notifications/tray, ~8.8k lines)
  preload/               window.kovaHost + __KOVA_DESKTOP__ marker + drag-region bridge
apps/sidecar/pi-agent/   The AI agent runtime (compiled to a single bun binary)
apps/mobile/             Expo mobile app (pairs with the desktop instance)
packages/pi-protocol     Shared protocol types (frontend ⇄ sidecar)
packages/pi-runtime      Session runtime state & replay
packages/pi-sandbox      Sandbox execution boundary
docs/                    Architecture & feature docs (see below)
scripts/                 Build / package / release scripts
```

Plugins (the canvas / office / ui-design workbenches) do not live in this repo:
the bundled "builtin plugins" mechanism has been removed — install them from an
external plugin repo via Plugins → Add marketplace (directory or git).

## Getting started

Prerequisites: [bun](https://bun.sh) (deps & build), Node ≥ 20, macOS/Windows.

```bash
bun install                    # first run; if the Electron binary is missing, run apps/electron/node_modules/electron/install.js

# Dev mode (one command, hot reload on all three layers)
bun run dev                    # starts next dev(:3000) when needed and launches Electron

# Production build (three independent chains)
bun run build:sidecar          # sidecar → apps/electron/binaries/kova-worker
bun run build:renderer         # frontend static export → renderer-out
bun run build:main             # main/preload → apps/electron/dist
bun run build && bun run start # full build & run (no hot reload, like an installed build)
```

On first launch, enter your own model API key in Settings (OpenAI-compatible /
Anthropic formats both work).

### Data directories

| Channel | Directory | Notes |
|---|---|---|
| Release (packaged) | `~/Library/Application Support/com.kova.assistant` | macOS; Windows under %APPDATA% |
| dev (`--dev`) | `…/com.kova.assistant.dev` | Isolated from the release store |
| Override | `KOVA_DATA_DIR=/tmp/xxx` | For e2e / multi-instance debugging |

The app holds a single-instance lock per data directory: launching the same
channel twice just focuses the existing window.

## Tests & E2E

```bash
bun run verify:goal            # full gate: goal/desktop/protocol/runtime tests + 3-package typecheck
bun run test:desktop           # desktop unit tests
bun run test:protocol          # protocol unit tests
```

CDP-driven end-to-end smoke (`apps/electron/scripts/`):

```bash
./node_modules/.bin/electron . --remote-debugging-port=9222     # or dev mode 922x
node apps/electron/scripts/e2e-smoke.mjs 9222                   # renderer: bridge marker / invoke round-trip / DOM / console errors
node apps/electron/scripts/e2e-chat.mjs 9223                    # chat E2E (sandboxed data dir)
node apps/electron/scripts/e2e-git.mjs 9224 /tmp/repo           # git 13 commands (checkpoint diff/restore)
node apps/electron/scripts/e2e-remote.mjs 9226 18787            # remote gateway (pairing / id round-trip / rejected frames)
```

## Packaging & release

```bash
./scripts/build-release.sh                 # preflight → sidecar → frontend → main → dmg + SHA256SUMS
node scripts/release.mjs <version> --dry-run # sync version across root/desktop/electron
node scripts/release.mjs <version>           # commit + tag + push (CI creates a Draft Release)
```

CI: `.github/workflows/release.yml` (tag-triggered, macos-14 builds the dmg).
macOS uses ad-hoc deep signing (unsigned notarization; first launch needs one
GUI confirmation).

## Documentation

| Topic | Doc |
|---|---|
| Secrets storage hardening | [docs/secrets-storage-hardening.md](docs/secrets-storage-hardening.md) |
| MCP secret injection | [docs/mcp-secret-injection.md](docs/mcp-secret-injection.md) |
| Remote access & pairing | [docs/remote-access.md](docs/remote-access.md) |
| IM channel integration | [docs/im-channels.md](docs/im-channels.md) |
| Plugin development | [docs/plugin-development.md](docs/plugin-development.md) |
| Sandbox boundary | [docs/sandbox.md](docs/sandbox.md) |
| Goal mode | [docs/goal-mode-v2.md](docs/goal-mode-v2.md) |
| Turn assembly | [docs/turn-assembly.md](docs/turn-assembly.md) |
| Unified inbox | [docs/agent-inbox.md](docs/agent-inbox.md) |
| Dynamic model discovery (autoDiscover) | [docs/dynamic-model-discovery.md](docs/dynamic-model-discovery.md) |
| Event triggers + Headless | [docs/event-triggers-headless.md](docs/event-triggers-headless.md) |
| Git worktrees (managed worktrees) | [docs/git-worktrees.md](docs/git-worktrees.md) |
| Plugin configuration | [docs/plugin-config.md](docs/plugin-config.md) |
| Project virtual dirs (multi-repo merge) | [docs/project-virtual-dirs.md](docs/project-virtual-dirs.md) |
| Remote projects (SSH execution) | [docs/remote-ssh-projects.md](docs/remote-ssh-projects.md) |
| Vision assist (see_image) | [docs/vision-tool.md](docs/vision-tool.md) |
| Subagent conversation | [docs/agents/subagent-conversation.md](docs/agents/subagent-conversation.md) |
| Shell write policy | [docs/agents/shell-write-policy.md](docs/agents/shell-write-policy.md) |
| Bot team layer (multi-agent teams) | [docs/agents/bot-team.md](docs/agents/bot-team.md) |
| Custom agent memory | [docs/agents/custom-agent-memory.md](docs/agents/custom-agent-memory.md) |

**Dev-facing design & review notes**: [Checkpoint plan](docs/agents/checkpoint-plan.md) · [Subagent conversation review](docs/agents/subagent-conversation-review.md) · [Harness upgrade plan](docs/harness-alignment-plan.md) · [MCP/Connector/ACP roadmap](docs/mcp-connectors-acp-plan.md) · [MCP gateway & skill loading optimization](docs/mcp-skill-optimization.md) · [Project entity refactor review](docs/project-model-review.md) · [Question & approval boundary](docs/question-approval-boundary.md) · [Workflow engine gaps](docs/workflow-engine-gap.md) · [E2E acceptance: library loop](docs/e2e/library-loop/ACCEPTANCE.md) · [E2E report: tool policy](docs/e2e/tool-policy/REPORT.md) · [E2E report: goal mode](docs/e2e/goal-mode-v2/REPORT.md)

## Acknowledgements

- [pi](https://github.com/earendil-works/pi) (MIT) — embedded agent runtime (pi-agent sidecar / pi-ai / pi-agent-core)
- [assistant-ui](https://github.com/assistant-ui/assistant-ui) (MIT) — chat UI component library
- [Univer](https://github.com/dream-num/univer) (Apache-2.0) — spreadsheet/doc engine in the official office plugin
- [Leafer](https://github.com/leaferjs/Leafer) (MIT) — canvas plugin rendering engine
- Shell: [Electron](https://www.electronjs.org/) (MIT)
- Dev notes: `PLAN.md` (design decisions) · `PORTING-NOTES.md` (implementation notes)

## License

Released under [Apache-2.0](./LICENSE); third-party dependencies and their
licenses are listed in [NOTICE](./NOTICE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Disclaimer

- This software is provided "as is", without warranty of any kind, express or
  implied — see Sections 7 and 8 of the [LICENSE](./LICENSE) (disclaimer of
  warranty and limitation of liability).
- This project is a client for large-model APIs: **no guarantee is made about
  the accuracy or fitness of AI-generated content**. Verify outputs before
  relying on them; any consequences of their use are on the user.
- Model services and API keys are configured by the user; using them is subject
  to the respective provider's terms and applicable local laws. This project is
  not affiliated with or endorsed by any model provider.
- Remote access, IM integration and SSH features expose parts of your machine
  to external channels — evaluate and configure the security boundary yourself.
  Treat pairing codes, tokens and host addresses as credentials.
- **AI-executed actions**: approval boundaries for tool calls, shell commands
  and file modifications are configured by the user. You are responsible for
  the consequences of executing AI-generated content under auto-approve or
  permissive policies — review before you run.
- **Third-party plugins**: marketplace and third-party plugin content is
  maintained by its respective authors and is not reviewed or endorsed by this
  project. Installing or running third-party plugins (including their tool
  calls, hooks and UI panels) is at your own risk.
- **Access acceleration (third-party public mirror)**: the GitHub acceleration
  prefix is **empty by default = direct connection to the official source** —
  no traffic passes through any third-party mirror unless you explicitly opt
  in: pick a ghproxy-family mirror or add custom rules in "Settings → System →
  Access boost", or set the `PI_GITHUB_MIRROR` environment variable before
  launch to provide a distribution default (set it empty to disable rewriting).
  The mirror only proxies **credential-free read traffic** (raw files, release
  archives, source downloads and git clone/fetch; requests carrying
  Authorization/token and git push never touch the mirror — boundary see
  `apps/sidecar/pi-agent/src/tools/url-mirror.ts`). Availability and returned
  content of third-party mirrors are the responsibility of their operators —
  evaluate before use.
- **Third-party dependencies**: the open-source libraries used by this project
  are owned and licensed by their respective authors — see [NOTICE](./NOTICE)
  and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the complete list and
  licenses. These dependencies (including source-vendored components and
  components carrying local patches) are provided "as is" under their original
  licenses; the authors make no additional warranty regarding their
  functionality, security or compliance. Components under LGPL / MPL / EPL /
  OFL are used under their respective license terms. If you redistribute this
  project or a modified version, you must retain [LICENSE](./LICENSE), NOTICE
  and the applicable third-party notices, and fulfill the obligations of each
  license yourself. The inventory is generated from the installed tree and may
  vary by version and platform; the notices shipped with the corresponding
  release prevail.
- **Local data**: API keys, sessions and plugin data are stored locally. Back
  them up yourself; the authors are not liable for data loss caused by device
  failure, accidental deletion, upgrades or reinstalls.
- The authors are not liable for any direct or indirect loss arising from
  downloading, installing or using this software.
