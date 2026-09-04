# WorkDaddy

**Language:** [简体中文](README.md) · [English](README_en.md)

> **WorkDaddy is a local enhancement layer for the WorkBuddy desktop app:** manage independent account backups and switch accounts in one click; keep unattended AI tasks running with quiet mode; move sessions between accounts and resume interrupted tasks; stash prompts and quick phrases; use frosted-glass themes and other utilities. Accounts and configuration stay on your computer.
> Local loopback CDP injection · the official installation is never modified.

WorkDaddy is a [WorkBuddy](https://www.workbuddy.cn/) and [WorkBuddy AI](https://www.workbuddy.ai/) desktop enhancement tool based on **Chrome DevTools Protocol (CDP)**. It injects a small control panel into the running renderer without patching, re-signing, or replacing the official app.

![License](https://img.shields.io/badge/license-AGPL--3.0-blueviolet)
![Platform](https://img.shields.io/badge/platform-macOS%2011%2B%20%7C%20Windows%2010%2F11-lightgrey)
![Node](https://img.shields.io/badge/node-%E2%89%A518-green)

## What it does

- **Fast account switching:** each WorkBuddy account has its own backup and can be restored with one click.
- **Add a new account without quitting:** complete OAuth in your browser and the new account is added automatically; a traditional soft logout flow is also available.
- **Encrypted account import/export:** move backups between computers with a password-protected file.
- **Daily credits:** opening the panel silently checks all accounts with an idempotent daily cache.
- **Quiet approval mode:** automatically handle supported permission prompts while you are away.
- **Stash prompts:** put drafts, images, files, and quotes into WorkBuddy's message queue for later sending.
- **Themes:** switch the built-in frosted-glass theme, wallpapers, and custom backgrounds.
- **Session migration:** copy sessions across accounts and continue working where you left off.
- **Model tools:** manage, back up, edit, test, and switch models more easily.
- **Sleep control:** keep the computer awake until selected tasks finish, then restore normal sleep.
- **Auto-continue:** resume replies that stop because of transient network or provider failures.
- **Quick phrases:** save common prompts and send them from the composer toolbar.

## Installation

For the mainland client download **WorkDaddy**. For the international client download **WorkDaddy AI**.

### macOS

1. Download the latest `WorkDaddy-x.y.z.dmg` or `WorkDaddy-AI-x.y.z.dmg` from [Releases](../../releases).
2. Open the DMG and drag the app into **Applications**.
3. If macOS says it cannot verify the developer, open **System Settings → Privacy & Security**, choose **Open Anyway**, and confirm with your login password.
4. Launch the app. It starts its local daemon and injects the panel into WorkBuddy.

### Windows

1. Download `WorkDaddy-Setup-x.y.z.exe` or `WorkDaddy-AI-Setup-x.y.z.exe` from [Releases](../../releases).
2. Run the installer.
3. Launch **WorkDaddy** or **WorkDaddy AI** from the desktop shortcut.

Enterprise/VPC users can select their official WorkBuddy executable in the installer. The selection is stored in the WorkDaddy data directory and can be changed by running the installer again.

### Run from source

```bash
git clone https://github.com/babygoton/WorkDaddy.git
cd WorkDaddy
bash scripts/install.sh
bash scripts/relaunch-with-cdp.sh
```

Use the profile environment variable when starting a specific client:

```bash
WBSWITCH_PROFILE=workbuddy-cn bash scripts/relaunch-with-cdp.sh
WBSWITCH_PROFILE=workbuddy-ai bash scripts/relaunch-with-cdp.sh
```

The daemon listens on loopback (`127.0.0.1`) and binds the profile to its WorkBuddy target. No account data is deleted during migration; legacy backup directories remain in place.

## How it works

```
┌─────────────┐  --remote-debugging-port=9222  ┌──────────────┐
│  WorkBuddy  │ <───────────────────────────> │   WorkDaddy  │
│  renderer   │       Chrome DevTools          │  daemon.js   │
└─────────────┘       Runtime.evaluate        └──────────────┘
```

1. The launcher starts WorkBuddy with a loopback CDP port; the official binary and signature remain untouched.
2. The daemon connects through CDP, watches authentication events, and stores account backups locally.
3. `scripts/inject.js` renders the WorkDaddy panel and adapts to the active WorkBuddy profile.
4. Local HTTP endpoints handle account switching, themes, sessions, sleep control, updates, and diagnostics.

## Panel

Open the robot button in the lower-right corner and choose a tab:

| Tab | Purpose |
| --- | --- |
| Accounts | Account status, switching, deletion, and encrypted import/export |
| Theme | Theme, wallpaper, avatar, blur, and overlay controls |
| Sessions | Filter, copy, migrate, or delete sessions |
| Models | Manage backups, model settings, tests, and bulk actions |
| Enhance | Quiet approvals, auto-continue, stashed prompts, and quick phrases |
| Computer | Sleep and wake policy |
| About | Version, updates, and redacted diagnostics |
| Settings | Choose Chinese or English; the first launch follows the system language and falls back to English |

The language can be changed at any time from **Settings**. The choice is stored locally and applies immediately to the panel and its toasts.

## Security and privacy

- Account backups, themes, and local configuration stay on the computer. Login, credit, update, and explicit model connectivity features call their respective official or configured services.
- Error diagnostics are enabled by default and can be disabled in **About**. Reports are redacted and truncated and do not include accounts, session contents, tokens, or API keys.
- The daemon binds to loopback only. WorkDaddy does not modify `app.asar`, terminate unrelated processes, or elevate lifecycle operations.

See [`AGENTS.md`](AGENTS.md) for the engineering and release safety rules.

## License and disclaimer

This project is licensed under the **[GNU Affero General Public License v3.0](LICENSE)** (`SPDX-License-Identifier: AGPL-3.0-or-later`).

WorkDaddy is an independent local enhancement tool and is not affiliated with or endorsed by WorkBuddy. WorkBuddy trademarks and official assets belong to their respective owners. Check rights before using third-party wallpapers or other materials commercially.

## Community

[Linux.do](https://linux.do/)
