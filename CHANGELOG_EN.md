# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [SemVer](https://semver.org/). Starting with `v1.2.0`
the project is on a formal release track; earlier `v1.1.x-preview` iterations
are recorded in git tags and GitHub Releases.

Release process: [docs/versioning.md](docs/versioning.md).

## [Unreleased]

### Added

- Code views now support inline comments: hover a line and click "+" in the file
  source view or Git diff, comment on one or more selected lines, and the comment
  is inserted into the composer as a `:code` reference chip plus text; on send it
  expands to a file line reference

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
