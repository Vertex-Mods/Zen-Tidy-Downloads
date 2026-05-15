// ==UserScript==
// @include   main
// @loadOrder 99999999999998
// @ignorecache
// ==/UserScript==

// zen-stuff.uc.js
// Dismissed downloads pile with messy-to-grid transition
(function () {
  "use strict";

  // Wait for browser window to be ready
  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const Utils = window.zenTidyDownloadsUtils;
  if (!Utils) {
    console.error("[Zen Stuff] zenTidyDownloadsUtils not loaded - ensure tidy-downloads-utils.uc.js loads first (check @loadOrder in headers)");
    return;
  }
  if (
    !window.zenStuffCore?.PileState ||
    !window.zenStuffCore?.ErrorHandler ||
    !window.zenStuffCore?.createFileSystemApi ||
    !window.zenStuffCore?.createEventManagerApi ||
    !window.zenStuffSession?.createSessionApi ||
    !window.zenStuffPileDom?.createPileDomApi ||
    !window.zenStuffPodElement?.createPodElementFactory ||
    !window.zenStuffPileLayout?.createPileLayoutApi ||
    !window.zenStuffContextFileOps?.createContextFileOpsApi ||
    !window.zenStuffPileVisibility?.createPileVisibilityApi ||
    !window.zenStuffPileMaskRepair?.createMaskRepairApi ||
    !window.zenStuffPileThemeColors?.createPileThemeColorsApi ||
    !window.zenStuffPilePrefs?.createPilePrefsApi
  ) {
    console.error(
      "[Zen Stuff] Required modules missing (zen-stuff-core, zen-stuff-session, zen-stuff-pile-dom, zen-stuff-pod-element, zen-stuff-pile-layout, zen-stuff-context-fileops, zen-stuff-pile-visibility, zen-stuff-pile-prefs, zen-stuff-pile-theme-colors, zen-stuff-pile-mask-repair)"
    );
    return;
  }

  // Single-flight: avoid duplicate pile registration if this script is evaluated twice.
  if (window.__zenStuffPileBundleExecuted) {
    console.warn("[Zen Stuff] Bundle already executed in this window; skipping duplicate load.");
    return;
  }
  window.__zenStuffPileBundleExecuted = true;
  const {
    validateFilePathOrThrow,
    validatePodData,
    formatBytes,
    TEXT_EXTENSIONS,
    SYSTEM_ICON_EXTENSIONS,
    readTextFilePreview,
    filenameEndsWithExtensionFromSet
  } = Utils;

  const { PileState, ErrorHandler, createFileSystemApi, createEventManagerApi } = window.zenStuffCore;

  // Configuration
  const CONFIG = {
    maxPileSize: 20, // Maximum pods to keep in pile
    pileDisplayCount: 20, // Pods visible in messy pile
    gridAnimationDelay: 15, // ms between pod animations
    hoverDebounceMs: 50, // Hover debounce delay
    pileRotationRange: 8, // degrees ±
    pileOffsetRange: 8, // pixels ±
    gridPadding: 12, // pixels between grid items
    minPodSize: 45, // minimum pod size in grid
    minSidePadding: 5, // minimum padding from sidebar edges
    animationDuration: 150, // pod transition duration
    containerAnimationDuration: 80, // container height/padding transition duration
    maxRetryAttempts: 10, // Maximum initialization retry attempts
    retryDelay: 500, // Delay between retry attempts
  };

  const state = new PileState();
  const FileSystem = createFileSystemApi({ validateFilePathOrThrow });
  const EventManager = createEventManagerApi({ state });

  /** @type {ReturnType<typeof window.zenStuffContextFileOps.createContextFileOpsApi>|null} */
  let fileOpsApi = null;
  /** @type {ReturnType<typeof window.zenStuffPileVisibility.createPileVisibilityApi>|null} */
  let pileVisibilityApi = null;
  /** @type {ReturnType<typeof window.zenStuffPileMaskRepair.createMaskRepairApi>|null} */
  let maskRepairApi = null;
  /** @type {ReturnType<typeof window.zenStuffPilePrefs.createPilePrefsApi>|null} */
  let pilePrefsApi = null;

  // Text-file preview toggle for dismissed pods (disabled by default). Images always get previews.
  let zenStuffFilePreviewEnabled = false;
  try {
    if (typeof Services !== "undefined" && Services.prefs) {
      // Opt-in for text-file previews; images always show regardless.
      zenStuffFilePreviewEnabled = Services.prefs.getBoolPref("extensions.downloads.enable_file_preview", false);
    }
  } catch (e) {
    // Fallback to disabled if prefs are unavailable
    zenStuffFilePreviewEnabled = false;
  }

  // Debug logging with conditional output
  function debugLog(message, data = null) {
    // Only log in development mode or when explicitly enabled
    if (typeof window.zenDebugMode !== 'undefined' && window.zenDebugMode) {
      try {
        console.log(`[Dismissed Pile] ${message}`, data || '');
      } catch (e) {
        console.log(`[Dismissed Pile] ${message}`);
      }
    }
  }

  /**
   * Pile hover gate tracing. **Off unless** `window.__zenPileHoverDebug === true` in this window
   * (Browser Toolbox → browser chrome console).
   */
  function pileHoverDebug(message, data) {
    if (window.__zenPileHoverDebug !== true) return;
    try {
      console.info("[PileHoverDebug]", message, data !== undefined ? data : "");
    } catch (_e) {
      /* ignore */
    }
  }

  const {
    generatePilePosition,
    generateGridPosition,
    applyPilePosition,
    applyGridPosition,
    debounce,
    updatePileContainerWidth
  } = window.zenStuffPileLayout.createPileLayoutApi({ state, CONFIG, debugLog });

  /** @type {{ createPodElement: function }|null} */
  let zenStuffPodElementImpl = null;
  function createPodElement(podData) {
    if (!zenStuffPodElementImpl) {
      if (!fileOpsApi) {
        console.error("[Zen Stuff] fileOpsApi not initialized before createPodElement");
        throw new Error("Zen Stuff file ops not ready");
      }
      zenStuffPodElementImpl = window.zenStuffPodElement.createPodElementFactory({
        formatBytes,
        readTextFilePreview,
        filenameEndsWithExtensionFromSet,
        TEXT_EXTENSIONS,
        SYSTEM_ICON_EXTENSIONS,
        getZenStuffFilePreviewEnabled: () => zenStuffFilePreviewEnabled,
        debugLog,
        FileSystem,
        setPileContextMenuActive: (v) => {
          state.pileContextMenuActive = v;
        },
        openPodFile: (p) => fileOpsApi.openPodFile(p),
        showPodFileInExplorer: (p) => fileOpsApi.showPodFileInExplorer(p),
        ensurePodContextMenu: () => fileOpsApi.ensurePodContextMenu(),
        getPodContextMenu: () => fileOpsApi.getPodContextMenu(),
        setPodContextMenuPodData: (d) => fileOpsApi.setPodContextMenuPodData(d)
      });
    }
    return zenStuffPodElementImpl.createPodElement(podData);
  }

  // Initialize the pile system with proper error handling
  async function init() {
    if (state.isInitialized) {
      return;
    }
    if (window.__zenStuffPileInitInProgress) {
      debugLog("init skipped: already in progress (single-flight)");
      return;
    }
    window.__zenStuffPileInitInProgress = true;

    debugLog("Initializing dismissed downloads pile system");

    try {
      // Check retry limit
      if (state.retryCount >= CONFIG.maxRetryAttempts) {
        console.error('[Dismissed Pile] Max retry attempts reached, initialization failed');
        return;
      }

      // Wait for the main download script to be available
      if (!window.zenTidyDownloads) {
        state.retryCount++;
        debugLog(`Main download script not ready, retry ${state.retryCount}/${CONFIG.maxRetryAttempts}`);
        setTimeout(init, CONFIG.retryDelay);
        return;
      }

      // Wait for SessionStore to be ready
      await initSessionStore();

      await ErrorHandler.withRetry(async () => {
        await findDownloadButton();
        await createPileContainer();
        setupEventListeners();
        loadExistingDismissedPods();
      });

      state.isInitialized = true;
      state.retryCount = 0; // Reset retry count on success
      debugLog("Dismissed downloads pile system initialized successfully");
    } catch (error) {
      ErrorHandler.handleError(error, 'initialization');
      state.retryCount++;
      setTimeout(init, CONFIG.retryDelay);
    } finally {
      window.__zenStuffPileInitInProgress = false;
    }
  }

  /** @type {ReturnType<typeof window.zenStuffSession.createSessionApi>|null} */
  let sessionApi = null;

  async function initSessionStore() {
    await sessionApi.initSessionStore();
  }

  function saveDismissedPodToSession(podData) {
    sessionApi.saveDismissedPodToSession(podData);
  }

  function removeDismissedPodFromSession(podKey) {
    sessionApi.removeDismissedPodFromSession(podKey);
  }

  async function restoreDismissedPodsFromSession() {
    await sessionApi.restoreDismissedPodsFromSession();
  }

  function updatePodKeysInSession() {
    sessionApi.updatePodKeysInSession();
  }

  // Find the Firefox downloads button — shared resolver in zenTidyDownloadsUtils (zen-library-button first, same selector order).
  async function findDownloadButton() {
    try {
      console.log(`[Zen Stuff] Auto-detecting download button (trying zen-library-button first)...`);
      const found = await Utils.findZenDownloadButton();
      if (!found?.button) {
        throw new Error("Download button not found after all attempts");
      }
      const { button, kind, detail } = found;
      state.downloadButton = button;
      if (kind === "zen-library") {
        console.log("[Zen Stuff] ✅ Found zen-library-button for hover detection (auto-detected)");
        debugLog("Found zen-library-button for hover detection (auto-detected)");
      } else if (kind === "selector") {
        console.log(`[Zen Stuff] ✅ Found download button using selector: ${detail}`, button);
        debugLog(`Found download button using selector: ${detail}`);
      } else {
        debugLog("Found download button using fallback method", button);
      }
    } catch (error) {
      console.error('[DownloadButton] Error finding download button:', error);
      throw error;
    }
  }

  const pileDomApi = window.zenStuffPileDom.createPileDomApi({
    state,
    CONFIG,
    debugLog,
    setupPileBackgroundHoverEvents: () => maskRepairApi?.setupPileBackgroundHoverEvents?.(),
    setupCompactModeObserver: () => pilePrefsApi?.setupCompactModeObserver?.()
  });

  async function createPileContainer() {
    await pileDomApi.createPileContainer();
  }

  const themeColorsApi = window.zenStuffPileThemeColors.createPileThemeColorsApi({
    state,
    debugLog
  });

  pileVisibilityApi = window.zenStuffPileVisibility.createPileVisibilityApi({
    state,
    CONFIG,
    debugLog,
    pileHoverDebug,
    createPodElement,
    saveDismissedPodToSession,
    removeDismissedPodFromSession,
    updatePodKeysInSession,
    generateGridPosition,
    applyGridPosition,
    updateDownloadsButtonVisibility: () => pilePrefsApi.updateDownloadsButtonVisibility(),
    updatePodTextColors: () => themeColorsApi.updatePodTextColors(),
    showPileBackground: () => maskRepairApi.showPileBackground(),
    hidePileBackground: () => maskRepairApi.hidePileBackground(),
    hideWorkspaceScrollboxAfter: () => maskRepairApi.hideWorkspaceScrollboxAfter(),
    showWorkspaceScrollboxAfter: () => maskRepairApi.showWorkspaceScrollboxAfter(),
    schedulePileLayoutRepair: (source, delayMs) => maskRepairApi.schedulePileLayoutRepair(source, delayMs),
    setupPileBackgroundHoverEvents: () => maskRepairApi.setupPileBackgroundHoverEvents(),
    updatePointerEvents: () => pilePrefsApi.updatePointerEvents(),
    updatePileContainerWidth: () => updatePileContainerWidth(),
    getAlwaysShowPile: () => pilePrefsApi.getAlwaysShowPile(),
    shouldPileBeVisible: () => pilePrefsApi.shouldPileBeVisible(),
    isContextMenuVisible: () => isContextMenuVisible()
  });

  maskRepairApi = window.zenStuffPileMaskRepair.createMaskRepairApi({
    state,
    debugLog,
    getVisibilityApi: () => pileVisibilityApi,
    updatePointerEvents: () => pilePrefsApi.updatePointerEvents(),
    updatePileHeight: () => updatePileHeight(),
    isContextMenuVisible: () => isContextMenuVisible(),
    getAlwaysShowPile: () => pilePrefsApi.getAlwaysShowPile(),
    generateGridPosition,
    applyGridPosition,
    updatePodTextColors: () => themeColorsApi.updatePodTextColors()
  });

  pilePrefsApi = window.zenStuffPilePrefs.createPilePrefsApi({
    state,
    debugLog,
    getShowPile: () => pileVisibilityApi.showPile(),
    getHidePile: () => pileVisibilityApi.hidePile(),
    schedulePileLayoutRepair: (source, delayMs) => maskRepairApi.schedulePileLayoutRepair(source, delayMs)
  });

  sessionApi = window.zenStuffSession.createSessionApi({
    debugLog,
    validateFilePathOrThrow,
    FileSystem,
    state,
    addPodToPile: (podData, animate) => pileVisibilityApi.addPodToPile(podData, animate),
    updatePileVisibility,
    updateDownloadsButtonVisibility: () => pilePrefsApi.updateDownloadsButtonVisibility(),
    getAlwaysShowPile: () => pilePrefsApi.getAlwaysShowPile(),
    shouldPileBeVisible: () => pilePrefsApi.shouldPileBeVisible(),
    showPile
  });

  /** Tidy Downloads: skip sticky toolbar pod while pile is expanded (hover OR pinned/always-show), or while the user hovers the library/downloads button. */
  function isPileCurrentlyExpanded() {
    return !!(state.dynamicSizer && state.dynamicSizer.style.height && state.dynamicSizer.style.height !== "0px");
  }
  window.__zenDismissedPileIntegration = {
    isHoveringPileArea: () => pileVisibilityApi?.isHoveringPileArea?.() === true,
    isPileExpanded: () => isPileCurrentlyExpanded(),
    shouldSuppressStickyPod: () =>
      isPileCurrentlyExpanded() ||
      pileVisibilityApi?.isHoveringPileArea?.() === true ||
      state.downloadButton?.matches(":hover") === true
  };

  function schedulePileLayoutRepair(source, delayMs = 80) {
    return maskRepairApi.schedulePileLayoutRepair(source, delayMs);
  }

  function recalculateLayout() {
    return maskRepairApi.recalculateLayout();
  }

  function attachMediaToolbarResizeObserverOnce() {
    if (state.mediaToolbarResizeObserver) return;
    const mt = document.getElementById("zen-media-controls-toolbar");
    if (!mt || typeof ResizeObserver === "undefined") return;
    state.mediaToolbarResizeObserver = new ResizeObserver(() => {
      if (
        state.dismissedPods.size > 0 &&
        state.dynamicSizer &&
        state.dynamicSizer.style.height !== "0px"
      ) {
        schedulePileLayoutRepair("media-toolbar-resize", 40);
      }
    });
    state.mediaToolbarResizeObserver.observe(mt);
    debugLog("[PileRepair] ResizeObserver attached to zen-media-controls-toolbar");
  }

  /**
   * Window/document listeners and timers — must run only once per browser window so init retries
   * (after partial failures) do not stack duplicate callbacks on zenTidyDownloads or document.
   */
  function setupGlobalPileListeners() {
    if (state.zenStuffGlobalPileListenersAttached) {
      return;
    }
    state.zenStuffGlobalPileListenersAttached = true;

    window.zenTidyDownloads.onPodDismissed((podData) => {
      debugLog("Received pod dismissal:", podData);
      addPodToPile(podData);
    });

    document.addEventListener("pod-dismissed-updated", (ev) => {
      try {
        const d = ev?.detail;
        if (!d || typeof d !== "object") return;
        const { oldKey, newKey, podData } = d;
        if (oldKey && state.dismissedPods.has(oldKey)) {
          removePodFromPile(oldKey);
        }
        if (podData && newKey) {
          addPodToPile(podData, false);
        }
      } catch (err) {
        debugLog("[Pile] pod-dismissed-updated handler error", err);
      }
    });

    if (typeof window.zenTidyDownloads.onProgressPilePod === "function") {
      window.zenTidyDownloads.onProgressPilePod((msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.kind === "rekey" && msg.oldKey && msg.podData) {
          removePodFromPile(msg.oldKey);
          addPodToPile(msg.podData);
          return;
        }
        if (msg.kind === "upsert" && msg.podData) {
          addPodToPile(msg.podData);
        }
      });
      debugLog("[Pile] Registered onProgressPilePod listener");
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);

    pilePrefsApi.setupPreferenceListener();

    window.addEventListener("resize", debounce(recalculateLayout, 250));

    document.addEventListener("zen-tidy-library-pie-updated", () => {
      try {
        if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
          pileVisibilityApi?.syncLibraryPieDockForPile?.();
        }
      } catch (_e) {
        /* ignore */
      }
    });

    if (window.zenTidyDownloads && typeof window.zenTidyDownloads.onActualDownloadRemoved === "function") {
      window.zenTidyDownloads.onActualDownloadRemoved((removedKey) => {
        debugLog(`[PileSync] Received actual download removal notification for key: ${removedKey}`);
        if (state.dismissedPods.has(removedKey)) {
          removePodFromPile(removedKey);
          debugLog(`[PileSync] Removed pod ${removedKey} from pile as it was cleared from Firefox list.`);
        }
      });
      debugLog("[PileSync] Registered listener for actual download removals.");
    } else {
      debugLog("[PileSync] Could not register listener for actual download removals - API not found on main script.");
    }

    document.addEventListener("request-pile-expand", () => {
      pileHoverDebug("request-pile-expand fired", { dismissedPods: state.dismissedPods.size });
      if (state.dismissedPods.size > 0) {
        pileHoverDebug("request-pile-expand → showPile");
        showPile();
        maskRepairApi.showPileBackground();
        schedulePileLayoutRepair("request-pile-expand", 60);
      } else {
        pileHoverDebug("request-pile-expand no-op: dismissedPods empty");
      }
    });

    document.addEventListener("click", (e) => {
      if (window.zenPileContextMenu && !window.zenPileContextMenu.contextMenu.contains(e.target)) {
        hideContextMenu();
      }
    });

    if (state.pileLayoutRepairIntervalId) {
      clearInterval(state.pileLayoutRepairIntervalId);
    }
    state.pileLayoutRepairIntervalId = setInterval(() => {
      if (state.dismissedPods.size > 0) {
        schedulePileLayoutRepair("interval", 0);
      }
    }, 90000);

    attachMediaToolbarResizeObserverOnce();

    debugLog("Global pile listeners attached (once per window)");
  }

  /**
   * Hover listeners on the current download button and pile DOM — run after each pile container build.
   */
  function setupDomPileHoverListeners() {
    const prevBtn = state.pileHoverDownloadButtonEl;
    if (prevBtn && prevBtn !== state.downloadButton) {
      prevBtn.removeEventListener("mouseenter", handleDownloadButtonHover);
      prevBtn.removeEventListener("mouseleave", handleDownloadButtonLeave);
    }
    if (state.downloadButton) {
      state.downloadButton.removeEventListener("mouseenter", handleDownloadButtonHover);
      state.downloadButton.removeEventListener("mouseleave", handleDownloadButtonLeave);
      state.downloadButton.addEventListener("mouseenter", handleDownloadButtonHover);
      state.downloadButton.addEventListener("mouseleave", handleDownloadButtonLeave);
      state.pileHoverDownloadButtonEl = state.downloadButton;
      pileHoverDebug("download button hover listeners attached", {
        tag: state.downloadButton.tagName,
        id: state.downloadButton.id,
        localName: state.downloadButton.localName
      });
    } else {
      pileHoverDebug("WARNING: no download button — library hover will never fire");
      state.pileHoverDownloadButtonEl = null;
    }

    if (state.dynamicSizer) {
      state.dynamicSizer.addEventListener("mouseenter", handleDynamicSizerHover);
      state.dynamicSizer.addEventListener("mouseleave", handleDynamicSizerLeave);
      debugLog("Added hover listeners to dynamic sizer");
    }

    if (state.pileContainer) {
      state.pileContainer.addEventListener("mouseenter", handlePileHover);
      state.pileContainer.addEventListener("mouseleave", handlePileLeave);
    }

    debugLog("DOM pile hover listeners attached");
  }

  function setupEventListeners() {
    setupGlobalPileListeners();
    setupDomPileHoverListeners();
    debugLog("Event listeners setup complete");
  }

  // Load any existing dismissed pods from main script
  function loadExistingDismissedPods() {
    const existingPods = window.zenTidyDownloads.dismissedPods.getAll();
    existingPods.forEach((podData, key) => {
      addPodToPile(podData, false); // Don't animate existing pods
    });
    debugLog(`Loaded ${existingPods.size} existing dismissed pods`);

    // Restore dismissed pods from SessionStore
    restoreDismissedPodsFromSession();

    // If always-show mode is enabled and we have pods (including session-only restores), show the pile
    if (pilePrefsApi.getAlwaysShowPile() && state.dismissedPods.size > 0) {
      setTimeout(() => {
        if (pilePrefsApi.shouldPileBeVisible()) {
          showPile();
          debugLog("[AlwaysShow] Showing pile on startup - always-show mode enabled");
        }
      }, 100); // Small delay to ensure DOM is ready
    }
  }

  // Add a pod to the pile
  function addPodToPile(podData, animate = true) {
    return pileVisibilityApi.addPodToPile(podData, animate);
  }

  // Remove a pod from the pile
  function removePodFromPile(podKey) {
    return pileVisibilityApi.removePodFromPile(podKey);
  }

  // Update pile visibility based on pod count
  function updatePileVisibility(shouldAnimate = false) {
    return pileVisibilityApi.updatePileVisibility(shouldAnimate);
  }

  // Update pile height dynamically based on current pod count (max 4)
  function updatePileHeight() {
    return pileVisibilityApi.updatePileHeight();
  }

  // Download button hover handler
  function handleDownloadButtonHover() {
    return pileVisibilityApi.handleDownloadButtonHover();
  }

  // Download button leave handler
  function handleDownloadButtonLeave() {
    return pileVisibilityApi.handleDownloadButtonLeave();
  }

  // Dynamic sizer hover handler
  function handleDynamicSizerHover() {
    return pileVisibilityApi.handleDynamicSizerHover();
  }

  // Dynamic sizer leave handler
  function handleDynamicSizerLeave(event) {
    return pileVisibilityApi.handleDynamicSizerLeave(event);
  }

  // Pile hover handler (simplified - no mode transitions)
  function handlePileHover() {
    return pileVisibilityApi.handlePileHover();
  }

  // Pile leave handler (simplified)
  function handlePileLeave(event) {
    return pileVisibilityApi.handlePileLeave(event);
  }

  // Show the pile
  function showPile() {
    return pileVisibilityApi.showPile();
  }

  // Hide the pile
  function hidePile() {
    return pileVisibilityApi.hidePile();
  }

  // Check if main download script has active pods to disable hover
  function shouldDisableHover() {
    return pileVisibilityApi.shouldDisableHover();
  }

  // applyTabsWrapperMask and removeTabsWrapperMask function removed - logic replaced by CSS mask-image with --zen-pile-height variable

  // Helper: is cursor over pile area (including bridge between button and pile)
  function isHoveringPileArea() {
    return pileVisibilityApi.isHoveringPileArea();
  }

  // Alt key handlers for always-show mode
  function handleKeyDown(event) {
    if (event.key === 'Alt' && !state.isAltPressed) {
      state.isAltPressed = true;
      debugLog("[AlwaysShow] Alt key pressed");

      if (pilePrefsApi.getAlwaysShowPile() && state.dismissedPods.size > 0) {
        // Hide pile when Alt is pressed in always-show mode
        hidePile();
      }
    }
  }

  function handleKeyUp(event) {
    if (event.key === 'Alt' && state.isAltPressed) {
      state.isAltPressed = false;
      debugLog("[AlwaysShow] Alt key released");

      if (pilePrefsApi.getAlwaysShowPile() && state.dismissedPods.size > 0) {
        // Show pile again when Alt is released in always-show mode
        showPile();
      }
    }
  }

  // Cleanup function to prevent memory leaks
  function cleanup() {
    debugLog("Cleaning up dismissed downloads pile system");

    try {
      // Clear all timeouts
      if (state.hoverTimeout) {
        clearTimeout(state.hoverTimeout);
        state.hoverTimeout = null;
      }
      if (state.pileRepairDebounceId) {
        clearTimeout(state.pileRepairDebounceId);
        state.pileRepairDebounceId = null;
      }
      if (state.pileLayoutRepairIntervalId) {
        clearInterval(state.pileLayoutRepairIntervalId);
        state.pileLayoutRepairIntervalId = null;
      }

      if (state.mediaToolbarResizeObserver) {
        try {
          state.mediaToolbarResizeObserver.disconnect();
        } catch (_e) {
          /* ignore */
        }
        state.mediaToolbarResizeObserver = null;
      }

      // Remove all event listeners
      EventManager.cleanupAll();

      // Remove preference observer
      if (state.prefObserver) {
        try {
          Services.prefs.removeObserver(window.zenStuffPilePrefs.PREFS.alwaysShowPile, state.prefObserver);
        } catch (error) {
          console.warn('[Cleanup] Error removing preference observers:', error);
        }
        state.prefObserver = null;
      }

      // Remove DOM elements (bridge is not inside dynamicSizer — remove both)
      if (state.hoverBridge && state.hoverBridge.parentNode) {
        state.hoverBridge.parentNode.removeChild(state.hoverBridge);
      }
      state.hoverBridge = null;
      if (state.dynamicSizer && state.dynamicSizer.parentNode) {
        state.dynamicSizer.parentNode.removeChild(state.dynamicSizer);
      }
      state.dynamicSizer = null;

      // Clear all state
      state.clearAll();
      state.isInitialized = false;

      fileOpsApi?.clearGlobalMenuRef();

      debugLog("Cleanup completed successfully");
    } catch (error) {
      ErrorHandler.handleError(error, 'cleanup');
    }
  }

  fileOpsApi = window.zenStuffContextFileOps.createContextFileOpsApi({
    state,
    CONFIG,
    debugLog,
    FileSystem,
    ErrorHandler,
    validatePodData,
    removePodFromPile,
    generateGridPosition,
    applyGridPosition,
    hidePile,
    showPile,
    getAlwaysShowPile: () => pilePrefsApi.getAlwaysShowPile(),
    shouldDisableHover,
    isHoveringPileArea,
    saveDismissedPodToSession,
    schedulePileLayoutRepair,
    updatePileVisibility,
    updateDownloadsButtonVisibility: () => pilePrefsApi.updateDownloadsButtonVisibility()
  });

  function isContextMenuVisible() {
    return fileOpsApi ? fileOpsApi.isContextMenuVisible() : false;
  }

  function hideContextMenu() {
    try {
      fileOpsApi?.hideContextMenu();
    } catch (_e) {}
  }

  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init, { once: true });
  }

  window.addEventListener("beforeunload", cleanup, { once: true });

  debugLog("Dismissed downloads pile script loaded");

  // Store previous grid positions for each pod
  if (!state._prevGridPositions) state._prevGridPositions = new Map();
})();
