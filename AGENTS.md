# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, …) that set up or change Hub for Lovable for a user.
Humans: see README.md.

## What this is

An Electron app for macOS that shows a user's Lovable (lovable.dev) projects in one window. Each focused project is the
real Lovable editor in a `WebContentsView`; the hub UI (card row, grid, input bar) is a plain web page in `ui/`.
No build step for the code itself, no frameworks, no runtime dependencies besides Electron.

## Setting it up for a user

1. Requirements: macOS, Node.js LTS or newer (`node -v`), git. Apple Silicon is tested; Intel should work because the
   build uses whatever Electron `npm install` downloaded for the host.
2. Install and build:
   ```bash
   npm install          # downloads Electron; package.json allowScripts approves electron's install script
   npm run package      # builds "dist/Hub for Lovable.app" (scripts/build-mac.sh)
   ```
3. Install the app: `ditto "dist/Hub for Lovable.app" "/Applications/Hub for Lovable.app"`, then `open "/Applications/Hub for Lovable.app"`.
   It is ad-hoc signed and built locally, so Gatekeeper does not block it. Don't change the user's Dock yourself;
   tell them: right-click the Dock icon → Options → Keep in Dock.
4. Tell the user to log in once on the start screen. **Passkeys can't work in Electron on macOS**; `no-passkeys.js`
   makes Google ask for the password instead. Email + password and GitHub login also work.

For development, `npm start` runs the app from the folder. Quit the installed app first: both use the same data folder.

## Known pitfalls (already solved; don't undo)

- **`@electron/packager` / `electron-builder` may hang silently on new Node versions** while extracting Electron.
  That's why `scripts/build-mac.sh` copies `node_modules/electron/dist/Electron.app` and re-signs it ad-hoc.
  Keep the executable name `Electron`: helper apps are found by that name.
- **npm 11+ blocks install scripts** unless listed in `allowScripts`. After upgrading Electron, run
  `npm install-scripts approve electron`.
- **The ⌃ key release is often not delivered** to `before-input-event`. `modwatch.js` (JXA via `osascript`) polls
  `CGEventSourceFlagsState` and reports `ctrl:0`. No permissions needed. Without it, ⌃Tab waits for Enter.
- **A Lovable page that was never shown has no size (0x0)**, so its chat box can't be found. `showFocused()` in `main.js` keeps projects that are sending or working attached underneath the front project at the same bounds (real size, page counts as visible). `prepare-send` loads all `@` targets at once. Don't park views off-screen: they stay 0x0. `SHOW_SWITCH` in `ui/app.js` is a visible-switching fallback.
- **Menu accelerators fail after a hidden view kept focus** (macOS error beep). Shortcuts are therefore handled in
  `handleKey()` in `main.js` via `before-input-event` on the hub and on every Lovable view.
- **Google login inside a project's preview** (the project's own app, not Lovable's login) opens a popup that ends on
  `http://127.0.0.1/iframe-oauth/callback#access_token=…`, which only Lovable's own editor handles. In `createView()`,
  `did-create-window` catches that redirect, writes the session to the preview's `sb-<ref>-auth-token` localStorage key,
  closes the popup and sends the preview to `/`. Popups must stay inside the app (the allow-list in `setWindowOpenHandler`),
  because the browser has a separate session. Never log the callback URL or its tokens.
- **Native views draw above the HTML.** Anything the hub shows on top of a project (popups, overlays) must hide the view
  first (`hub.hide`) or use a native menu (`Menu.popup`), like the workspace switcher does.

## Where things live

| Path | Purpose |
|---|---|
| `main.js` | Main process: window, views (max `MAX_LIVE` live), shortcuts, prompt sending, Build/Chat switching, status polling, account (project list from Lovable's API, workspaces, log out) |
| `ui/app.js`, `ui/index.html`, `ui/style.css` | Hub UI |
| `preload.js` | The only bridge between `ui/` and `main.js` (`window.hub`) |
| `lovable-dom.js` | **All** code that depends on Lovable's page structure (chat input, send button, Build/Chat dropdown, "Stop" button, login page). Fix breakage here first. |
| `no-passkeys.js` | Session preload: hides WebAuthn so sign-in pages fall back to passwords |
| `modwatch.js` | ⌃ release watcher (see above) |
| `scripts/build-mac.sh`, `build/icon.*` | Packaging and icon |

User data (never in the repo): `~/Library/Application Support/Hub for Lovable/` (moved there automatically from the old name `Lovable Hub/`), with the login session (partition
`persist:lovable`), `projects.cache.json`, `settings.json`, `projects.local.json` and `snapshots/`.

## Lovable's internal API

The project list uses `https://api.lovable.dev/user/workspaces` and
`/v2/workspaces/{id}/projects?sort_by=last_edited_at&sort_order=desc&limit=100` (paginate with `cursor=<next_cursor>`
while `has_more`). The bearer token is taken from requests Lovable's own pages make (`webRequest.onBeforeSendHeaders`)
and kept in memory only. **Never log, print or save the token**, and don't add code that does.
The credits pill reads `/workspaces/{id}/credit-balance` (field `total_remaining`; found by watching what Lovable's own editor requests). Only workspaces where the user is owner/admin count (`mine` in the cache, from the role in `/user/workspaces`).
This API is unofficial and can change; on failure the app keeps its cached list and hides the credits pill.

## Rules for changes

- Don't commit personal data: no project lists, IDs, emails, tokens or screenshots. `.gitignore` covers
  `node_modules/` and `dist/`.
- Sending prompts costs the user Lovable credits. Don't send test prompts without asking the user.
- You usually can't verify UI behaviour yourself: synthetic keystrokes (`osascript`) and screenshots need macOS
  permissions the agent normally doesn't have. Check syntax with `node --check <file>`, then ask the user to try
  specific steps, and add temporary `console.log` output (visible with `npm start`) when something needs debugging.
- Keep user-facing text short and plain.
