# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [SemVer](https://semver.org/). Starting with `v1.2.0`
the project is on a formal release track; earlier `v1.1.x-preview` iterations
are recorded in git tags and GitHub Releases.

Release process: [docs/versioning.md](docs/versioning.md).

## [Unreleased]

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
