# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [SemVer](https://semver.org/). Starting with `v1.2.0`
the project is on a formal release track; earlier `v1.1.x-preview` iterations
are recorded in git tags and GitHub Releases.

Release process: [docs/versioning.md](docs/versioning.md).

## [Unreleased]

### Added

- UHP (Unified Harness Protocol) integration in both directions: an in-process
  UHP server exposes pi-agent as a `2026-10-19` Core + Extended harness
  (discovery, SSE tasks, session continuation/cancellation, files/artifacts,
  session listing); Settings → Agent → UHP can start/stop it, rotate the API
  key, and configure the workspace/approval level
- Task sub-agents gain `backend: uhp`: delegate to an external HarnessRouter or
  compatible UHP server, map SSE events into the sub-agent activity panel, and
  support Stop cancellation and `previous_response_id` continuation
- `packages/uhp-protocol`, official conformance wrapper scripts, and
  [docs/uhp.md](docs/uhp.md) / [docs/uhp-conformance.md](docs/uhp-conformance.md) /
  [docs/uhp-roadmap.md](docs/uhp-roadmap.md)
- Codex plugin compatibility: support `.codex-plugin` / root Agent Plugins
  `plugin.json` / `.cursor-plugin` manifests; multi-path arrays for skills,
  hooks, and commands; inline `mcpServers` and bare server maps; `cwd`,
  `env_vars`, `http_headers`, `env_http_headers`, `bearer_token_env_var`,
  timeouts, and tool filters
- Codex plugin MCP servers default to the plugin root as cwd and support
  `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`; `node` / `npx` fall back to the bundled
  runtime when missing from PATH; plugin tool catalogs are warmed after install
  or enable, and the `mcp` gateway accepts both `server.tool` and `server__tool`
- Codex personal marketplace sources resolve against the real marketplace root
  (`./plugins/x` under `$HOME/.agents/plugins` points to `$HOME/plugins/x`);
  marketplace entry names may differ from source directory names
- Marketplace sources support Codex `git` / `git-subdir` / `url`: shallow clone
  by `ref`/`sha` and materialize the repository subdirectory, with a shared
  install/preview cache that refreshes on update; `npm` sources and
  `policy.installation=NOT_AVAILABLE` produce explicit diagnostics/hiding
- Plugin skills are exposed as `plugin:skill` per Codex semantics: same-named
  skills from different plugins coexist, `use_skill` accepts the full name,
  falls back to a unique bare name, and reports ambiguity; the system prompt and
  settings page show the plugin-prefixed name. The skill catalog budget is now
  16KB and plugin descriptions allow 400 characters, so long plugin skills are
  less likely to be dropped
- Codex personal marketplace auto-discovery: when
  `$HOME/.agents/plugins/marketplace.json` exists, the marketplace page shows a
  read-only "personal" market without manual registration
- Plugin details now offer an "Install dependencies" action when `package.json`
  exists without `node_modules`: explicit npm ci/install with
  `--omit=dev --ignore-scripts`, falling back to the bundled runtime when npm is
  unavailable
- Codex hooks now support `commandWindows`, `onFailure`, `async`,
  `statusMessage`, plugin-root cwd, `PLUGIN_DATA` injection, and `turn_id` in
  the payload, with new `SessionEnd` / `PostCompact` / `Interrupt` /
  `SubagentStart` trigger points; plugin data directories are writable inside
  the sandbox while plugin install roots stay read-only
- Plugin skills read Codex `agents/openai.yaml`: `policy.allow_implicit_invocation:false`
  keeps the skill out of the model catalog, and `dependencies.tools` is surfaced
  as a diagnostic
- MCP Apps: `tool._meta.ui` (including the deprecated flat `ui/resourceUri`) is
  preserved, tools with `visibility:["app"]` stay out of the model catalog and
  search, and MCP tool results can open their `ui://` interface in a sandboxed
  iframe with initialize, tool-input/result, tools/call, resources/read,
  open-link, message, and size-changed bridging
- Codex hooks now include `PreModelRequest` / `PostModelRequest` and the common
  payload fields (`model`, `permission_mode`, `transcript_path`,
  `attempt_number`, `request_id`, `turn_id`, `status`, `token_usage`)
- Code views now support inline comments: hover a line and click "+" in the file
  source view or Git diff, comment on one or more selected lines in an inline
  editor below the code; submitted comments stay as a card under the code (delete
  also removes the composer chip), the chip opens a source + comment dialog, and
  sending expands it to a file line reference plus the comment

### Fixed

- Codex plugins installed from a GitHub zip (`<name>-main`) or an official
  symlinked plugin directory no longer fail because of a directory-name mismatch
  or `cpSync` `ENOTDIR` on a symlink
- Codex plugin `.mcp.json` relative `cwd`/`args`, `http_headers`, `env_vars`,
  `enabled:false`, and timeout settings are no longer silently dropped; plugin
  details now show MCP parse diagnostics
- Plugins shipping both `.codex-plugin` and `.claude-plugin` manifests now probe
  Codex first; ecosystem manifests missing `name` fall back to the directory name
- Codex MCP fields (plugin-root default cwd, `env_vars`, `http_headers`, etc.)
  only apply to Codex / Agent Plugins manifests, so Claude/Kova plugins keep
  their previous MCP behavior
- Plugins whose `package.json` has no runtime dependencies are no longer shown
  as missing dependencies, and dependency-install failure/timeout output is
  redacted consistently
- External-source notifications now locate items with the sidecar
  `external:<provider>:<id>` key, so clicking a notification selects the matching
  inbox item again
- Stop is no longer held up by a provider summary request during pre-turn
  compaction: summarization now races the abort signal and no new agent turn
  starts after stopping; the already-sent user message is persisted immediately
  so it survives a reload, while the optimistic bubble waits for the snapshot or
  echo before being cleaned up
- System notifications now switch sessions only when the user clicks the
  notification card; refocusing the window no longer jumps to another session
  that is waiting for approval or an answer

## [1.2.5] - 2026-11-24

### Added

- Network proxy settings page: follow system / direct / custom proxy, custom
  bypass list and connectivity test; restart immediately after saving
- New lifecycle hook events `Notification` / `SubagentStop` / `PreCompact` with
  matchers; the PreToolUse approval gate now also applies to subagents, and
  `approve` no longer bypasses structural validation
- Image input capability is now tri-state (supported / explicitly unsupported /
  undeclared): custom endpoints with undeclared capability are no longer
  pre-stripped as text-only and are sent as-is, with endpoint rejection and the
  400/422 repair path as fallback
- The model picker now offers an input-capability fix entry, distinguishing
  "text-only" from "input capability undeclared"

### Changed

- Settings descriptions were condensed by roughly 46%; Projects / Memory /
  Backup channel controls now use the same segmented control, and Inbox tabs use
  the shared underline style
- sidecar and automation now follow the system proxy at startup; fixed long
  streams to overseas providers being reset because Bun ignores the system
  proxy, with NO_PROXY defaulting to loopback and RFC1918 ranges
- Hooks run with the session cwd, timeouts kill the whole process group, matching
  hooks run in parallel, Claude `hookSpecificOutput` / `continue` /
  `systemMessage` are supported, `set_hooks` failures surface errors, multiple
  windows sync `hooks_changed`, and hooks are disabled in remote mode
- Image downgrade placeholders are now neutral and include attachment identity,
  numbered per message; the OpenAI-compatible / Responses / Google / Mistral
  adapters all decide whether to carry images from the same tri-state capability
- The 400/422 rejection retry and local downgrade now share one explanation,
  with the same sticky-memory behavior

### Fixed

- Re-entering Settings could land on the previous jump target (such as the
  changelog) instead of General; jumps are now consumed once and no longer leak
- Network proxy: IPv6 host tests failed, NO_PROXY did not merge the bypass list,
  backup restore could keep the old proxy, and non-manual mode could persist
  invalid or credentialed proxy addresses
- Hook background timeouts did not take effect and only killed the direct child;
  the PreToolUse structural gate could be bypassed by `approve`; systemMessage
  toasts could flood the UI
- Custom endpoints with undeclared input capability were treated as text-only
  and their images silently stripped; the composer image gate also disabled the
  drag-and-drop attachment entry

## [1.2.4] - 2026-11-23

### Added

- AI personalization tools `personalization_get` / `personalization_update`: read and
  change global names, reply style, custom styles, the persona (soul.md) and custom
  instructions (rules.md) from a conversation; `update` requires approval each time and
  immediately re-renders the system prompt of every active session
- Built-in services accept manually entered model IDs outside the catalog: add with
  Enter, paste newline/comma/semicolon separated lists or JSON arrays, with invalid and
  duplicate checks; saved models inherit the service's auth and streaming
  implementation, preferring an OpenAI-compatible endpoint on multi-API services

### Changed

- The personalization settings page saves by field: only fields edited in this session
  are submitted, while unchanged soul.md / rules.md keep their on-disk content instead
  of being overwritten by a stale page snapshot
- Personalization is re-fetched when the settings page mounts and when the window
  regains focus, so persona/rules written by the AI or an external editor show up
- Title summarization sends the session-affinity header required by OpenCode and
  similar gateways, fixing `MissingSessionID`; OpenCode's `x-opencode-log-id` /
  `cf-ray` response headers are logged to help diagnose dropped streams
- The browser drag tool description now states that both endpoints must be visible in
  the current viewport (ref-based drags no longer scroll)

### Fixed

- Whole-payload saves from the settings/onboarding pages could overwrite rules the AI
  had just written; persistence failures no longer report success, and absent fields
  are no longer treated as clears
- Clearing a built-in service's model filter made manually added out-of-catalog models
  reappear in the full list; the last-used model could point at a removed entry
- Browser dialogs: `evaluate`, clicks and typing no longer wait 10 seconds when an
  alert/confirm opens; the dialog handler now bypasses the command queue, timeout
  detection uses an error type, and timers are cleared after normal returns
- Browser screenshots: out-of-viewport clips enable `captureBeyondViewport` (they
  previously came back blank); `maxDim` and the 16-megapixel budget are computed in
  physical pixels (excluding page zoom), so Retina no longer produces double-size
  edges; the `capturePage` fallback also honors `maxDim`
- Browser input: right/middle-click `buttons` bitmasks are correct (they used to
  include the left button); ref-based drags share one scroll state so resolving the
  target no longer moves the source; Shift+character types correctly and Cmd/Ctrl/Alt
  shortcuts no longer insert an extra character
- Share screenshots apply the device pixel ratio on Retina, avoiding 4× pixels,
  texture budget overruns, and false "content too long" errors

## [1.2.3] - 2026-11-22

### Added

- In-app release notes and upgrade dialog: an update timeline under Settings → About,
  with a post-upgrade summary; first installs and remote/web clients are not interrupted
- Manual stop and idle auto-reclaim for background tasks, with a Stop button on running
  rows in the quick view
- A self-diagnostic snapshot when PTY spawn fails, to trace rare startup failures on
  long-running instances
- "Fetch models" improvements for custom providers: pagination (up to 20 pages), a union
  across candidate endpoints, and support for `data` / `models` / `items` / `result` /
  `list` envelopes plus more ID aliases
- Batch paste into the model input via newlines, commas, semicolons, tabs, full-width
  separators, or JSON arrays

### Changed

- The changelog upgrade dialog now uses a flat, card-less list; the version and date
  are folded into the subtitle
- The Cmd+Q hold-to-confirm duration is shortened to 1.5 seconds
- Unified endpoint validation and normalization for model configuration: pasted
  `/v1/models` or `/chat/completions` URLs converge to the base URL, and save, fetch and
  test share one gate
- "Fetch models" now logs diagnostics (raw/parsed counts, pages, truncation; URL queries
  are redacted) and warns in the dialog when the 20-page cap is reached
- Auto-discovery still skips image/embedding models; the form now says so and the skipped
  IDs are logged

### Fixed

- A large skill bundle could exhaust the directory-signature budget, preventing later
  installed skills from hot-reloading
- The model input accepted invalid IDs with spaces/brackets and gave no duplicate
  feedback; an uncommitted draft could be silently dropped on save
- Fetch/save could proceed with an invalid URL, full endpoints could produce
  `/models/models`, and the first candidate endpoint could shadow a more complete list
- New chats no longer restore a deleted workspace after project deletion or the pill's ×
- Missing `key` warnings in the session context menu
- Missing execute permission on the packaged spawn-helper
- Background-task stop could hang or hold the management queue
- The inbox "Mark all as read" sweep could hang on failed reports left in the
  needs-attention state; failed reports are now marked read and archived, while
  unresolved approvals, questions and goals are only marked read
- Main-process builds failed because `logging` did not export `logErr`; switched to
  the existing `logError`
- Late frames written after stdout ended could trigger an uncaught `write after end`;
  task-session `project_dirs` lookups also spammed error logs

### Removed

- `apps/mobile` moved to its own repository (the desktop remote gateway and pairing are
  unaffected)

## [1.2.2] - 2026-11-21

### Added

- Custom search services now support **whole-JSON configuration** and
  **one-click cURL import** (with schema and parser unit tests)
- `resultsPath` for custom APIs now unwraps **stringified JSON arrays**
  (double decoding) — compatible with aggregator gateways such as deepcode
  that return `{"result":"[{…}]"}` (verified in practice)

### Changed

- The Key row now appears on demand and hints where the key is injected:
  credential input only shows when the template references `{{apiKey}}`,
  and the hint explains whether the key goes into the URL, headers, or body
- The request-body template and Headers input now have a fixed width;
  full-width punctuation is detected on validation failure with a dedicated message

### Fixed

- The parallel tool list in run_code's description is now generated from the
  tools actually available — it no longer claims WebSearch exists after it is disabled

## [1.2.1] - 2026-11-21

### Added

- Five Chinese-style themes (Blue-and-white porcelain / Ink wash / Lacquer with
  gold / Celadon crackle / Mòwén bamboo) and built-in wallpapers
- Theme import upgrades: JSON editor, `$schema` validation, one-click refill of
  the current theme
- **macOS Intel (x64) installer** — previously Apple Silicon only; the minimum
  system version is now explicitly macOS 13 Ventura (determined by Electron 44),
  distributed for both arm64 and x64

### Fixed

- Handles / inspiration panel / inbox actions now follow theme tokens

## [1.2.0] - 2026-11-21

First open-source stable release.

### Added

- Open-source launch: Apache-2.0 license, NOTICE and third-party dependency list
  (auto-generated, 1830 packages)
- Bilingual README / README_EN interface previews (10 real screenshots) and
  community entry points (Feishu group)
- CI gates: PR / push automatically runs typecheck and the full sidecar test suite
  (2772 cases)

### Changed

- Default web search now uses the official API that requires your own key; the
  built-in third-party proxy endpoint was removed
- GitHub access acceleration now defaults to the official source; acceleration is
  an explicit user choice (`PI_GITHUB_MIRROR` can set the distribution default)
- Repository renamed: `kova-electron` → `kova` (development and release repositories merged)

### Fixed

- Git history rewritten to remove a company email committer identity
- NOTICE now includes the MIT upstream attribution for the design-md theme directory
- README acknowledgements remove Univer / Leafer, which have moved to separate repositories
