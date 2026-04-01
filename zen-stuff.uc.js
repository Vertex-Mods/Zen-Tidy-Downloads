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
      "[Zen Stuff] Required modules missing (zen-stuff-session, zen-stuff-pile-dom, zen-stuff-pod-element, zen-stuff-pile-layout, zen-stuff-context-fileops, zen-stuff-pile-visibility, zen-stuff-pile-prefs, zen-stuff-pile-theme-colors, zen-stuff-pile-mask-repair)"
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
    waitForElement,
    TEXT_EXTENSIONS,
    SYSTEM_ICON_EXTENSIONS,
    readTextFilePreview,
    filenameEndsWithExtensionFromSet
  } = Utils;

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

  // Centralized state management
  class PileState {
    constructor() {
      this.downloadButton = null;
      this.pileContainer = null;
      this.dynamicSizer = null;
      this.hoverBridge = null;
      // Removed isGridMode - always single column mode
      this.hoverTimeout = null;
      this.dismissedPods = new Map(); // podKey -> podData
      this.podElements = new Map(); // podKey -> DOM element
      this.pilePositions = new Map(); // podKey -> {x, y, rotation, zIndex}
      this.gridPositions = new Map(); // podKey -> {x, y, row, col}
      this.isInitialized = false;
      this.isTransitioning = false;
      this.isAltPressed = false;
      this.currentZenSidebarWidthForPile = '';
      this.retryCount = 0;
      this.eventListeners = new Map(); // Track event listeners for cleanup
      this.prefObserver = null;
      // --- add pendingPileClose flag ---
      this.pendingPileClose = false;
      // --- add gridScrollIndex for grid windowing ---
      this.gridScrollIndex = 0;
      // --- add visibleGridOrder for carousel ---
      this.visibleGridOrder = [];
      // --- add carouselStartIndex for >6 pods ---
      this.carouselStartIndex = 0;
      // --- add isGridAnimating flag ---
      this.isGridAnimating = false;
      // --- add workspaceScrollboxStyle for controlling ::after opacity ---
      this.workspaceScrollboxStyle = null;
      // --- add isEditing flag to prevent pile from hiding during rename ---
      this.isEditing = false;
      // --- add recentlyRemoved flag to prevent pile from hiding immediately after removal ---
      this.recentlyRemoved = false;
      // --- add mediaToolbarMaskRemovalTimeout for delayed mask removal on pile collapse ---
      this.mediaToolbarMaskRemovalTimeout = null;
      // --- true from row contextmenu until popuphidden (covers gap before menupopup.state === 'open') ---
      this.pileContextMenuActive = false;
      // --- sticky / mask layout repair (coalesced) ---
      this.pileRepairDebounceId = null;
      this.lastPileRepairAt = 0;
      this.pileLayoutRepairIntervalId = null;
    }

    // Safe getters with validation
    getPodData(key) {
      return this.dismissedPods.get(key) || null;
    }

    getPodElement(key) {
      return this.podElements.get(key) || null;
    }

    getPilePosition(key) {
      return this.pilePositions.get(key) || null;
    }

    getGridPosition(key) {
      return this.gridPositions.get(key) || null;
    }

    // Safe setters with validation
    setPodData(key, data) {
      if (key && data) {
        this.dismissedPods.set(key, data);
      }
    }

    setPodElement(key, element) {
      if (key && element) {
        this.podElements.set(key, element);
      }
    }

    // Cleanup methods
    removePod(key) {
      this.dismissedPods.delete(key);
      this.podElements.delete(key);
      this.pilePositions.delete(key);
      this.gridPositions.delete(key);
    }

    clearAll() {
      this.dismissedPods.clear();
      this.podElements.clear();
      this.pilePositions.clear();
      this.gridPositions.clear();
    }
  }

  // Global state instance
  const state = new PileState();

  /** @type {ReturnType<typeof window.zenStuffContextFileOps.createContextFileOpsApi>|null} */
  let fileOpsApi = null;
  /** @type {ReturnType<typeof window.zenStuffPileVisibility.createPileVisibilityApi>|null} */
  let pileVisibilityApi = null;
  /** @type {ReturnType<typeof window.zenStuffPileMaskRepair.createMaskRepairApi>|null} */
  let maskRepairApi = null;
  /** @type {ReturnType<typeof window.zenStuffPilePrefs.createPilePrefsApi>|null} */
  let pilePrefsApi = null;

  // Error handling utilities (validateFilePath, validatePodData: see tidy-downloads-utils.uc.js)
  class ErrorHandler {
    static handleError(error, context, fallback = null) {
      console.error(`[Dismissed Pile] Error in ${context}:`, error);
      return fallback;
    }

    static async withRetry(operation, maxAttempts = 3, delay = 1000) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await operation();
        } catch (error) {
          if (attempt === maxAttempts) {
            throw error;
          }
          console.warn(`[Dismissed Pile] Attempt ${attempt} failed, retrying in ${delay}ms:`, error);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }

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

  // File system utilities with proper error handling
  class FileSystem {
    static async createFileInstance(path) {
      try {
        const validatedPath = validateFilePathOrThrow(path);
        const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
        file.initWithPath(validatedPath);
        return file;
      } catch (error) {
        throw new Error(`Failed to create file instance: ${error.message}`);
      }
    }

    static async fileExists(path) {
      try {
        const file = await this.createFileInstance(path);
        return file.exists();
      } catch (error) {
        console.warn(`[FileSystem] Error checking file existence: ${error.message}`);
        return false;
      }
    }

    static async getParentDirectory(path) {
      try {
        const file = await this.createFileInstance(path);
        return file.parent;
      } catch (error) {
        throw new Error(`Failed to get parent directory: ${error.message}`);
      }
    }

    // Auto-increment filename if duplicate exists
    static async getAvailableFilename(parentDir, baseName, ext) {
      let candidate = baseName + ext;
      let counter = 1;
      let file = parentDir.clone();
      file.append(candidate);
      while (file.exists()) {
        candidate = `${baseName} (${counter})${ext}`;
        file = parentDir.clone();
        file.append(candidate);
        counter++;
      }
      return candidate;
    }

    static async renameFile(oldPath, newFilename) {
      try {
        const oldFile = await this.createFileInstance(oldPath);
        if (!oldFile.exists()) {
          throw new Error('Source file does not exist');
        }

        const parentDir = oldFile.parent;
        // Split newFilename into base and extension
        const dotIdx = newFilename.lastIndexOf('.');
        let baseName = newFilename;
        let ext = '';
        if (dotIdx > 0) {
          baseName = newFilename.substring(0, dotIdx);
          ext = newFilename.substring(dotIdx);
        }
        // Find available filename
        const availableName = await this.getAvailableFilename(parentDir, baseName, ext);
        const newFile = parentDir.clone();
        newFile.append(availableName);
        oldFile.moveTo(parentDir, availableName);
        return newFile.path;
      } catch (error) {
        throw new Error(`Failed to rename file: ${error.message}`);
      }
    }

    static async deleteFile(path) {
      try {
        const file = await this.createFileInstance(path);
        if (file.exists()) {
          file.remove(false); // false = don't move to trash
          return true;
        }
        return false;
      } catch (error) {
        throw new Error(`Failed to delete file: ${error.message}`);
      }
    }
  }

  // Event management with cleanup
  class EventManager {
    static addEventListener(element, event, handler, options = {}) {
      if (!element || !handler) {
        console.warn('[EventManager] Invalid element or handler for event listener');
        return;
      }

      element.addEventListener(event, handler, options);

      // Track for cleanup
      const key = `${element.id || 'unknown'}-${event}`;
      if (!state.eventListeners.has(key)) {
        state.eventListeners.set(key, []);
      }
      state.eventListeners.get(key).push({ element, event, handler, options });
    }

    static removeEventListener(element, event, handler) {
      if (!element || !handler) return;

      element.removeEventListener(event, handler);

      // Remove from tracking
      const key = `${element.id || 'unknown'}-${event}`;
      const listeners = state.eventListeners.get(key);
      if (listeners) {
        const index = listeners.findIndex(l => l.handler === handler);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      }
    }

    static cleanupAll() {
      for (const [key, listeners] of state.eventListeners) {
        for (const { element, event, handler } of listeners) {
          try {
            element.removeEventListener(event, handler);
          } catch (error) {
            console.warn(`[EventManager] Error removing event listener: ${error.message}`);
          }
        }
      }
      state.eventListeners.clear();
    }
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

  // Debug function to test preference (call from browser console)
  window.testLibraryButtonPref = function() {
    console.log("=== Testing Library Button Preference ===");
    console.log(`Preference name: ${window.zenStuffPilePrefs.PREFS.useLibraryButton}`);
    
    try {
      const value = Services.prefs.getBoolPref(window.zenStuffPilePrefs.PREFS.useLibraryButton, false);
      console.log(`Current preference value: ${value}`);
    } catch (e) {
      console.log(`Error reading preference:`, e);
    }
    
    const libraryBtn = document.getElementById('zen-library-button');
    const downloadsBtn = document.getElementById('downloads-button');
    console.log(`zen-library-button exists: ${!!libraryBtn}`);
    console.log(`downloads-button exists: ${!!downloadsBtn}`);
    console.log(`Current state.downloadButton:`, state.downloadButton);
    
    // Test waiting for zen-library-button
    console.log("Testing waitForElement for zen-library-button...");
    waitForElement('zen-library-button', 3000).then(element => {
      console.log(`waitForElement result:`, element);
    });
    
    // Test re-finding the button
    console.log("Re-finding button...");
    findDownloadButton().then(() => {
      console.log(`After re-find, state.downloadButton:`, state.downloadButton);
    }).catch(e => console.error("Error re-finding:", e));
  };

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

  // Find the Firefox downloads button with better error handling and retry for custom buttons
  async function findDownloadButton() {
    try {
      // Always try zen-library-button first (auto-detect), regardless of preference.
      // This ensures hover works correctly when zen-library-button replaces the downloads button.
      console.log(`[Zen Stuff] Auto-detecting download button (trying zen-library-button first)...`);
      const libraryButton = await waitForElement('zen-library-button', 2000);

      if (libraryButton) {
        console.log("[Zen Stuff] ✅ Found zen-library-button for hover detection (auto-detected)");
        debugLog("Found zen-library-button for hover detection (auto-detected)");
        state.downloadButton = libraryButton;
        return;
      }
      console.log("[Zen Stuff] zen-library-button not found, trying downloads button...");
      debugLog("zen-library-button not found, falling back to downloads button");
      
      // Optimized selector order - most common first
      const selectors = [
        '#downloads-button',
        '#downloads-indicator',
        '[data-l10n-id="downloads-button"]',
        '.toolbarbutton-1[command="Tools:Downloads"]'
      ];

      for (const selector of selectors) {
        try {
          state.downloadButton = document.querySelector(selector);
          if (state.downloadButton) {
            console.log(`[Zen Stuff] ✅ Found download button using selector: ${selector}`, state.downloadButton);
            debugLog(`Found download button using selector: ${selector}`);
            return;
          }
        } catch (error) {
          console.warn(`[DownloadButton] Error with selector ${selector}:`, error);
        }
      }

      // Fallback: look for any element with downloads-related attributes
      try {
        const fallbackElements = document.querySelectorAll('[id*="download"], [class*="download"]');
        for (const element of fallbackElements) {
          if (element.getAttribute('command')?.includes('Downloads') ||
            element.textContent?.toLowerCase().includes('download')) {
            state.downloadButton = element;
            debugLog("Found download button using fallback method", element);
            return;
          }
        }
      } catch (error) {
        console.warn('[DownloadButton] Error in fallback search:', error);
      }

      throw new Error("Download button not found after all attempts");
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
    findDownloadButton
  });

  sessionApi = window.zenStuffSession.createSessionApi({
    debugLog,
    validateFilePathOrThrow,
    FileSystem,
    state,
    createPodElement,
    generateGridPosition,
    applyGridPosition,
    updatePileVisibility,
    updateDownloadsButtonVisibility: () => pilePrefsApi.updateDownloadsButtonVisibility(),
    getAlwaysShowPile: () => pilePrefsApi.getAlwaysShowPile(),
    shouldPileBeVisible: () => pilePrefsApi.shouldPileBeVisible(),
    showPile
  });

  function schedulePileLayoutRepair(source, delayMs = 80) {
    return maskRepairApi.schedulePileLayoutRepair(source, delayMs);
  }

  function recalculateLayout() {
    return maskRepairApi.recalculateLayout();
  }

  // Setup event listeners
  function setupEventListeners() {
    // Listen for pod dismissals from main script
    window.zenTidyDownloads.onPodDismissed((podData) => {
      debugLog("Received pod dismissal:", podData);
      addPodToPile(podData);
    });

    // Download button hover events
    if (state.downloadButton) {
      state.downloadButton.addEventListener('mouseenter', handleDownloadButtonHover);
      state.downloadButton.addEventListener('mouseleave', handleDownloadButtonLeave);
    }

    // Dynamic sizer hover events (keep container open when cursor is inside)
    if (state.dynamicSizer) {
      state.dynamicSizer.addEventListener('mouseenter', handleDynamicSizerHover);
      state.dynamicSizer.addEventListener('mouseleave', handleDynamicSizerLeave);
      debugLog("Added hover listeners to dynamic sizer");
    }

    // Pile container hover events
    state.pileContainer.addEventListener('mouseenter', handlePileHover);
    state.pileContainer.addEventListener('mouseleave', handlePileLeave);

    // Alt key listeners for always-show mode
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    // Preference change listener
    pilePrefsApi.setupPreferenceListener();

    // Window resize handler
    window.addEventListener('resize', debounce(recalculateLayout, 250));

    // Listen for actual download removals from Firefox list (via main script)
    if (window.zenTidyDownloads && typeof window.zenTidyDownloads.onActualDownloadRemoved === 'function') {
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

    // Sticky pod hover: expand pile when user hovers over a sticky pod
    document.addEventListener('request-pile-expand', () => {
      if (state.dismissedPods.size > 0) {
        showPile();
        maskRepairApi.showPileBackground();
        schedulePileLayoutRepair("request-pile-expand", 60);
      }
    });

    // Context menu click-outside handler
    document.addEventListener('click', (e) => {
      if (window.zenPileContextMenu &&
        !window.zenPileContextMenu.contextMenu.contains(e.target)) {
        hideContextMenu();
      }
    });

    // Periodic cheap repair: mask/sizer can desync after sticky transitions or toolbar reflow
    if (state.pileLayoutRepairIntervalId) {
      clearInterval(state.pileLayoutRepairIntervalId);
    }
    state.pileLayoutRepairIntervalId = setInterval(() => {
      if (state.dismissedPods.size > 0) {
        schedulePileLayoutRepair("interval", 0);
      }
    }, 90000);

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

    // If always-show mode is enabled and we have pods, show the pile
    if (pilePrefsApi.getAlwaysShowPile() && existingPods.size > 0) {
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

  // Update pile position relative to download button
  function updatePilePosition() {
    // This function is largely obsolete as the pile is now in-flow within dynamicSizer.
    // Width will be handled by updatePileContainerWidth.
    // Height will be handled by showPile/hidePile.
    debugLog("updatePilePosition called, but largely obsolete now.");
    // If dynamicSizer exists and we need to ensure its width is up-to-date:
    if (typeof updatePileContainerWidth === 'function') {
      // updatePileContainerWidth(); // Call this if needed, but it's called on showPile
    }
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

      // Remove all event listeners
      EventManager.cleanupAll();

      // Remove preference observer
      if (state.prefObserver) {
        try {
          Services.prefs.removeObserver(window.zenStuffPilePrefs.PREFS.alwaysShowPile, state.prefObserver);
          Services.prefs.removeObserver(window.zenStuffPilePrefs.PREFS.useLibraryButton, state.prefObserver);
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

  /* Add CSS for flyout/flyin animations */
  const zenFlyAnimStyle = document.createElement('style');
  zenFlyAnimStyle.textContent = `
  .zen-flyin-right {
    animation: zen-flyin-right 0.4s cubic-bezier(0.4,0,0.2,1) both;
  }
  .zen-flyin-left {
    animation: zen-flyin-left 0.4s cubic-bezier(0.4,0,0.2,1) both;
  }
  .zen-flyout-right {
    animation: zen-flyout-right 0.4s cubic-bezier(0.4,0,0.2,1) both;
  }
  .zen-flyout-left {
    animation: zen-flyout-left 0.4s cubic-bezier(0.4,0,0.2,1) both;
  }
  @keyframes zen-flyin-right {
    from { transform: translateX(60px); }
    to   { transform: none; }
  }
  @keyframes zen-flyin-left {
    from { transform: translateX(-60px); }
    to   { transform: none; }
  }
  @keyframes zen-flyout-right {
    from { transform: none; }
    to   { transform: translateX(60px); }
  }
  @keyframes zen-flyout-left {
    from { transform: none; }
    to   { transform: translateX(-60px); }
  }
  `;
  document.head.appendChild(zenFlyAnimStyle);

  // Store previous grid positions for each pod
  if (!state._prevGridPositions) state._prevGridPositions = new Map();
})();
