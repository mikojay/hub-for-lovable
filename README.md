# Hub for Lovable

One Mac window for all your [Lovable](https://lovable.dev) projects, in the style of Felix Haas' multi-agent interface.

- **Card row:** the project in the middle is the real Lovable editor (chat + live preview). The neighbours peek in from the sides.
- **Fill window:** the ⤢ button (or ⌘⇧F) gives the current project the whole window. Switching still works.
- **One input bar:** sends to the project in the middle. Type `@` to add more projects, and the same prompt goes to each of them.
- **Build / Chat toggle:** choose Lovable's mode right in the input bar (⇧Tab while typing). The app switches Lovable's own dropdown before sending.
- **Activity chips:** the title bar shows which projects are working (yellow) and which are done (green ✓). Click one to jump there. You also get a macOS notification when the app is in the background.
- **Your workspaces:** the project list comes straight from your Lovable account. Switch between workspaces (or show all) with the button next to the title.

> Hub for Lovable is an unofficial side project. It is not made by, affiliated with or endorsed by Lovable.

## Install

You need a Mac (tested on Apple Silicon) and [Node.js](https://nodejs.org) (LTS). Or let an AI coding agent do it: the repo has instructions for them in `AGENTS.md`.

```bash
git clone https://github.com/mikojay/hub-for-lovable.git
cd hub-for-lovable
npm install
npm run package
```

This builds `dist/Hub for Lovable.app`. Drag it into your Applications folder and open it like any other app. To keep it in the Dock: right-click its Dock icon → Options → Keep in Dock.

To try it without building: `npm start`.

## Logging in

Click **Log in to your Lovable account** on the start screen and log in once. The app remembers it until you choose **Log Out** (Account menu, or the workspace button).

**Passkeys don't work inside apps** (macOS only lets real browsers use them). The app tells login pages so, which makes Google ask for your password instead. Email + password and GitHub login work too.

## Shortcuts

| | |
|---|---|
| ⌃Tab (hold ⌃, tap Tab) | Recent projects switcher, release ⌃ to open |
| ⌘G | Grid of all projects (type to filter) |
| ⌘⌥← / ⌘⌥→ | Previous / next project |
| ⌘⇧F | Fill the window with the current project |
| ⌘L | Jump to the input bar |
| ⇧Tab (in input bar) | Switch between Build and Chat |
| Esc (in input bar) | Back into the Lovable editor |
| ⌘R | Reload the current project |
| ＋ (top right) | Add a project by pasting its Lovable link (e.g. one shared with you) |

These work even while you're typing inside Lovable.

## Good to know

- **Privacy:** your login, project list and screenshots stay on your Mac in `~/Library/Application Support/Hub for Lovable`. The app talks only to Lovable (and to the sign-in pages you use). Log Out deletes all of it.
- **How the project list works:** Lovable's own pages send a login token with every request to Lovable's API. The app reuses the newest one, in memory only, to ask Lovable for your workspaces and projects. This is Lovable's internal API, not a public one, so a Lovable update could break it; the app then keeps its last list.
- **Memory:** at most 5 projects stay live at once (`MAX_LIVE` in `main.js`). Others show their last screenshot and open again when you switch to them. A project that's working is never closed.
- **Credits:** sending from the input bar is the same as typing into Lovable's chat, so it uses your credits normally.
- **The fragile part:** the app finds Lovable's chat box, its Build/Chat dropdown and its "Stop" button by looking at the page. If Lovable changes its interface, sending or the Working/Done status might stop working. All of that lives in `lovable-dom.js`. If sending fails, your prompt is copied to the clipboard so you can paste it with ⌘V.
- **⌃ release:** Electron doesn't reliably report releasing ⌃, so a tiny helper (`modwatch.js`, run with macOS' built-in `osascript`) watches the key while the app runs. It needs no permissions.

## Project layout

| File | What it does |
|---|---|
| `main.js` | Window, Lovable views, shortcuts, sending prompts, status polling, account and workspaces |
| `ui/` | The hub's own interface (card row, grid, input bar, start screen) |
| `preload.js` | The bridge between `ui/` and `main.js` |
| `lovable-dom.js` | Everything that depends on how Lovable's page is built |
| `no-passkeys.js` | Tells login pages that passkeys aren't available |
| `modwatch.js` | Reports when ⌃ is released (for ⌃Tab) |
| `scripts/build-mac.sh` | Builds the `.app` (`npm run package`) |
| `build/` | App icon |
