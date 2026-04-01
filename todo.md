# Zen Tidy Downloads — full refactor roadmap

Incremental goal: **`tidy-downloads.uc.js`** = thin **orchestrator** for download pods + Firefox integration; **`zen-stuff.uc.js`** = thin **orchestrator** for the dismissed pile; logic lives in **`modules/*.uc.js`** with stable boundaries (`window.zenTidyDownloads`, DOM events, prefs).

---

## Already done (baseline)

Use this as the pattern for remaining extractions.

- [x] Shared **utils** (`tidy-downloads-utils.uc.js`) — prefs, security, formats, DOM wait, extension sets, `readTextFilePreview`, etc.
- [x] **Store** (`tidy-downloads-store.uc.js`) — maps, sets, refs, throttle prefs
- [x] **Downloads adapter** (`tidy-downloads-downloads-adapter.uc.js`)
- [x] **Sync** (`tidy-downloads-sync.uc.js`) — sidebar width ↔ tooltip/pods
- [x] **Toasts** (`tidy-downloads-toasts.uc.js`)
- [x] **Preview** (`tidy-downloads-preview.uc.js`) — pod/tooltip preview (uses utils for text preview + extension sets)
- [x] **Fileops / rename** (`tidy-downloads-fileops.uc.js`)
- [x] **Animation** (`tidy-downloads-animation.uc.js`) — downloads button, indicator patches
- [x] **AI rename** (`tidy-downloads-ai-rename.uc.js`)
- [x] **Pods** (`tidy-downloads-pods.uc.js`) — create/update pod DOM, throttle, drag, AI queue hooks
- [x] **Tooltip + layout** (`tidy-downloads-tooltip-layout.uc.js`) — master tooltip content, jukebox layout, wheel focus
- [x] **Public API** (`tidy-downloads-public-api.uc.js`) — `window.zenTidyDownloads` factory
- [x] **Bootstrap** — `tryInit` waits on required globals; **`theme.json`** load order documented in repo
- [x] **zen-stuff** — pile preview/helpers deduped onto **utils** (`readTextFilePreview`, extension sets)

---

## Phase A — `tidy-downloads.uc.js` (orchestrator shrink)

Aim: main file only **wires** modules, holds minimal closures, and keeps **one** place for “when does init run.”

### A.1 — Inventory & guardrails

- [x] Document in a short comment block (top of `initializeMainScript` or README): **dependency order**, what `tryInit` requires, and what zen-stuff relies on (`window.zenTidyDownloads`).
- [ ] Grep for **closure-heavy** helpers still in main: `capturePodDataForDismissal`, `fireCustomEvent`, `getDownloadKey`, `getSafeFilename`, `initDownloadManager` internals, download listener, Mistral init block.
- [ ] Decide **naming convention** for new modules: `modules/tidy-downloads-<area>.uc.js` (match existing).

### A.2 — Extract **download UI shell** (largest single win)

`initDownloadManager` today includes: container insert, tooltip markup, pods row, compact observer hook, pile-shown listener, master close/undo handlers, tooltip-layout init, sync init, wheel listener, pods init, **DownloadsAdapter** listener, startup “recent downloads” scan, Mistral preview init, etc.

- [x] Create **`modules/tidy-downloads-download-ui.uc.js`** (or split into **shell** + **listeners** if too large):
  - [x] **DOM creation / rehydration** — `#userchrome-download-cards-container`, `.master-tooltip` inner HTML, `#userchrome-pods-row-container`, parent insert + `position: relative` fallback
  - [x] **Event binding** that is purely UI — master close, master undo (calling existing `undoRename` / `removeCard` via ctx)
  - [ ] **Registration order** — after DOM exists: `zenTidyDownloadsTooltipLayout.init`, `zenTidyDownloadsSync.init`, wheel on pods row, `zenTidyDownloadsPods.init`
  - [ ] Return an object: `{ getDownloadCardsContainer, getMasterTooltip, getPodsRow, ... }` or mutate ctx refs passed in — pick one style and stick to it
- [ ] **Main** becomes: `const downloadUi = window.zenTidyDownloadsDownloadUi.init(ctx)` (or equivalent) + assign `throttledCreateOrUpdateCard` from pods API

### A.3 — Extract **downloads lifecycle / listeners**

- [x] Move **`DownloadsAdapter.createDownloadViewListener`** wiring + **`onCompletedState` / `onRemoved`** (and any related helpers) into **`modules/tidy-downloads-downloads-listener.uc.js`** OR fold into A.2 if small
- [ ] Ensure **single** place registers the listener and **single** place removes it (if ever needed for teardown)

### A.4 — Extract **card removal + autohide + sticky** pipeline

These are tightly coupled to store + DOM + pile events:

- [x] **`removeCard`** — animation, `dismissedPodsData`, `fireCustomEvent('pod-dismissed')`, focus handoff, `updateUIForFocusedDownload`, container hide when empty
- [x] **`scheduleCardRemoval`**, **`performAutohideSequence`**, **`makePodSticky`**
- [x] **`clearStickyPod`**, **`clearAllStickyPods`**, **`clearStickyPodsOnly`**
- [x] Candidate module: **`modules/tidy-downloads-card-lifecycle.uc.js`** exporting `createCardLifecycle({ store, deps })` with methods assigned back to names main/pods already call
- [ ] Resolve **ordering**: pods module references `scheduleCardRemoval` — use **forward refs** / `ctx.getScheduleCardRemoval()` pattern if needed (same as `tidyDeps` / `tooltipLayoutRef`)

### A.5 — Extract **compact mode + container visibility**

- [x] **`setupCompactModeObserver`**
- [x] **`updateDownloadCardsVisibility`**
- [ ] Either merge into download-ui module or **`modules/tidy-downloads-compact-visibility.uc.js`** if you want a tiny focused file

### A.6 — Extract **helpers** still in main

- [x] **`capturePodDataForDismissal`** — could live next to card-lifecycle or in a small **`modules/tidy-downloads-dismiss-capture.uc.js`**
- [ ] **`fireCustomEvent`** — either keep in main (single dispatcher) or move to **utils** / **public-api companion** if you want zero duplication with other modules
- [ ] **`getDownloadKey`**, **`getSafeFilename`** — consider **utils** (key generation is generic) vs **downloads-key.uc.js** if Firefox-specific quirks grow

### A.7 — Extract **Mistral / startup “recent downloads” block**

- [ ] The **DL Preview Mistral AI** init inside `initDownloadManager` (list + `recentDownloads.forEach(throttledCreateOrUpdateCard)`) → **`modules/tidy-downloads-mistral-preview.uc.js`** or extend **AI rename** module if you prefer fewer files
- [ ] Main passes **`getPref`**, **`RateLimiter`**, keys, **`throttledCreateOrUpdateCard`** getter

### A.8 — Thin **`initializeMainScript`**

Target shape (conceptual):

- [ ] Imports from `Utils` / creates `store` / inits fileops, preview, AI, rename handlers, **`window.zenTidyDownloads`**
- [ ] Inits animation patch
- [ ] Calls **download UI** init (which inits tooltip layout, sync, pods, listeners)
- [ ] **No** 300-line functions left in main; prefer **&lt; ~150 lines** in `initializeMainScript` as a soft cap

### A.9 — Hardening after Tidy split

- [x] **`tryInit`**: add checks for any **new** `window.zenTidyDownloads*` globals (mirror pods / public-api pattern)
- [x] **`theme.json` / user `mods.json`**: bump **`loadOrder`** for every new script **before** `tidy-downloads.uc.js`
- [ ] **Smoke test** after each extraction: complete download, error download, dismiss, pile restore, sticky autohide, wheel focus, AI rename, undo, compact mode

---

## Phase B — `zen-stuff.uc.js` → orchestrator + modules

Principle: **one vertical slice per PR**; keep behavior identical; prefer **`modules/zen-stuff-*.uc.js`** loading **before** `zen-stuff.uc.js` (same as Tidy).

### B.0 — Prep

- [ ] **Map dependency graph**: what uses `PileState`, `EventManager`, `FileSystem`, `ErrorHandler`, `state`, `CONFIG`, `debugLog`
- [ ] **Freeze public surface**: zen-stuff should not need to export a global except what already exists (optional: `window.zenStuffPile` for debugging only)
- [ ] Add **`tryInit`** or retry loop audit: today `init` waits for `window.zenTidyDownloads` — document minimum **utils + tidy public API** load order

### B.1 — **Session / persistence** module

- [x] `initSessionStore`, `saveDismissedPodToSession`, `removeDismissedPodFromSession`, `restoreDismissedPodsFromSession`, `updatePodKeysInSession`
- [ ] File: **`modules/zen-stuff-session.uc.js`** exporting `createSessionApi({ debugLog, SessionStore: window.SessionStore, ... })`

### B.2 — **Pile DOM factory** (container + bridge + sizer)

- [x] `createPileContainer` (dynamic sizer, hover bridge, mask injection, insertion points)
- [ ] File: **`modules/zen-stuff-pile-dom.uc.js`**

### B.3 — **Dismissed pod element** (row UI)

- [ ] `createPodElement`, preview branch (`renderPreview`, `getFileIcon`, inline rename UI hooks if tightly coupled)
- [ ] File: **`modules/zen-stuff-pod-element.uc.js`** (or split **preview** vs **row chrome** if huge)

### B.4 — **Layout engine** (messy vs grid)

- [ ] `generatePilePosition`, `generateGridPosition`, `applyPilePosition`, `applyGridPosition`, `recalculateLayout`, `updatePileContainerWidth`, `updatePileHeight`, `updatePilePosition`, `debounce` (or use utils debounce if added)
- [ ] File: **`modules/zen-stuff-pile-layout.uc.js`**

### B.5 — **Visibility + hover controller** (highest risk — isolate)

- [ ] `showPile`, `hidePile`, `updatePileVisibility`, hover handlers (`handleDownloadButtonHover/Leave`, `handleDynamicSizer*`, `handlePileHover/Leave`, bridge handlers, `isHoveringPileArea`, `shouldPileBeVisible`)
- [ ] File: **`modules/zen-stuff-pile-hover.uc.js`** — keep **one** module owning timing to avoid race bugs across files

### B.6 — **Theming / text / background**

- [ ] `parseRGB`, `computeBlendedBackgroundColor`, `calculateTextColorForBackground`, `updatePodTextColors`, `showPileBackground`, `hidePileBackground`, workspace scrollbox show/hide, `setupPileBackgroundHoverEvents`
- [ ] File: **`modules/zen-stuff-pile-theme.uc.js`**

### B.7 — **Prefs + observers**

- [ ] `setupCompactModeObserver`, `setupPreferenceListener`, `handleAlwaysShowPileChange`, `getAlwaysShowPile`, `getUseLibraryButton`, `updatePointerEvents`, `updateDownloadsButtonVisibility`, `initPileSidebarWidthSync`
- [ ] File: **`modules/zen-stuff-pile-prefs.uc.js`**

### B.8 — **Context menu + file actions**

- [ ] `ensurePodContextMenu`, `openPodFile`, `showPodFileInExplorer`, `startInlineRename`, `renamePodFile`, `copyPodFileToClipboard`, `deletePodFile`, `removeDownloadFromFirefoxList`, `clearAllDownloads`, `showUserNotification`, `isValidFilename`, visibility helpers
- [ ] File(s): **`modules/zen-stuff-pile-actions.uc.js`** (split **menu** vs **fs** if needed)

### B.9 — **Core classes** (optional extraction)

- [ ] `PileState` → **`modules/zen-stuff-pile-state.uc.js`**
- [ ] `ErrorHandler` → **`modules/zen-stuff-error-handler.uc.js`**
- [ ] `FileSystem` → **`modules/zen-stuff-filesystem.uc.js`**
- [ ] `EventManager` → **`modules/zen-stuff-event-manager.uc.js`**  
  (Or merge small classes into the module that uses them most.)

### B.10 — **`zen-stuff.uc.js` final shape**

- [ ] **CONFIG**, `debugLog`, **`init()`** only: `await findDownloadButton()` → create DOM via module → `setupEventListeners()` from module → `loadExistingDismissedPods()`
- [ ] **Cleanup** (`cleanup`) either in main or **`zen-stuff-lifecycle.uc.js`**
- [ ] Remove dead **debug/test** `console.log` blocks left from development (optional cleanup pass)

### B.11 — **theme.json / mods.json**

- [x] For each new `zen-stuff` module: add entry with **`loadOrder`** strictly **before** `zen-stuff.uc.js`, **after** `tidy-downloads.uc.js` (pile depends on `window.zenTidyDownloads`)
- [ ] Document order in README

---

## Phase C — Documentation & release

- [x] **README**: architecture diagram or bullet tree (Tidy modules vs zen-stuff modules), **`mods.json`** reminder, required scripts list
- [ ] **preferences.json** / about:config keys: single table if split across files
- [x] **Version bump** in `theme.json` when adding scripts (consumers must copy all new files)
- [ ] **Changelog** entry per phase (even if informal)

---

## Phase D — Optional / later

- [ ] **Shared debounce** / **throttle** in utils (if duplicated)
- [ ] **Type JSDoc** typedefs for `store`, `ctx` shapes (`ZenTidyDownloadsStore`, pile `podData`)
- [ ] **Automated smoke checklist** (manual is fine; optional Playwright not realistic for `chrome://`)
- [ ] Consider **`eslint`** or **`prettier`** for `.uc.js` if team grows (low priority for personal mods)

---

## Suggested order of execution

1. **Tidy A.2 + A.3** (download UI + listener) — biggest readability win in `tidy-downloads.uc.js`
2. **Tidy A.4** (card lifecycle) — isolates pile-adjacent behavior
3. **Zen B.2 + B.1** (DOM + session) — low coupling, easy wins
4. **Zen B.5** (hover) — last among zen modules if possible, or extract with extreme parity testing
5. Remaining slices in any order that minimizes merge pain

---

## Definition of “full refactor done”

- [ ] `tidy-downloads.uc.js` is primarily **wiring** (imports, `tryInit`, `createStore`, module `init`, listener registration, no large domain functions left)
- [ ] `zen-stuff.uc.js` is primarily **wiring** for the pile (init order, passing `state` / `CONFIG` into modules)
- [ ] **All** new scripts listed in **`theme.json`** with correct **`loadOrder`**
- [ ] **README** explains the two orchestrators and the integration contract (`window.zenTidyDownloads` + events)
- [ ] Full **smoke test** pass on a clean profile + your usual `mods.json` layout
