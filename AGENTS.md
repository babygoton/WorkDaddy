# WorkDaddy Agent Guide

## Project Overview

WorkDaddy is a local enhancement layer for the WorkBuddy desktop app. It connects to the running Electron renderer through Chrome DevTools Protocol (CDP), injects a small control panel, and runs a local HTTP daemon for account backups, account switching, themes, sessions, and related utilities.

The repository is deliberately lightweight:

- Runtime code is plain Node.js and browser JavaScript. There is no `package.json` build pipeline.
- `scripts/daemon.js` is the main local service and CDP coordinator.
- `scripts/inject.js` is the injected UI and its inline CSS.
- `scripts/theme-patches.js` contains hot-loaded CSS patches for WorkBuddy's own DOM.
- `scripts/lib.js` owns account file parsing, backup, switching, and data-directory compatibility.
- `scripts/win-launcher.js`, `scripts/watchdog.js`, and the PowerShell/cmd scripts are the Windows startup/update path.
- `WorkDaddy.app` is a packaged macOS artifact. Treat `scripts/` as the source of truth; update the app bundle only when the task explicitly asks for a packaged artifact or release output.

## Non-Negotiable Principles

1. Diagnose the reported behavior against the current code before changing it. A historical report is evidence, not proof that the current version is broken.
2. Keep changes narrow. Do not refactor unrelated code, rename public API routes, or change the account-file format without a concrete compatibility reason.
3. Preserve WorkBuddy's installation, signature, and official app bundle. WorkDaddy should operate through CDP and local files rather than modifying `app.asar`.
4. Never log, upload, or paste access tokens, cookies, account backup contents, or private keys. Sentry breadcrumbs and errors must remain redacted; composer input, full logs, database contents, and API keys are also out of scope.
5. Account switching is intentionally smooth: replace the selected JSON backup and refresh the running renderer through CDP. Do not call `quitWorkBuddy()` or `relaunchWorkBuddy()` from the normal `/api/switch` path.
6. When changing daemon behavior, increment `DAEMON_VERSION` and `DAEMON_BUILD_ID` in `scripts/daemon.js`. Launchers use these values to replace stale daemon processes that still have old code in memory.
7. Diagnostic telemetry defaults to enabled. The About-page 「发送错误诊断」 switch controls both remote Sentry events and local redacted renderer diagnostics; `WORKDADDY_TELEMETRY=0/1` is an explicit startup override. Do not restore the removed `WORKDADDY_DIAGNOSTIC_LOGS` or composer-capture interfaces.
8. The only telemetry override that may bypass the About-page switch is a user-initiated repair-agent run that has read `安装失败自主解决提示词.txt` and uses `--force-send --require-sent`. That report must remain redacted, and only `sent=true` is success; `queued=true` or a non-zero exit must never be presented as sent.
9. WorkDaddy and WorkBuddy lifecycle control must run at standard user privilege. If WorkBuddy is elevated, launcher operations must fail closed with manual guidance; never reintroduce UAC helpers, broad image-name kills, or cross-integrity process termination.

## UI Direction (Highest Priority)

The injected panel is a compact WorkBuddy-native tool surface, not a marketing page. Any UI change must look like it belongs beside the current WorkBuddy interface and the existing WorkDaddy panel.

### Visual language

- Preserve the current compact, information-dense layout: a bottom-right floating robot button opens a roughly `460px` panel with a capped viewport height, tabs, scrollable content, and small repeated account/session rows.
- Reuse the existing CSS variables first: `--wb-bg-*`, `--wb-border-*`, `--wb-color-text-*`, `--wb-icon-*`, `--wb-button-*`, and `--wb-accent-*`. Add a new literal color only when an existing token cannot express the state.
- Keep the established material language: translucent surfaces, restrained borders, subtle shadows, and backdrop blur where the surrounding theme already uses it. Do not introduce a separate visual system, loud gradients, neon decoration, oversized cards, or a new font family.
- Keep the existing density and scale: panel headings around 13–16px, body text around 11–13px, compact controls, and stable icon-button dimensions. Match nearby controls instead of inventing a larger component.
- Keep the existing radius hierarchy: panel and large surfaces may be about 14–18px; cards and grouped controls about 8–12px; compact icon buttons about 6–9px; status badges remain pill-shaped.

### Theme behavior

- Every new surface and text color must work in both the default/light theme and the WorkDaddy dark theme.
- The dark theme is represented by `html.cb-dark` / `html[data-theme="dark"]` and the relevant `body[data-vscode-theme-name]` values. Test both selectors when writing CSS overrides.
- Never rely on a light-only hardcoded foreground/background pair. Check contrast for normal, hover, selected, disabled, warning, error, and success states.
- Theme-specific WorkBuddy DOM fixes belong in `scripts/theme-patches.js`; WorkDaddy component styles belong in `scripts/inject.js`.
- A page reload or reinjection must restore the selected theme. Do not create a style element or observer that survives reinjection without an idempotent cleanup path.

### Layout and interaction

- Use stable dimensions for panels, rows, buttons, lists, and modal content. Hover and selected states must not change layout or cause visible jitter.
- Keep scroll ownership clear: the panel body and session list may scroll, but a modal must be centered relative to the panel/viewport rather than the scrolled account list.
- Modals use the existing centered fixed mask pattern (`.wbs-modal-mask`, `.wbs-modal`, `.wbs-modal-actions`). The mask must block pointer events from reaching WorkBuddy while open; do not allow click-through.
- Use familiar icons for icon-only actions and give unfamiliar icons a `title` tooltip. Do not replace a known symbol with a rounded text button when an icon is sufficient.
- Use radio controls for mutually exclusive modes, segmented controls for view modes, switches for binary settings, and normal buttons for explicit commands.
- Avoid hover animations that resize text, borders, or the containing row. Prefer color, opacity, or shadow transitions.
- Keep long Chinese copy inside its parent. Let descriptions wrap naturally; do not use fixed heights that clip text on narrow windows.
- Preserve keyboard and pointer behavior: visible focus, label inputs, dismissible dialogs, and no event propagation into WorkBuddy when a WorkDaddy overlay is active.

### UI implementation boundaries

- `scripts/inject.js` is executed inside WorkBuddy's renderer. Avoid assumptions about React ownership and do not mutate official component state unless the existing adapter already does so.
- Make injected DOM idempotent. On reinjection, remove or reuse prior WorkDaddy roots/styles/observers instead of stacking duplicate panels, timers, listeners, or MutationObservers.
- Prefer event delegation and narrow observers. Broad mutation scans can freeze or crash the WorkBuddy renderer during conversation changes.
- Escape user/account/session text before assigning it to `innerHTML`; use text nodes or the existing escaping helper where possible.
- Do not use private WorkBuddy RPCs or reorder operations in a session-switching path unless there is a regression test and a documented reason. These paths have historically caused renderer crashes.

## Client Type Judgment (WorkDaddy vs WorkDaddy AI)

The injected panel must distinguish the client type before any UI or functional branching. The single source of truth is the daemon profile id injected as `__WBS_PROFILE__` → `PROFILE_ID` in `scripts/inject.js`:

- `PROFILE_ID === 'workbuddy-ai'` → **WorkDaddy AI** (WorkBuddy AI / international client).
- Any other profile (`workbuddy-cn`, codebuddy-*) → **WorkDaddy** (WorkBuddy default client).

Use the dedicated flag `WBS_PROFILE_IS_AI` (defined next to `WBS_BRAND`) for these branches; do not reinvent per-profile checks. `WBS_BRAND` mirrors the same decision for visible branding ("WorkDaddy AI" vs "WorkDaddy"). Per-profile feature gates live in `scripts/profiles.js` `capabilities` (accounts/models/theme/stashPrompt/...), injected as `__WBS_CAPS__` → `CAPS`.

### Input-box plugin buttons (stash prompt + quick phrase)

The two composer-adjacent plugin buttons are `stashBtn`（暂存提示词）and `exploreBtn`（快捷短语/探索）. Their placement is decided by client type (see `insertStash` / `findAiToolbar` in `scripts/inject.js`):

- **WorkDaddy (default client)**: keep the existing placement untouched — `voice-mic-wrap` present → fixed positioning anchored to the action row; otherwise the legacy `_inputBottom_` toolbar inline or fixed fallback.
- **WorkDaddy AI**: insert both buttons inline into `div.cr-input-toolbar__right` (the parent of the input box's bottom-right button group, new teams layout, e.g. `...div.conversation-input > div.cr-theme > div.cr-theme.cr-input-box > div.cr-input-box__main > div.cr-input-container-wrapper > div.cr-input-container > div.cr-input-toolbar > div.cr-input-toolbar__right`) — at the leftmost position, i.e. to the left of the official buttons (上下文用量 / 增强 / 模型 / 发送), using the `wbs-stash-inline-inline` class so the buttons participate in the flex row. If the new container is absent, fall back to the legacy AI toolbar selectors.

Rule of thumb: when only the AI client's DOM changes, gate the new selector on `WBS_PROFILE_IS_AI` so the default client's behavior is never altered by an AI-specific layout fix.

### Queue adapter & stash behavior (暂存提示词)

The stash button's actual "stash into WorkBuddy's message queue" capability depends on the official queue adapter, and the two clients expose it differently (see `findWbsAdapter` / `findAiSessionsAdapter` in `scripts/inject.js`):

- **WorkDaddy (default client)**: the queue methods (`enqueueConversationMessageQueueItem`, `pauseConversationMessageQueue`, ...) hang directly on a React fiber props adapter object; discovered by walking up from legacy roots (`.voice-mic-wrap`, `_cbChat_`, `.chat-container`).
- **WorkDaddy AI** (new teams layout): the queue API lives on the official adapter itself — the methods sit on its **prototype chain** (`typeof adapter.enqueueConversationMessageQueueItem === 'function'` matches even though `Object.keys` hides them), and those wrappers internally call `_notifyQueueUpdate` (refreshes the official panel + returns a real snapshot). The legacy discovery roots no longer exist, and `adapter.sessionsResource` must NOT be used as the target — it is a low-level passthrough that returns `null` snapshots and never refreshes the panel. `findWbsAdapter` must DFS the render tree for `props.adapter` whose prototype exposes the queue methods, then builds a shim exposing the same method names the rest of the module expects, with `currentActiveSessionId` falling back to the visible conversation DOM (`.cr-document[data-root-id]`, active `.conversation-item[data-conversation-id]`). Without this shim the AI client silently falls into the local `/api/stash` fallback and nothing appears in the queue panel.
- **Cache invalidation trap**: the top-of-file cleanup must `delete window.__wbsAdapter`. `findWbsAdapter`'s cache check passes as long as the methods exist on the cached object, so a stale shim wrapping the wrong adapter is silently reused after reinjection — code fixes appear to do nothing until the cache is cleared (this exact bug made the AI stash look "dead" for a full debugging round on 2026-08-26).

The queue item's 暂存提示词 tag is rendered by `syncQueueTags` (in `scripts/inject.js`): it inserts a `span.wbs-queue-tag` as the **first child of `.cb-message-queue-item-actions`** — i.e. the leftmost sibling among that row's icon buttons, exactly the placement the AI new layout expects (`...div.conversation-input-area > div.conversation-queue-panel > div.cb-message-queue.cb-expand > div.cb-message-queue-content > div.cb-message-queue-item > div.cb-message-queue-item-actions`). This tag code is client-agnostic; only the adapter discovery differs per client.

## Backend and Platform Rules

- The daemon binds to loopback only. Keep local API routes on `127.0.0.1`; validate request bodies and file paths before acting.
- Account backups live under the WorkDaddy data directory. Preserve existing permissions and never delete user account data as part of a UI or runtime refactor.
- Normal account switching must be JSON replacement plus CDP reload. Fake logout is the exceptional flow that may exit/relaunch WorkBuddy to reach the login page.
- macOS uses launchd and the WorkDaddy app launcher; Windows uses the watchdog, `win-launcher.js`, `launcher.cmd`, and PowerShell scripts. Keep platform-specific process handling in the platform-specific files.
- Windows file replacement must account for locks held by running `launcher.cmd`/`cmd.exe`. Do not kill broad process names such as every `Electron` process; match the intended executable/path narrowly.
- Windows launcher injection must tolerate a renderer that is slower than the CDP port: retry transient `/api/inject` failures, reuse the daemon's in-flight manual injection, and report background processing with exit code `0` instead of a false launcher error. Real authorization or route errors must still fail.
- If a launcher or daemon update changes code loaded into a long-running process, use a version/build bump so the launcher cannot reuse stale in-memory code.

## Release Version Consistency

- A release version must be identical in the package filename, macOS `Info.plist` (`CFBundleShortVersionString`/`CFBundleVersion`), and the packaged `scripts/daemon.js` `DAEMON_VERSION`. A package named `1.0.10` that runs daemon code reporting `1.0.6` is invalid.
- Update availability has one source of truth: compare the latest GitHub or cached release version with the running `DAEMON_VERSION` every time. Never persist or trust a cached `hasUpdate` decision across daemon versions, and clear any existing update card/red dot when no newer version exists.
- Build scripts must always rewrite the staged daemon version from the release `VERSION`; never rely on the version embedded in the reusable `WorkDaddy.app` shell or on a conditional test-only override.
- Windows releases are `Setup.exe` only. The `*-win64.zip` created by the installer pipeline is temporary staging and must be deleted before artifact upload or GitHub Release publication; ZIP remains supported only as an updater fallback for historical releases.
- Before publishing or handing off a package, inspect the actual DMG/Setup.exe payload and record the daemon version, app metadata version, profile branding, and required update scripts. Do not infer package correctness from the filename alone.
- The repair prompt `安装失败自主解决提示词.txt` may remain in the source tree for the user-initiated repair-agent flow, but it must not be copied into Windows Setup.exe payloads or macOS release staging directories. Release verification must confirm that the prompt is absent from the deliverable.
- The updater must reject an artifact whose internal daemon version does not match the GitHub release target, and must leave a local diagnostic trail showing the selected asset, expected version, internal version, and installation attempt ID.

## Windows Packaging Runbook

Use this exact flow for a Windows release. The two client packages are built from the same source tree, but each is staged with its own profile, installation directory, daemon port, desktop shortcut, and WorkBuddy executable name.

1. Start from the requested source commit/branch and confirm the working tree. Do not silently change the release version in `scripts/daemon.js` when producing a fixed-version package; pass the requested version explicitly to the release script. Before building, remove only the existing `release/windows/*-Setup-*.exe` files if the request is to replace all installer artifacts; keep unrelated files outside that directory untouched.

2. From the repository root, run the Windows release builder with Git Bash, Inno Setup 6, and Python available. Prefer explicit tool paths on the build host so the result is reproducible and does not depend on `PATH`:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-win-release.ps1 `
     -Version <VERSION> `
     -GoPath "$env:USERPROFILE\.workdaddy-toolchains\go1.27.0\bin\go.exe" `
     -IsccPath "$env:USERPROFILE\.workdaddy-toolchains\Inno Setup 6\ISCC.exe"
   ```

   On a host where the compiler emits a large amount of output, run the same command through a child PowerShell with stdout/stderr redirected to temporary log files and wait for its exit code. Do not treat a truncated terminal response or an intermediate file as a completed build:

   ```powershell
   $argString = '-NoProfile -ExecutionPolicy Bypass -File "scripts/build-win-release.ps1" -Version <VERSION> -GoPath "<GO_EXE>" -IsccPath "<ISCC_EXE>"'
   $p = Start-Process powershell.exe -ArgumentList $argString `
     -RedirectStandardOutput release/build.stdout.log `
     -RedirectStandardError release/build.stderr.log -Wait -PassThru
   if ($p.ExitCode -ne 0) { throw "Windows build failed: $($p.ExitCode)" }
   ```

   `build-win-release.ps1` must build both `workbuddy-cn` and `workbuddy-ai`. `build-win-zip.sh` creates only an internal staging ZIP; `build-win-installer.ps1` rewrites the staged daemon version and build id to the requested release version before compiling Setup.exe. Do not hand-copy scripts into an old installer directory.

3. Deliver only these files (replace `<VERSION>` with the requested release version):

   ```text
   release/windows/WorkDaddy-Setup-<VERSION>.exe
   release/windows/WorkDaddy-AI-Setup-<VERSION>.exe
   ```

   Remove all generated `WorkDaddy-<VERSION>-win64.zip`, `WorkDaddy-AI-<VERSION>-win64.zip`, stale `release/windows/*-Setup-*.exe` files that are not part of this release, build logs, temporary verification directories, and `release/.cache` before handoff or publication. The ZIPs are staging inputs, not Windows release artifacts. Confirm that `安装失败自主解决提示词.txt` is absent from both Setup.exe payloads.

4. Inspect the actual Setup.exe payloads, not just their filenames. Run `innounp -t` on both files, list or extract them, and verify all of the following for each package:

   - `scripts/runtime/node/node.exe` exists.
   - `scripts/daemon.js` reports the requested `<VERSION>`.
   - `scripts/win-launcher.js`, `scripts/watchdog.js`, and the required PowerShell scripts are present.
   - CN uses `workbuddy-cn`, `47832`, `9222` as its defaults; AI uses `workbuddy-ai`, `47833`, `9223`.
   - The extracted `scripts/inject.js` keeps the platform placeholder unquoted (`var WBS_PLATFORM = __WBS_PLATFORM__;`) so daemon replacement with `JSON.stringify(process.platform)` produces the correct `"win32"` value. Confirm the Windows path contains the auto-open installer flow and does not enter the macOS reboot progress branch.
   - The package contains no `安装失败自主解决提示词.txt` and no temporary ZIP.

5. Run release checks from the same repository:

   ```powershell
   node --check scripts/daemon.js
   node --check scripts/inject.js
   node --check scripts/win-launcher.js
   node --check scripts/watchdog.js
   node --test test/*.test.js
   git diff --check
   ```

   A skipped `sqlite3` CLI fallback test is expected on machines without the CLI. Windows runtime operation uses the bundled Node `node:sqlite` implementation and must not depend on a separately installed `sqlite3.exe`.

6. Smoke-test installation and startup in this order: install WorkDaddy AI first (including an elevated installer run), launch it; install WorkDaddy second with a normal installer run, launch it; then repeat normal and elevated shortcut launches for both profiles. Both clients must remain open simultaneously. If a previous install left a daemon/watchdog running, the installer may stop only the exact current-profile lifecycle after verifying script path, Node path, PID, owner, profile, port, and daemon status. It must never kill all `WorkBuddy.exe`/`Electron.exe` processes.

7. When a PID file is missing during an install/update race, the launcher may reconstruct it only for one exact current-profile watchdog. Multiple matches, an unverified path, a foreign owner, an elevated target from a standard process, or an unbound daemon must fail closed with actionable logs. The old generic “请先完全退出 WorkBuddy” cold-start gate must not be used for a verified current-profile process; the launcher should restart that process precisely and wait for its expected CDP port.

## Change Workflow

1. Read the surrounding code and existing tests before editing.
2. State the suspected cause and a falsifiable check when debugging a report.
3. Add or update a focused regression test at the closest reliable seam before the fix. For platform-only behavior, static assertions are acceptable when the platform is unavailable, but document the missing runtime verification.
4. Implement the smallest compatible fix. Keep user-facing copy in Chinese consistent with neighboring UI copy.
5. Run the relevant syntax checks and the complete test suite before handoff.
6. For UI changes, inspect both light and dark selectors and, when a WorkBuddy renderer is available, verify the actual injected panel after reload/reinjection. Check narrow-window wrapping and scroll position for modal/list changes.
7. Review `git diff --check`, confirm no sensitive data or generated artifacts were added, and report any platform tests that could not run.

## Verification Commands

From the repository root:

```bash
node --check scripts/daemon.js
node --check scripts/inject.js
node --check scripts/win-launcher.js
node --test test/*.test.js
git diff --check
```

PowerShell syntax and real installer/update smoke tests should be run on Windows (or in an environment with `pwsh`). Do not claim those checks passed based only on macOS static inspection.

## Commit and Delivery Notes

- Work on a dedicated branch based on the requested base branch.
- Keep logically related fixes together; avoid metadata-only churn and unrelated formatting changes.
- Do not push, merge, or modify `main` unless the user explicitly asks for it.
- When delivering a packaged app, state exactly which source files were synchronized into the artifact and whether the running daemon/WorkBuddy process was restarted.
