# Build Plan: Local Tab Suspender Extension (Chromium)

## Context

You are building a local Chromium browser extension that automatically suspends inactive tabs to reduce memory and GPU surface usage. This is being built from scratch (not forked) for full auditability and trust — the original Great Suspender was sold in 2020 and injected with malware, and existing alternatives are either unmaintained, closed-source, or bloated with multi-browser support.

The extension will be loaded as an unpacked extension via the browser's extensions page (e.g. `chrome://extensions`, `vivaldi://extensions`, `edge://extensions`, `brave://extensions`) with developer mode enabled. It does NOT need to be published to any web store.

## Technical Foundation

### Architecture Decisions (non-negotiable)

- **Manifest V3 only** — Chrome 135 (April 2026) disables MV2 entirely
- **Native Tab Discard API** (`chrome.tabs.discard()`) — NOT the old approach of replacing tab URLs with a custom suspended.html page. Native discard completely removes tab content from memory while keeping the tab visible in the strip. When clicked, tabs reload at their original URL with scroll position preserved. This means: no risk of losing tabs if the extension is removed, no dead `chrome-extension://` URLs, and complete GPU memory surface elimination for discarded tabs
- **Chromium-compatible** — use only standard `chrome.*` APIs (not `browser.*`). The extension should work in any Chromium-based browser: Chrome, Vivaldi, Edge, Brave, Arc, Opera, etc.
- **Zero external dependencies** — no npm packages, no build step, no bundler. Plain JavaScript, HTML, CSS. The entire extension must be readable and auditable by a human scanning the source files
- **Zero network activity** — no analytics, no telemetry, no remote code, no external requests of any kind. All data stays in `chrome.storage.local`
- **No content scripts** — the native discard API operates entirely from the service worker. No code is injected into web pages. The only exception is YouTube timestamp preservation, which uses one-time `chrome.scripting.executeScript` calls (not persistent content scripts)

### Required Permissions (manifest.json)

```json
{
  "manifest_version": 3,
  "name": "Tab Suspender",
  "version": "1.0.0",
  "description": "Automatically suspend inactive tabs to free memory. Local build, no tracking, no network access.",
  "permissions": [
    "tabs",
    "alarms",
    "storage",
    "contextMenus"
  ],
  "optional_permissions": [],
  "host_permissions": []
}
```

Notes:
- `tabs` — required for `chrome.tabs.discard()`, `chrome.tabs.query()`, and tab event listeners
- `alarms` — for periodic checks of inactive tabs (replaces `setTimeout` which doesn't work in MV3 service workers)
- `storage` — for persisting settings (timeout, whitelist, etc.)
- `contextMenus` — for right-click menu integration
- NO `host_permissions` needed — native discard doesn't require page access

### File Structure

```
tab-suspender/
├── manifest.json
├── background.js          # Service worker — core logic
├── popup.html             # Toolbar popup UI
├── popup.js               # Popup logic
├── popup.css              # Popup styling
├── options.html           # Settings page
├── options.js             # Settings logic
├── options.css            # Settings styling
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Feature Specifications

### CORE FEATURES (must ship in v1.0)

#### 1. Auto-discard after configurable inactivity timeout

- Default timeout: 15 minutes
- Configurable range: 1 minute to 24 hours (dropdown or input in options page)
- Implementation: use `chrome.alarms.create()` to set a recurring check (every 60 seconds). On each alarm tick, query all tabs, check each tab's last active timestamp against the timeout, and discard eligible tabs
- Track last-active timestamps in a Map in the service worker. Update the timestamp whenever `chrome.tabs.onActivated` fires. Persist the Map to `chrome.storage.local` periodically (every 5 minutes) so it survives service worker restarts
- When the service worker wakes up (MV3 service workers are ephemeral), restore the Map from storage before processing

#### 2. Never discard the active tab

- Before discarding any tab, check `tab.active === true`. If active, skip
- This is also enforced by Chrome itself (`chrome.tabs.discard()` on an active tab is a no-op), but check explicitly for clarity

#### 3. Never discard tabs playing audio

- Check `tab.audible === true` before discarding. If audible, skip
- This covers music, video calls, background audio from any source

#### 4. Never discard pinned tabs

- Check `tab.pinned === true` before discarding. If pinned, skip
- This should be the default behavior but also configurable (some users may want pinned tabs to be discardable)

#### 5. Domain/URL whitelist

- Stored in `chrome.storage.local` as an array of strings
- Support both exact domain matches (`mail.google.com`) and wildcard patterns (`*.google.com`)
- Before discarding a tab, check its URL against the whitelist. If matched, skip
- UI: editable list in the options page with add/remove. Also add a "Whitelist this site" option in the popup for quick access
- Default whitelist: empty (user builds their own)

#### 6. Manual discard controls from toolbar

- Popup should show buttons:
  - "Suspend this tab" — discard the current active tab (note: this requires first switching to another tab, then discarding, since you can't discard the active tab. OR: show a lightweight "click to reload" message by navigating to a simple internal page, then discarding. Evaluate which approach is cleaner — the simplest is to just discard the tab and let the user know it'll reload when they return to it)
  - "Suspend other tabs" — discard all tabs in the current window except the active one
  - "Suspend all tabs in all windows" — discard all non-active, non-exempt tabs across all windows

#### 7. Keyboard shortcuts

- Define in manifest.json under `"commands"`:
  - `suspend-current`: Suspend the current tab (Ctrl+Shift+S / Cmd+Shift+S)
  - `suspend-others`: Suspend other tabs in window (Ctrl+Shift+O / Cmd+Shift+O)
  - `toggle-whitelist`: Toggle whitelist for current domain (Ctrl+Shift+W / Cmd+Shift+W)
- Users can customize shortcuts via the browser's extensions shortcuts page (e.g. `chrome://extensions/shortcuts`)
- Handle via `chrome.commands.onCommand` listener in background.js

### NICE-TO-HAVE FEATURES (include in v1.0 if feasible, otherwise v1.1)

#### 8. Badge counter showing discarded tab count

- Update the extension badge (`chrome.action.setBadgeText`) whenever tabs are discarded or restored
- Show the count of currently discarded tabs across all windows
- Badge background color: a muted grey or blue (not alarming red)
- Update on: discard events, tab activation (which restores a discarded tab), tab close, tab create
- Use `chrome.tabs.query({ discarded: true })` to get the count

#### 9. Popup showing all tabs with status

- The popup should show a list of all tabs in the current window with:
  - Tab favicon + title (truncated)
  - Status indicator: active (green dot), idle (grey), discarded (dimmed/strikethrough), protected (lock icon for pinned/whitelisted/audio)
  - Click on a discarded tab to switch to it (which auto-restores it)
  - Click on an active/idle tab to manually discard it
- Keep the popup lightweight — no frameworks, vanilla HTML/CSS/JS
- Scroll if more than ~15 tabs visible

#### 10. "Discard all tabs" / "Restore all tabs" bulk actions

- "Discard all" — discard every eligible tab (respecting all protection rules)
- "Restore all" — `chrome.tabs.reload()` on every discarded tab. Note: simply switching to a discarded tab restores it, but for bulk restore across a window, explicit reload is needed
- Both available as buttons in the popup

#### 11. YouTube timestamp preservation before discard

- Before discarding a tab whose URL matches `*://www.youtube.com/watch*`, inject a one-time content script (via `chrome.scripting.executeScript`) that reads the current video timestamp from the page's `<video>` element: `document.querySelector('video')?.currentTime`
- Store the timestamp in `chrome.storage.local` keyed by video URL
- When the tab is restored (detected via `chrome.tabs.onUpdated` status complete + YouTube URL), inject another one-time script to seek to the saved timestamp
- Clean up saved timestamps after successful restore or after 7 days (whichever comes first)
- This requires `"scripting"` permission added to manifest

---

## Implementation Order

Build in this sequence. Each step should be independently testable:

1. **Scaffold** — manifest.json, file structure, icons (use simple colored squares as placeholder icons), load in any Chromium browser as unpacked extension
2. **Service worker basics** — background.js with alarm setup, tab event listeners, last-active timestamp tracking with storage persistence
3. **Auto-discard logic** — the core discard loop: on each alarm tick, find and discard eligible tabs (respecting active/pinned/audible rules)
4. **Whitelist** — storage structure, matching logic, options page UI for managing the list
5. **Popup UI** — basic popup with manual discard buttons, tab list with status indicators, badge counter
6. **Keyboard shortcuts** — manifest commands + handler in background.js
7. **Context menu** — right-click options for discard/whitelist
8. **YouTube timestamps** — scripting injection, storage, restore logic
9. **Polish** — error handling, edge cases (what happens when service worker restarts mid-operation), UI refinement

---

## Design Guidelines

### Popup UI

- Clean, minimal, no visual clutter
- Dark mode aware — use `prefers-color-scheme` media query
- Max width: 350px. Max height: 500px
- Tab list should be the primary content
- Settings link at the bottom opens options page
- Use system fonts (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)

### Options Page

- Simple form layout
- Sections: General (timeout, pinned tab behavior), Whitelist (editable list), Keyboard Shortcuts (display current, link to browser shortcuts page), About (version, "local build — no tracking")
- Save automatically on change (no save button)

### Icons

- Generate simple, clean SVG-based icons at 16, 32, 48, 128px
- Concept: a tab shape with a pause/sleep indicator (zzz or a moon or a pause symbol)
- Use a calming blue or grey palette

---

## Edge Cases to Handle

1. **Service worker restart** — MV3 service workers are killed after ~30 seconds of inactivity. On restart, restore timestamp Map from `chrome.storage.local`. The alarm persists across restarts (Chrome manages it)
2. **Tab created while discarded** — if a user opens a link that creates a new tab, don't immediately discard it. Only start the inactivity timer after first activation
3. **Multiple windows** — track timestamps per tab ID (globally unique within a session), not per window
4. **Incognito** — respect `"incognito": "spanning"` in manifest (default). If the user enables the extension in incognito, it should work there too. Don't persist incognito tab data to storage
5. **Extension pages** — never discard browser-internal URLs (`chrome://`, `edge://`, `vivaldi://`, `brave://`, `chrome-extension://`, `about:`, etc.)
6. **Rapid tab switching** — debounce the `onActivated` handler to avoid excessive storage writes
7. **Tab groups** — native Chrome tab groups should be respected. Discarded tabs stay in their group

---

## Testing Checklist

After building, verify:

- [ ] Extension loads in Chromium browser without errors
- [ ] Tabs auto-discard after the configured timeout
- [ ] Active tab is never discarded
- [ ] Pinned tabs are never discarded
- [ ] Tabs playing audio are never discarded
- [ ] Whitelisted domains are never discarded
- [ ] Manual "suspend this tab" works
- [ ] Manual "suspend other tabs" works
- [ ] Badge counter updates correctly
- [ ] Keyboard shortcuts trigger correct actions
- [ ] Popup shows accurate tab list with statuses
- [ ] Options page saves settings correctly
- [ ] Settings persist across browser restart
- [ ] Extension survives service worker restart (close and reopen browser)
- [ ] YouTube timestamp is preserved on suspend and restored on resume
- [ ] No network requests in DevTools Network tab (zero external calls)
- [ ] No errors in service worker console (extensions page → Inspect views)

---

## What NOT To Build

- Multi-browser compatibility layers (Firefox `browser.*` API, etc.)
- Cloud sync / account system
- Memory usage dashboard / charts
- Session export/import
- Onboarding wizard
- Any form of analytics or telemetry
- Integration with any external service
- Tab grouping/organization features (this is a suspender, not a tab manager)

---

## Reference: Key Chrome APIs

```javascript
// Discard a tab (removes from memory, stays in tab strip)
chrome.tabs.discard(tabId);

// Query tabs
chrome.tabs.query({ discarded: true }, (tabs) => { /* ... */ });
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { /* ... */ });

// Tab events
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => { /* ... */ });
chrome.tabs.onRemoved.addListener((tabId) => { /* ... */ });
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { /* ... */ });

// Alarms (periodic checks)
chrome.alarms.create('check-inactive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { /* ... */ });

// Badge
chrome.action.setBadgeText({ text: '5' });
chrome.action.setBadgeBackgroundColor({ color: '#666' });

// Storage
chrome.storage.local.set({ key: value });
chrome.storage.local.get(['key'], (result) => { /* ... */ });

// Commands (keyboard shortcuts)
chrome.commands.onCommand.addListener((command) => { /* ... */ });

// Context menus
chrome.contextMenus.create({ id: 'discard-tab', title: 'Suspend this tab', contexts: ['page'] });
chrome.contextMenus.onClicked.addListener((info, tab) => { /* ... */ });

// Scripting (for YouTube timestamp injection)
chrome.scripting.executeScript({ target: { tabId }, func: () => { /* ... */ } });
```

---

## Motivation

This extension exists because:
1. The M1 MacBook Pro + LG UltraWide monitor setup experiences WindowServer freezes under sustained GPU compositor load. Each loaded browser tab maintains GPU memory surfaces. Discarding inactive tabs eliminates those surfaces completely.
2. The Great Suspender was compromised with malware after being sold. A locally-built, fully auditable extension with zero network access and zero external dependencies is the only trustworthy approach.
3. Existing alternatives (Auto Tab Discard, Tiny Suspender, Marvellous Suspender) are either unmaintained, closed-source, or carry legacy MV2 baggage.
