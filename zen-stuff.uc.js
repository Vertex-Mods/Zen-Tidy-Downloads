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
    !window.zenStuffPileLayout?.createPileLayoutApi
  ) {
    console.error(
      "[Zen Stuff] Required modules missing (zen-stuff-session, zen-stuff-pile-dom, zen-stuff-pod-element, zen-stuff-pile-layout)"
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

  // Firefox preferences
  const PREFS = {
    alwaysShowPile: 'zen.stuff-pile.always-show', // Boolean: show pile always (hide with Alt key)
    useLibraryButton: 'zen.tidy-downloads.use-library-button', // Boolean: use zen-library-button instead of downloads-button
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
        openPodFile,
        showPodFileInExplorer,
        ensurePodContextMenu,
        getPodContextMenu: () => podContextMenu,
        setPodContextMenuPodData: (d) => {
          podContextMenuPodData = d;
        }
      });
    }
    return zenStuffPodElementImpl.createPodElement(podData);
  }

  // Debug function to test preference (call from browser console)
  window.testLibraryButtonPref = function() {
    console.log("=== Testing Library Button Preference ===");
    console.log(`Preference name: ${PREFS.useLibraryButton}`);
    
    try {
      const value = Services.prefs.getBoolPref(PREFS.useLibraryButton, false);
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

  const sessionApi = window.zenStuffSession.createSessionApi({
    debugLog,
    validateFilePathOrThrow,
    FileSystem,
    state,
    createPodElement,
    generateGridPosition,
    applyGridPosition,
    updatePileVisibility,
    updateDownloadsButtonVisibility,
    getAlwaysShowPile,
    shouldPileBeVisible,
    showPile
  });

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
    setupPileBackgroundHoverEvents,
    setupCompactModeObserver
  });

  async function createPileContainer() {
    await pileDomApi.createPileContainer();
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
    setupPreferenceListener();

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
        showPileBackground();
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
    if (getAlwaysShowPile() && existingPods.size > 0) {
      setTimeout(() => {
        if (shouldPileBeVisible()) {
          showPile();
          debugLog("[AlwaysShow] Showing pile on startup - always-show mode enabled");
        }
      }, 100); // Small delay to ensure DOM is ready
    }
  }

  // Add a pod to the pile
  function addPodToPile(podData, animate = true) {
    if (!podData || !podData.key) {
      debugLog("Invalid pod data for pile addition");
      return;
    }

    // Limit to 4 most recent pods
    if (state.dismissedPods.size >= 4) {
      const oldestKey = Array.from(state.dismissedPods.keys())[0];
      removePodFromPile(oldestKey);
    }

    // Store pod data
    state.dismissedPods.set(podData.key, podData);

    // Save to SessionStore for persistence
    saveDismissedPodToSession(podData);

    // Update the list of pod keys in SessionStore
    updatePodKeysInSession();

    // Create DOM element
    const podElement = createPodElement(podData);
    state.podElements.set(podData.key, podElement);
    state.pileContainer.appendChild(podElement);

    // Generate position for single column layout
    generateGridPosition(podData.key);

    // Update downloads button visibility
    updateDownloadsButtonVisibility();

    // Single owner for first-pod layout/animation: showPile().
    // Avoid pre-applying final transforms before showPile runs, or the initial entry
    // transition can be consumed on cold start.
    if (shouldPileBeVisible()) {
      showPile();
      // Update text colors after showing pile
      setTimeout(() => {
        updatePodTextColors();
      }, 50);
    } else {
      // Keep internal layout state in sync when pile should remain hidden.
      updatePileVisibility(animate);
    }

    schedulePileLayoutRepair("add-pod", 120);

    debugLog(`Added pod to pile: ${podData.filename}`);
  }

  // Remove a pod from the pile
  function removePodFromPile(podKey) {
    const podElement = state.podElements.get(podKey);
    const wasVisible = state.dynamicSizer && state.dynamicSizer.style.height !== '0px';
    
    if (podElement) {
      // Set lower z-index and disable pointer events to prevent overlap during animation
      podElement.style.zIndex = '0';
      podElement.style.pointerEvents = 'none';
      
      // Animate out using transform and opacity only
      requestAnimationFrame(() => {
        podElement.style.transition = `opacity ${CONFIG.animationDuration}ms ease, transform ${CONFIG.animationDuration}ms ease`;
        
        // Preserve current position but scale down
        const position = state.gridPositions.get(podKey);
        if (position) {
             const rowHeight = 48;
             const rowSpacing = 6;
             const baseBottomOffset = 8;
             const bottomOffset = baseBottomOffset + (position.row * (rowHeight + rowSpacing));
             podElement.style.transform = `translate3d(0, -${bottomOffset}px, 0) scale(0.8)`;
        } else {
             podElement.style.transform = 'scale(0.8)';
        }
        
        podElement.style.opacity = '0';
      });

      setTimeout(() => {
        if (podElement.parentNode) {
          podElement.parentNode.removeChild(podElement);
        }
      }, CONFIG.animationDuration);
    }

    state.dismissedPods.delete(podKey);
    state.podElements.delete(podKey);
    state.pilePositions.delete(podKey);
    state.gridPositions.delete(podKey);

    // Remove from SessionStore
    removeDismissedPodFromSession(podKey);

    // Update the list of pod keys in SessionStore
    updatePodKeysInSession();

    // Clear any pending hide timeout to prevent pile from hiding too quickly after removal
    if (state.hoverTimeout) {
      clearTimeout(state.hoverTimeout);
      state.hoverTimeout = null;
    }

    // Set flag to prevent pile from hiding immediately after removal
    state.recentlyRemoved = true;

    // Recalculate grid positions for remaining pods
    state.dismissedPods.forEach((_, key) => generateGridPosition(key));

    // If pile was visible, animate remaining pods to new positions
    // Wait for removal animation to fully complete before repositioning to avoid overlap
    if (wasVisible && state.dismissedPods.size > 0) {
      // Ensure pile stays visible during and after removal animation
      showPile();
      
      const removalDelay = CONFIG.animationDuration + 50;
      setTimeout(() => {
        updatePileVisibility(true); // Pass true to indicate we should animate
        // Update downloads button visibility
        updateDownloadsButtonVisibility();
        
        // Clear the flag after repositioning animation completes + grace period
        setTimeout(() => {
          state.recentlyRemoved = false;
          debugLog("[RemovePod] Cleared recentlyRemoved flag - pile can now hide normally");
          
          // After clearing the flag, check if we should hide the pile
          // (if user is not hovering and not in always-show mode)
          if (!getAlwaysShowPile() && !shouldDisableHover()) {
            const isHoveringDownloadArea = state.downloadButton?.matches(':hover');
            const isHoveringPile = isHoveringPileArea();

            if (!isHoveringDownloadArea && !isHoveringPile) {
              // Start the hide timeout
              clearTimeout(state.hoverTimeout);
              state.hoverTimeout = setTimeout(() => {
                hidePile();
              }, CONFIG.hoverDebounceMs);
            }
          }
        }, removalDelay); // Wait for repositioning animation
      }, removalDelay); // Wait for full fade-out
    } else {
      // updatePileVisibility will handle sizer height if needed
      updatePileVisibility(); // This will now call showPile/hidePile which adjust sizer
      // Update downloads button visibility
      updateDownloadsButtonVisibility();
      // Clear the flag since pile is now empty
      state.recentlyRemoved = false;
    }
  }

  // Update pile visibility based on pod count
  function updatePileVisibility(shouldAnimate = false) {
    if (state.dismissedPods.size === 0) {
      // If pile becomes empty, hide it (will set sizer height to 0)
      if (state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
        hidePile();
      }
    } else {
      // Show only the 4 most recent pods
      const allPods = Array.from(state.dismissedPods.keys());
      const recentPods = allPods.slice(-4); // Get last 4 pods (most recent)

      // Regenerate positions for all pods
      allPods.forEach(podKey => {
        generateGridPosition(podKey);
        // If animating (e.g., after removal), animate remaining pods to new positions
        applyGridPosition(podKey, 0, shouldAnimate);
      });

      // If pile is currently visible, recalculate height dynamically
      if (state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
        updatePileHeight();
      }
    }
  }

  // Update pile height dynamically based on current pod count (max 4)
  function updatePileHeight() {
    if (!state.dynamicSizer || state.dismissedPods.size === 0) return;

    const rowHeight = 48; // Height of each row (pod + text)
    const rowSpacing = 6; // Spacing between rows

    // Always show max 4 pods
    const podsToShow = Math.min(state.dismissedPods.size, 4);

    // Calculate height: (rows * row height) + spacing between rows + space below first pod
    // The baseBottomOffset in positioning creates the space, so we add it to height to accommodate it
    const baseBottomOffset = 8; // Space under first pod row (matches applyGridPosition)
    const totalRowHeight = (podsToShow * rowHeight) + ((podsToShow - 1) * rowSpacing);
    const gridHeight = totalRowHeight + baseBottomOffset;

    debugLog("Updating pile height dynamically", {
      totalPods: state.dismissedPods.size,
      podsToShow,
      oldHeight: state.dynamicSizer.style.height,
      newHeight: `${gridHeight}px`
    });

    state.dynamicSizer.style.height = `${gridHeight}px`;

    // Update the mask height variable on document root for #zen-tabs-wrapper mask
    // Subtract media toolbar height when visible so the mask accounts for its space
    const mediaToolbar = document.getElementById('zen-media-controls-toolbar');
    const mediaToolbarHeight = mediaToolbar?.getBoundingClientRect().height ?? 0;
    const pileMaskHeight = Math.max(0, gridHeight - (mediaToolbarHeight > 0 ? mediaToolbarHeight : 0));
    document.documentElement.style.setProperty('--zen-pile-height', `${pileMaskHeight}px`);
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
    debugLog("[DownloadHover] handleDownloadButtonHover called", {
      dismissedPodsSize: state.dismissedPods.size,
      shouldDisableHover: shouldDisableHover(),
      alwaysShowMode: getAlwaysShowPile()
    });

    if (state.dismissedPods.size === 0) return;

    // In always-show mode, don't handle hover events
    if (getAlwaysShowPile()) {
      debugLog("[DownloadHover] Always-show mode enabled - ignoring hover");
      return;
    }

    // Check if main download script has active pods and disable hover if so
    if (shouldDisableHover()) {
      debugLog("[HoverDisabled] Pile hover disabled - main download script has active pods");
      return;
    }

    clearTimeout(state.hoverTimeout);
    state.hoverTimeout = setTimeout(() => {
      debugLog("[DownloadHover] Timeout triggered - calling showPile()");
      showPile();
      schedulePileLayoutRepair("download-hover", 50);
    }, CONFIG.hoverDebounceMs);
  }

  // Download button leave handler
  function handleDownloadButtonLeave() {
    debugLog("[DownloadHover] handleDownloadButtonLeave called");

    // In always-show mode, don't handle hover events
    if (getAlwaysShowPile()) {
      debugLog("[DownloadHover] Always-show mode enabled - ignoring leave");
      return;
    }

    if (shouldDisableHover()) {
      return; // Don't process leave events if hover is disabled
    }

    if (isContextMenuVisible()) {
      debugLog("[DownloadHover] Context menu visible - deferring pile close");
      state.pendingPileClose = true;
      return;
    }

    clearTimeout(state.hoverTimeout);
    state.hoverTimeout = setTimeout(() => {
      const isHoveringDownloadArea = state.downloadButton?.matches(':hover');

      debugLog("[DownloadHover] Leave timeout - checking hover states", {
        isHoveringDownloadArea,
        pileContainerHover: state.pileContainer?.matches(':hover'),
        dynamicSizerHover: state.dynamicSizer?.matches(':hover')
      });

      // Only hide if cursor is not over download button AND not over pile/bridge
      if (!isHoveringDownloadArea && !isHoveringPileArea()) {
        if (isContextMenuVisible()) {
          debugLog("[DownloadHover] Context menu visible at timeout - deferring pile close");
          state.pendingPileClose = true;
        } else {
          debugLog("[DownloadHover] Calling hidePile()");
          hidePile();
        }
      }
    }, CONFIG.hoverDebounceMs);
  }

  // Dynamic sizer hover handler  
  function handleDynamicSizerHover() {
    debugLog("[SizerHover] handleDynamicSizerHover called");

    if (getAlwaysShowPile()) return;
    
    clearTimeout(state.hoverTimeout);
    
    // Keep pile visible while hovering over sizer and maintain mask
    if (state.dismissedPods.size > 0) {
      showPile();
      showPileBackground();
      schedulePileLayoutRepair("sizer-hover", 40);
      debugLog("[SizerHover] Maintaining pile visibility and mask during sizer hover");
    }
  }

  // Dynamic sizer leave handler
  function handleDynamicSizerLeave(event) {
    debugLog("[SizerHover] handleDynamicSizerLeave called");

    clearTimeout(state.hoverTimeout);

    // If moving into pile content (e.g. from sizer edge to a row), don't schedule hide
    if (event?.relatedTarget && state.pileContainer?.contains(event.relatedTarget)) {
      debugLog("[SizerHover] Moving into pile - not scheduling hide");
      return;
    }

    // Don't do anything if context menu is visible
    if (isContextMenuVisible()) {
      debugLog("[SizerHover] Context menu visible - deferring pile close");
      state.pendingPileClose = true;
      return;
    }

    // In always-show mode, don't handle pile visibility
    if (getAlwaysShowPile()) {
      debugLog("[SizerHover] Always-show mode - only handling grid transition");
      return;
    }

    // Normal mode: handle pile hiding
    state.hoverTimeout = setTimeout(() => {
      const isHoveringDownloadArea = state.downloadButton?.matches(':hover');
      const isHoveringPile = isHoveringPileArea();

      debugLog("[SizerHover] Leave timeout - checking hover states", {
        isHoveringDownloadArea,
        pileAreaHover: isHoveringPile,
        contextMenuVisible: isContextMenuVisible()
      });

      // Only hide if not hovering download button AND not hovering pile/bridge AND context menu not visible
      if (!isHoveringDownloadArea && !isHoveringPile) {
        if (isContextMenuVisible()) {
          debugLog("[SizerHover] Context menu visible at timeout - deferring pile close");
          state.pendingPileClose = true;
        } else {
          debugLog("[SizerHover] Calling hidePile()");
          hidePile();
        }
      }
    }, CONFIG.hoverDebounceMs);
  }

  // Pile hover handler (simplified - no mode transitions)
  function handlePileHover() {
    debugLog("[PileHover] handlePileHover called");

    clearTimeout(state.hoverTimeout);
    
    // Ensure pile background and mask remain active during hover
    showPileBackground();
    
    // If pile is visible, ensure it stays visible during hover
    if (state.dismissedPods.size > 0 && state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
      schedulePileLayoutRepair("pile-hover", 40);
      debugLog("[PileHover] Maintaining pile visibility and mask during hover");
    }
  }

  // Pile leave handler (simplified)
  function handlePileLeave(event) {
    debugLog("[PileHover] handlePileLeave called");

    clearTimeout(state.hoverTimeout);

    // If moving within pile area (e.g. between rows), don't schedule hide
    if (event?.relatedTarget && state.dynamicSizer?.contains(event.relatedTarget)) {
      debugLog("[PileHover] Moving within pile area - not scheduling hide");
      return;
    }

    // Don't do anything if context menu is visible
    if (isContextMenuVisible()) {
      debugLog("[PileHover] Context menu visible - deferring pile close");
      state.pendingPileClose = true;
      return;
    }

    // In always-show mode, don't hide the pile
    if (getAlwaysShowPile()) {
      return;
    }

    // Normal mode: handle pile hiding
    state.hoverTimeout = setTimeout(() => {
      const isHoveringDownloadArea = state.downloadButton?.matches(':hover');

      if (!isHoveringDownloadArea && !isHoveringPileArea()) {
        if (isContextMenuVisible()) {
          state.pendingPileClose = true;
        } else {
          debugLog("[PileHover] Calling hidePile()");
          hidePile();
        }
      }
    }, CONFIG.hoverDebounceMs);
  }

  // Show the pile
  function showPile() {
    debugLog("[ShowPile] showPile called", {
      dismissedPodsSize: state.dismissedPods.size,
      currentHeight: state.dynamicSizer?.style.height,
      // Removed isGridMode
      alwaysShowMode: getAlwaysShowPile()
    });

    if (state.dismissedPods.size === 0 || !state.dynamicSizer) return;

    // Check if pile is currently visible to prevent double animation
    const wasVisible = state.dynamicSizer.style.height !== '0px';

    // Check compact mode state - hide pile if sidebar is collapsed (similar to media controls)
    const isCompactMode = document.documentElement.getAttribute('zen-compact-mode') === 'true';
    const isSidebarExpanded = document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';

    if (isCompactMode && !isSidebarExpanded) {
      // In compact mode with collapsed sidebar, hide the pile (like media controls)
      debugLog("[ShowPile] Compact mode with collapsed sidebar - hiding pile");
      state.dynamicSizer.style.display = 'none';
      return;
    }

    // Show the pile
    state.dynamicSizer.style.display = 'flex';

    // Ensure width is set before calculating positions
    if (typeof updatePileContainerWidth === 'function') {
      updatePileContainerWidth();
    }

    // Parent container spans full toolbar width
    state.dynamicSizer.style.left = '0px';
    state.dynamicSizer.style.right = '0px';
    // Remove width when using left/right - it's automatically calculated

    debugLog("Positioned pile for full-width container", {
      position: state.dynamicSizer.style.position,
      left: state.dynamicSizer.style.left,
      right: state.dynamicSizer.style.right
    });

    // Set pointer-events based on mode and state
    updatePointerEvents();

    state.dynamicSizer.style.paddingBottom = '0px'; // No padding - space comes from baseBottomOffset
    state.dynamicSizer.style.paddingLeft = `0px`; // No left padding for full-width rows

    // Calculate dynamic height for 4 most recent pods
    const totalPods = state.dismissedPods.size;
    const podsToShow = Math.min(totalPods, 4); // Always max 4 pods

    const rowHeight = 48; // Height of each row (pod + text)
    const rowSpacing = 6; // Spacing between rows

    // Calculate height: (rows * row height) + spacing between rows + space below first pod
    // The baseBottomOffset in positioning creates the space, so we add it to height to accommodate it
    const baseBottomOffset = 8; // Space under first pod row (matches applyGridPosition)
    const totalRowHeight = (podsToShow * rowHeight) + ((podsToShow - 1) * rowSpacing);
    const gridHeight = totalRowHeight + baseBottomOffset;

    debugLog("Dynamic height calculation (4 most recent)", {
      totalPods,
      podsToShow,
      calculatedHeight: gridHeight
    });

    state.dynamicSizer.style.height = `${gridHeight}px`;

    // Show hover bridge to cover gap between download button and pile
    if (state.hoverBridge) {
      state.hoverBridge.style.display = 'block';
    }

    // Update mask height variable for #zen-tabs-wrapper mask
    // Subtract media toolbar height when visible so the mask accounts for its space
    const mediaControlsToolbar = document.getElementById('zen-media-controls-toolbar');
    const mediaToolbarHeight = mediaControlsToolbar?.getBoundingClientRect().height ?? 0;
    const pileMaskHeight = Math.max(0, gridHeight - (mediaToolbarHeight > 0 ? mediaToolbarHeight : 0));
    document.documentElement.style.setProperty('--zen-pile-height', `${pileMaskHeight}px`);

    // Apply mask on media controls toolbar for seamless blend when pile expands
    if (mediaControlsToolbar) {
      mediaControlsToolbar.classList.add('zen-pile-expanded');
    }

    // Set background to ensure backdrop-filter is properly rendered
    showPileBackground();

    // Mask is applied in hover handlers, not here

    // Hide workspace-arrowscrollbox::after when pile is showing
    hideWorkspaceScrollboxAfter();

    // Update positions for all pods (show only 4 most recent)
    const recentPods = Array.from(state.dismissedPods.keys()).slice(-4);

    if (!wasVisible) {
      // Reset pods to hidden state
      recentPods.forEach(podKey => {
        const el = state.podElements.get(podKey);
        if (el) {
          el.style.transition = 'none';
          el.style.opacity = '0';
          el.style.transform = 'translateY(20px)';
        }
      });

      // Force reflow so reset state is applied before we set transitions
      if (state.dynamicSizer) state.dynamicSizer.offsetHeight;

      // Use CSS transition-delay for stagger (all transitions start same frame, predictable order)
      // Order: oldest (index 0) first, newest (index 3) last
      recentPods.forEach((podKey, index) => {
        const el = state.podElements.get(podKey);
        if (el) {
          const delayMs = index * CONFIG.gridAnimationDelay;
          el.style.transition = `opacity ${CONFIG.animationDuration}ms ease ${delayMs}ms, transform ${CONFIG.animationDuration}ms ease ${delayMs}ms`;
        }
      });

      // Batch all position updates in single frame for consistent animation start
      recentPods.forEach(podKey => generateGridPosition(podKey));
      requestAnimationFrame(() => {
        recentPods.forEach(podKey => applyGridPosition(podKey, 0, false, true));
      });
    } else {
      // Already visible: update positions without stagger
      recentPods.forEach((podKey) => {
        generateGridPosition(podKey);
        applyGridPosition(podKey, 0);
      });
    }

    // Ensure hover events are properly set up for the current mode
    // This is important after the pile was hidden and is being shown again
    setTimeout(() => {
      setupPileBackgroundHoverEvents();
      debugLog("[ShowPile] Hover events re-setup after pile shown");
    }, 50); // Small delay to ensure DOM is updated

    // Notify tidy-downloads that the pile is showing so it can remove sticky pods from the pods row
    document.dispatchEvent(new CustomEvent('pile-shown', { bubbles: true }));

    debugLog("Showing pile with single column layout", {
      totalPods,
      podsToShow,
      dynamicHeight: gridHeight
    });

    schedulePileLayoutRepair("show-pile", 30);
  }

  // Hide the pile
  function hidePile() {
    debugLog("[HidePile] hidePile called", {
      currentHeight: state.dynamicSizer?.style.height,
      isEditing: state.isEditing,
      recentlyRemoved: state.recentlyRemoved
    });

    // Don't hide pile if user is editing a filename
    if (state.isEditing) {
      debugLog("[HidePile] Pile kept visible - editing in progress");
      return;
    }

    // Don't hide pile if a pod was recently removed (give user time to see the result)
    if (state.recentlyRemoved) {
      debugLog("[HidePile] Pile kept visible - recent removal in progress");
      return;
    }

    // Don't hide while pile row context menu is open (or opening); matches sizer/pile leave behavior
    if (isContextMenuVisible()) {
      debugLog("[HidePile] Pile kept visible - context menu active");
      state.pendingPileClose = true;
      return;
    }

    if (!state.dynamicSizer) return;

    state.dynamicSizer.style.pointerEvents = 'none';
    state.dynamicSizer.style.height = '0px';

    if (state.hoverBridge) {
      state.hoverBridge.style.display = 'none';
    }
    state.dynamicSizer.style.paddingBottom = '0px'; // Remove padding when hiding
    state.dynamicSizer.style.paddingLeft = '0px'; // Remove left padding when hiding

    // Don't hide display in compact mode - let the observer handle it
    // Only hide display if not in compact mode with collapsed sidebar
    const isCompactMode = document.documentElement.getAttribute('zen-compact-mode') === 'true';
    const isSidebarExpanded = document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';
    if (!(isCompactMode && !isSidebarExpanded)) {
      state.dynamicSizer.style.display = 'flex'; // Keep flex but collapsed
    }

    // Hide background and buttons when hiding pile
    hidePileBackground();

    // Fade out pods when hiding
    state.dismissedPods.forEach((_, podKey) => {
      const el = state.podElements.get(podKey);
      if (el) {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
      }
    });

    // Reset mask height variable to -50px (completely hide mask)
    document.documentElement.style.setProperty('--zen-pile-height', '-50px');

    // Remove mask from media controls toolbar when pile collapses
    const mediaControlsToolbar = document.getElementById('zen-media-controls-toolbar');
    if (mediaControlsToolbar) {
      setTimeout(() => {
        mediaControlsToolbar.classList.remove('zen-pile-expanded');
      }, CONFIG.containerAnimationDuration);
    }

    // Restore workspace-arrowscrollbox::after when pile is hidden
    showWorkspaceScrollboxAfter();

    debugLog("Hiding dismissed downloads pile by collapsing sizer");

    document.dispatchEvent(
      new CustomEvent("pile-hidden", { bubbles: true, detail: { reason: "collapsed" } })
    );
  }

  /*
   * Pile visibility state machine (informal invariants):
   * - collapsed: dynamicSizer height 0, --zen-pile-height typically -50px, bridge hidden
   * - expanded:  sizer has row height, mask >= 0 (or 0 when geometry is tiny), pointer-events per always-show
   * - always_visible: getAlwaysShowPile() && dismissedPods.size > 0 ⇒ should not stay collapsed (except compact+sidebar collapsed)
   * - pending_close: pendingPileClose until popuphidden / leave timeout resolves
   * Repair re-syncs mask to sizer and re-applies pointer-events when these drift (e.g. after sticky + pile-shown).
   */

  /**
   * @returns {number}
   */
  function getPileMaskHeightPx() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--zen-pile-height").trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : NaN;
  }

  /**
   * @returns {number}
   */
  function readSizerContentHeightPx() {
    const h = state.dynamicSizer?.style?.height;
    if (!h || h === "0px") {
      return 0;
    }
    const n = parseFloat(h);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Fix desynced mask / sizer / pointer-events. Idempotent; logs when it changes something.
   * @param {string} source
   */
  function enforcePileLayoutInvariants(source = "") {
    if (!state.dynamicSizer) {
      return;
    }

    const podCount = state.dismissedPods.size;
    const sizerOpen = state.dynamicSizer.style.height !== "0px";
    const maskH = getPileMaskHeightPx();
    const sizerH = readSizerContentHeightPx();

    if (podCount === 0) {
      if (
        sizerOpen &&
        !state.recentlyRemoved &&
        !state.isEditing &&
        !isContextMenuVisible()
      ) {
        debugLog("[PileRepair] empty pile but sizer open → hidePile", { source });
        hidePile();
      }
      return;
    }

    const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
    const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
    const compactBlocksPile = isCompactMode && !isSidebarExpanded;

    if (getAlwaysShowPile() && !sizerOpen && !compactBlocksPile) {
      debugLog("[PileRepair] always-show + pods but sizer collapsed → showPile", { source });
      showPile();
      updatePointerEvents();
      return;
    }

    if (sizerOpen && !compactBlocksPile) {
      const maskBadNegative = Number.isFinite(maskH) && maskH < 0;
      const maskZeroButSizerTall = maskH === 0 && sizerH > 16;
      if (maskBadNegative || maskZeroButSizerTall) {
        debugLog("[PileRepair] sizer open but mask out of sync → updatePileHeight", {
          source,
          maskH,
          sizerH
        });
        updatePileHeight();
        updatePointerEvents();
      }
    }
  }

  /**
   * Coalesce rapid calls; throttle how often we run a full enforce pass.
   * @param {string} source
   * @param {number} delayMs
   */
  function schedulePileLayoutRepair(source, delayMs = 80) {
    clearTimeout(state.pileRepairDebounceId);
    state.pileRepairDebounceId = setTimeout(() => {
      state.pileRepairDebounceId = null;
      const now = Date.now();
      if (now - state.lastPileRepairAt < 350) {
        return;
      }
      state.lastPileRepairAt = now;
      try {
        enforcePileLayoutInvariants(source);
      } catch (e) {
        debugLog("[PileRepair] enforce error:", e);
      }
    }, delayMs);
  }

  // Recalculate layout on window resize
  function recalculateLayout() {
    if (state.dismissedPods.size === 0) return;

    // Regenerate grid positions
    state.dismissedPods.forEach((_, podKey) => {
      generateGridPosition(podKey);
    });

    // Recalculate position if pile is currently shown - parent container spans full width
    if (state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
      // Parent container spans full toolbar width
      state.dynamicSizer.style.left = '0px';
      state.dynamicSizer.style.right = '0px';
      // Remove width when using left/right - it's automatically calculated

      debugLog("Recalculated pile position on resize - full width container");
    }

    // Apply positions for all pods (always single column mode now)
    state.dismissedPods.forEach((_, podKey) => {
      generateGridPosition(podKey);
      applyGridPosition(podKey, 0);
    });

    schedulePileLayoutRepair("resize", 0);
  }

  function initPileSidebarWidthSync() {
    // This function is now unused - width is only read on-demand in showPile()
    debugLog('[PileWidthSync] initPileSidebarWidthSync called but automatic sync is disabled to prevent feedback loops.');
  }
  // --- End Pile Container Width Synchronization Logic ---

  // Update downloads button visibility - now handled by hover events
  function updateDownloadsButtonVisibility() {
    // Buttons are now controlled by hover events in showPileBackground/hidePileBackground
    // This function is kept for compatibility but doesn't change visibility
    debugLog(`[DownloadsButton] Button visibility managed by hover - ${state.dismissedPods.size} dismissed pods`);
  }

  // Function to remove a specific download from Firefox downloads list
  async function removeDownloadFromFirefoxList(podData, resolvedDownload = null) {
    try {
      debugLog(`[DeleteDownload] Attempting to remove download from Firefox list: ${podData.filename}`);

      if (
        window.zenTidyDownloads &&
        typeof window.zenTidyDownloads.removeDownloadFromListForPodData === 'function'
      ) {
        const ok = await window.zenTidyDownloads.removeDownloadFromListForPodData(
          podData,
          resolvedDownload
        );
        if (ok) {
          return true;
        }
        debugLog(`[DeleteDownload] API matcher did not remove; falling back to legacy path/URL scan`);
      }

      const list = await window.Downloads.getList(window.Downloads.ALL);
      const downloads = await list.getAll();

      let targetDownload = null;

      for (const download of downloads) {
        if (podData.targetPath && download.target?.path === podData.targetPath) {
          targetDownload = download;
          debugLog(`[DeleteDownload] Found download by target path: ${download.target.path}`);
          break;
        }

        if (podData.sourceUrl && download.source?.url === podData.sourceUrl) {
          const downloadFilename = download.target?.path ?
            download.target.path.split(/[/\\]/).pop() : null;

          if (!downloadFilename || downloadFilename === podData.filename ||
            downloadFilename === podData.originalFilename) {
            targetDownload = download;
            debugLog(`[DeleteDownload] Found download by source URL: ${download.source.url}`);
            break;
          }
        }
      }

      if (targetDownload) {
        await list.remove(targetDownload);
        debugLog(`[DeleteDownload] Successfully removed download from Firefox list: ${podData.filename}`);
        return true;
      }
      debugLog(`[DeleteDownload] Download not found in Firefox list: ${podData.filename}`);
      return false;
    } catch (error) {
      debugLog(`[DeleteDownload] Error removing download from Firefox list:`, error);
      throw error;
    }
  }

  // Function to clear all downloads from Firefox
  async function clearAllDownloads() {
    try {
      debugLog("[ClearAll] Starting to clear all downloads from Firefox");

      // Get the downloads list
      const list = await window.Downloads.getList(window.Downloads.ALL);
      const downloads = await list.getAll();

      debugLog(`[ClearAll] Found ${downloads.length} downloads to clear`);

      // Remove all downloads from the list
      for (const download of downloads) {
        try {
          await list.remove(download);
          debugLog(`[ClearAll] Removed download: ${download.target?.path || download.source?.url}`);
        } catch (error) {
          debugLog(`[ClearAll] Error removing individual download:`, error);
        }
      }

      // Clear the dismissed pile as well since all downloads are gone
      state.dismissedPods.clear();
      updatePileVisibility();
      updateDownloadsButtonVisibility();

      debugLog("[ClearAll] Successfully cleared all downloads and pile");

    } catch (error) {
      debugLog("[ClearAll] Error clearing downloads:", error);
      throw error;
    }
  }

  // Check if main download script has active pods to disable hover
  function shouldDisableHover() {
    try {
      // Check for visible download pods within the dedicated container.
      // Sticky pods (.zen-tidy-sticky-pod) are already in the pile and should NOT disable hover -
      // we want the pile to open so the sticky pod can animate out.
      const podsRowContainer = document.getElementById('userchrome-pods-row-container');
      if (podsRowContainer) {
        const activePods = podsRowContainer.querySelectorAll('.download-pod:not(.zen-tidy-sticky-pod)');
        if (activePods.length > 0) {
          debugLog(`[HoverCheck] Found ${activePods.length} active (non-sticky) pods - disabling pile hover`);
          return true;
        }
      }

      return false;
    } catch (error) {
      debugLog(`[HoverCheck] Error checking main script state:`, error);
      return false;
    }
  }

  // Parse RGB/RGBA from CSS color string - returns { r, g, b, a } or null
  function parseRGB(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    if (colorStr.startsWith('rgba(')) {
      const match = colorStr.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
      if (match) {
        return {
          r: parseInt(match[1]),
          g: parseInt(match[2]),
          b: parseInt(match[3]),
          a: parseFloat(match[4])
        };
      }
    } else if (colorStr.startsWith('rgb(')) {
      const match = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      if (match) {
        return {
          r: parseInt(match[1]),
          g: parseInt(match[2]),
          b: parseInt(match[3]),
          a: 1
        };
      }
    }
    return null;
  }

  // Compute the blended background color that matches Zen's lightening effect
  function computeBlendedBackgroundColor() {
    // Check if we're in compact mode - use toolbar background color directly
    const isCompactMode = document.documentElement.getAttribute('zen-compact-mode') === 'true';
    const isSidebarExpanded = document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';

    if (isCompactMode && isSidebarExpanded) {
      // In compact mode with expanded sidebar, use toolbar background color (includes light tint)
      const navigatorToolbox = document.getElementById('navigator-toolbox');
      if (navigatorToolbox) {
        const toolbarBg = window.getComputedStyle(navigatorToolbox).getPropertyValue('--zen-main-browser-background-toolbar').trim();
        if (toolbarBg) {
          // Try to get the computed color value
          const testEl = document.createElement('div');
          testEl.style.backgroundColor = toolbarBg || 'var(--zen-main-browser-background-toolbar)';
          testEl.style.position = 'absolute';
          testEl.style.visibility = 'hidden';
          document.body.appendChild(testEl);
          const computedColor = window.getComputedStyle(testEl).backgroundColor;
          document.body.removeChild(testEl);

          if (computedColor && computedColor !== 'transparent' && computedColor !== 'rgba(0, 0, 0, 0)') {
            debugLog('[BackgroundColor] Using toolbar background color for compact mode:', computedColor);
            // Ensure fully opaque - convert rgba to rgb if needed
            if (computedColor.startsWith('rgba(')) {
              const match = computedColor.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/);
              if (match) {
                return `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
              }
            }
            return computedColor;
          }

          // If computed color isn't available, return the CSS variable
          return toolbarBg || 'var(--zen-main-browser-background-toolbar)';
        }
      }
    }

    // For non-compact mode or collapsed sidebar, use the blended color calculation
    // Get base background color
    const navigatorToolbox = document.getElementById('navigator-toolbox');
    let baseColor = null;
    if (navigatorToolbox) {
      const baseComputed = window.getComputedStyle(navigatorToolbox);
      const baseResolved = baseComputed.getPropertyValue('--zen-main-browser-background').trim();

      // If it's a gradient, we can't easily blend, so return the variable
      if (baseResolved.includes('gradient') || baseResolved.includes('linear') || baseResolved.includes('radial')) {
        return 'var(--zen-main-browser-background)';
      }

      // Try to get the actual computed color
      const testEl = document.createElement('div');
      testEl.style.backgroundColor = 'var(--zen-main-browser-background)';
      testEl.style.position = 'absolute';
      testEl.style.visibility = 'hidden';
      document.body.appendChild(testEl);
      const computedBase = window.getComputedStyle(testEl).backgroundColor;
      document.body.removeChild(testEl);

      if (computedBase && computedBase !== 'transparent' && computedBase !== 'rgba(0, 0, 0, 0)') {
        baseColor = computedBase;
      }
    }

    // Get wrapper background color
    const appWrapper = document.getElementById('zen-main-app-wrapper');
    let wrapperColor = null;
    if (appWrapper) {
      const wrapperComputed = window.getComputedStyle(appWrapper);
      wrapperColor = wrapperComputed.backgroundColor;
    }

    // If we don't have both colors, fallback to base
    if (!baseColor || !wrapperColor || baseColor === 'transparent' || wrapperColor === 'transparent') {
      return 'var(--zen-main-browser-background)';
    }

    const baseRGB = parseRGB(baseColor);
    const wrapperRGB = parseRGB(wrapperColor);

    if (!baseRGB || !wrapperRGB) {
      return 'var(--zen-main-browser-background)';
    }

    // Blend the colors to achieve the target: rgb(49, 32, 42)
    // Formula: blended = base * (1 - ratio) + wrapper * ratio
    // Solving for ratio to match target rgb(49, 32, 42):
    // If base is rgb(34, 17, 31) and wrapper is rgb(255, 233, 198):
    // - R: 34 + (255-34) * ratio = 49 => ratio ≈ 0.068
    // - G: 17 + (233-17) * ratio = 32 => ratio ≈ 0.069  
    // - B: 31 + (198-31) * ratio = 42 => ratio ≈ 0.066
    // Average ratio ≈ 0.067 (about 6.7%)
    const wrapperRatio = 0.067; // Adjusted to match target rgb(49, 32, 42)

    const blendedR = Math.round(baseRGB.r * (1 - wrapperRatio) + wrapperRGB.r * wrapperRatio);
    const blendedG = Math.round(baseRGB.g * (1 - wrapperRatio) + wrapperRGB.g * wrapperRatio);
    const blendedB = Math.round(baseRGB.b * (1 - wrapperRatio) + wrapperRGB.b * wrapperRatio);

    // Always return fully opaque color (no transparency)
    return `rgb(${blendedR}, ${blendedG}, ${blendedB})`;
  }

  // Calculate text color based on background color (using Zen's luminance/contrast logic)
  function calculateTextColorForBackground(backgroundColor) {
    const parsed = parseRGB(backgroundColor);
    const bgRGB = parsed ? [parsed.r, parsed.g, parsed.b] : null;
    if (!bgRGB) {
      // Fallback to CSS variable if we can't parse
      return 'var(--zen-text-color, #e0e0e0)';
    }

    // Calculate relative luminance (from Zen's luminance function)
    function luminance([r, g, b]) {
      const a = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    }

    // Calculate contrast ratio (from Zen's contrastRatio function)
    function contrastRatio(rgb1, rgb2) {
      const lum1 = luminance(rgb1);
      const lum2 = luminance(rgb2);
      const brightest = Math.max(lum1, lum2);
      const darkest = Math.min(lum1, lum2);
      return (brightest + 0.05) / (darkest + 0.05);
    }

    // Test dark text (black) and light text (white)
    const darkText = [0, 0, 0];
    const lightText = [255, 255, 255];

    const darkContrast = contrastRatio(bgRGB, darkText);
    const lightContrast = contrastRatio(bgRGB, lightText);

    // Use whichever has better contrast
    // Also consider: if background is very light, use dark text; if very dark, use light text
    const bgLuminance = luminance(bgRGB);
    const useDarkText = darkContrast > lightContrast || bgLuminance > 0.5;

    if (useDarkText) {
      return 'rgba(0, 0, 0, 0.8)'; // Dark text with some transparency
    } else {
      return 'rgba(255, 255, 255, 0.8)'; // Light text with some transparency
    }
  }

  // Update text colors for all pod rows based on current background
  function updatePodTextColors() {
    if (!state.dynamicSizer) {
      return;
    }

    const blendedColor = computeBlendedBackgroundColor();
    const textColor = calculateTextColorForBackground(blendedColor);

    // Update all pod text elements
    const textElements = state.pileContainer.querySelectorAll('.dismissed-pod-filename, .dismissed-pod-filesize');
    textElements.forEach(el => {
      el.style.color = textColor;
    });

    console.log('[ShowPile] Updated text colors to:', textColor, 'for background:', blendedColor);
  }

  // applyTabsWrapperMask and removeTabsWrapperMask function removed - logic replaced by CSS mask-image with --zen-pile-height variable

  // Show pile background on hover
  // dynamicSizer stays transparent in all modes so the mask on #zen-tabs-wrapper reveals the titlebar underneath
  function showPileBackground() {
    if (!state.dynamicSizer) return;

    state.dynamicSizer.style.backgroundColor = 'transparent';
    state.dynamicSizer.style.background = 'transparent';
    state.dynamicSizer.style.backdropFilter = 'none';
    state.dynamicSizer.style.webkitBackdropFilter = 'none';
    updatePodTextColors();
  }

  // Hide pile background when not hovering
  function hidePileBackground() {
    if (!state.dynamicSizer) {
      return;
    }
    if (state.isTransitioning) {
      return;
    }
    
    // Don't hide background if pile is currently visible - keep mask persistent
    const isPileVisible = state.dynamicSizer.style.height !== '0px' && state.dismissedPods.size > 0;
    if (isPileVisible) {
      // Keep the background and mask active while pile is visible
      debugLog("[HidePileBackground] Pile is visible - keeping mask persistent");
      return;
    }
    
    // Don't hide background if user is currently hovering over pile area
    if (state.downloadButton?.matches(':hover') || isHoveringPileArea()) {
      debugLog("[HidePileBackground] User hovering over pile area - keeping mask active");
      return;
    }
    
    // Only hide background when pile is actually hidden and no hover
    state.dynamicSizer.style.background = 'transparent';
    state.dynamicSizer.style.backgroundColor = 'transparent';
    debugLog("[HidePileBackground] Background hidden - pile not visible and no hover");
  }

  // Hide arrowscrollbox.workspace-arrowscrollbox::after when pile is showing
  function hideWorkspaceScrollboxAfter() {
    if (state.workspaceScrollboxStyle) {
      document.documentElement.style.setProperty('--zen-stuff-scrollbox-after-opacity', '0');
      debugLog("Hidden arrowscrollbox.workspace-arrowscrollbox::after");
    }
  }

  // Show arrowscrollbox.workspace-arrowscrollbox::after when pile is hidden
  function showWorkspaceScrollboxAfter() {
    if (state.workspaceScrollboxStyle) {
      document.documentElement.style.setProperty('--zen-stuff-scrollbox-after-opacity', '1');
      debugLog("Shown arrowscrollbox.workspace-arrowscrollbox::after");
    }
  }

  // Helper: is cursor over pile area (including bridge between button and pile)
  function isHoveringPileArea() {
    return state.pileContainer?.matches(':hover') ||
           state.dynamicSizer?.matches(':hover') ||
           state.hoverBridge?.matches(':hover');
  }

  // Hover bridge enter - keeps pile visible when moving from download button to pile
  function handleHoverBridgeEnter() {
    debugLog("[HoverBridge] Entered - keeping pile visible");
    clearTimeout(state.hoverTimeout);
    if (state.dismissedPods.size > 0) {
      showPile();
      showPileBackground();
    }
  }

  // Hover bridge leave - same logic as dynamicSizer leave
  // Use a short delay so pile's mouseenter can fire first when moving bridge→pile (avoids premature hide)
  function handleHoverBridgeLeave(event) {
    debugLog("[HoverBridge] Left");
    if (event?.relatedTarget && (state.pileContainer?.contains(event.relatedTarget) || state.dynamicSizer?.contains(event.relatedTarget))) {
      debugLog("[HoverBridge] Moving into pile - not scheduling hide");
      return;
    }
    // Delay before delegating so pile's mouseenter has time to fire when moving upward
    const bridgeLeaveGraceMs = 120;
    setTimeout(() => {
      if (isHoveringPileArea() || state.downloadButton?.matches(':hover')) return;
      handleDynamicSizerLeave(event);
    }, bridgeLeaveGraceMs);
  }

  // Setup hover events for background/buttons (simplified - always single column mode)
  function setupPileBackgroundHoverEvents() {
    if (!state.dynamicSizer || !state.pileContainer) {
      return;
    }

    // Remove existing hover events first
    if (state.containerHoverEventsAttached) {
      state.dynamicSizer.removeEventListener('mouseenter', handleDynamicSizerHover);
      state.dynamicSizer.removeEventListener('mouseleave', handleDynamicSizerLeave);
      state.containerHoverEventsAttached = false;
    }

    if (state.pileHoverEventsAttached) {
      state.pileContainer.removeEventListener('mouseenter', handlePileHover);
      state.pileContainer.removeEventListener('mouseleave', handlePileLeave);
      state.pileHoverEventsAttached = false;
    }

    if (state.hoverBridge) {
      state.hoverBridge.removeEventListener('mouseenter', handleHoverBridgeEnter);
      state.hoverBridge.removeEventListener('mouseleave', handleHoverBridgeLeave);
      state.hoverBridge.addEventListener('mouseenter', handleHoverBridgeEnter);
      state.hoverBridge.addEventListener('mouseleave', handleHoverBridgeLeave);
    }

    // Attach both: dynamicSizer (overall area) and pileContainer (pile rows) so mask stays when hovering rows
    state.dynamicSizer.addEventListener('mouseenter', handleDynamicSizerHover);
    state.dynamicSizer.addEventListener('mouseleave', handleDynamicSizerLeave);
    state.containerHoverEventsAttached = true;

    state.pileContainer.addEventListener('mouseenter', handlePileHover);
    state.pileContainer.addEventListener('mouseleave', handlePileLeave);
    state.pileHoverEventsAttached = true;
  }

  // Alt key handlers for always-show mode
  function handleKeyDown(event) {
    if (event.key === 'Alt' && !state.isAltPressed) {
      state.isAltPressed = true;
      debugLog("[AlwaysShow] Alt key pressed");

      if (getAlwaysShowPile() && state.dismissedPods.size > 0) {
        // Hide pile when Alt is pressed in always-show mode
        hidePile();
      }
    }
  }

  function handleKeyUp(event) {
    if (event.key === 'Alt' && state.isAltPressed) {
      state.isAltPressed = false;
      debugLog("[AlwaysShow] Alt key released");

      if (getAlwaysShowPile() && state.dismissedPods.size > 0) {
        // Show pile again when Alt is released in always-show mode
        showPile();
      }
    }
  }

  // Check if pile should be visible based on always-show mode and Alt key state
  function shouldPileBeVisible() {
    if (state.dismissedPods.size === 0) return false;

    if (getAlwaysShowPile()) {
      // In always-show mode: visible unless Alt is pressed
      return !state.isAltPressed;
    } else {
      // Normal hover mode: only visible when hovering
      return false; // This will be overridden by hover handlers
    }
  }

  // Get preference values with defaults
  function getAlwaysShowPile() {
    try {
      // Changed default to false as requested
      return Services.prefs.getBoolPref(PREFS.alwaysShowPile, false);
    } catch (e) {
      debugLog("Error reading always-show-pile preference, using default (false):", e);
      return false;
    }
  }

  // Get library button preference
  function getUseLibraryButton() {
    try {
      const value = Services.prefs.getBoolPref(PREFS.useLibraryButton, false);
      console.log(`[Zen Stuff] getUseLibraryButton() returning: ${value}`);
      console.log(`[Zen Stuff] Preference name: ${PREFS.useLibraryButton}`);
      
      // Debug: Check what buttons are available
      const libraryBtn = document.getElementById('zen-library-button');
      const downloadsBtn = document.getElementById('downloads-button');
      console.log(`[Zen Stuff] Available buttons - Library: ${!!libraryBtn}, Downloads: ${!!downloadsBtn}`);
      
      return value;
    } catch (e) {
      console.log(`[Zen Stuff] Error reading use-library-button preference, using default (false):`, e);
      debugLog("Error reading use-library-button preference, using default (false):", e);
      return false;
    }
  }

  // Setup compact mode observer to handle visibility changes
  function setupCompactModeObserver() {
    const mainWindow = document.getElementById('main-window');
    const zenMainAppWrapper = document.getElementById('zen-main-app-wrapper');
    const targetElement = zenMainAppWrapper || document.documentElement;

    if (!targetElement) {
      debugLog("[CompactModeObserver] Target element not found, cannot set up observer");
      return;
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          const attributeName = mutation.attributeName;
          if (attributeName === 'zen-compact-mode' || attributeName === 'zen-sidebar-expanded') {
            debugLog(`[CompactModeObserver] ${attributeName} changed, updating pile visibility`);
            // Update pile visibility based on compact mode state
            if (state.dynamicSizer && state.dismissedPods.size > 0) {
              const isCompactMode = document.documentElement.getAttribute('zen-compact-mode') === 'true';
              const isSidebarExpanded = document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';

              if (isCompactMode && !isSidebarExpanded) {
                // Hide pile when sidebar is collapsed in compact mode
                state.dynamicSizer.style.display = 'none';
              } else if (shouldPileBeVisible()) {
                // Show pile if it should be visible
                showPile();
              }
            }
          }
        }
      }
    });

    observer.observe(targetElement, {
      attributes: true,
      attributeFilter: ['zen-compact-mode', 'zen-sidebar-expanded']
    });

    // Also observe documentElement for zen-sidebar-expanded
    if (targetElement !== document.documentElement) {
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['zen-sidebar-expanded']
      });
    }

    debugLog("[CompactModeObserver] Set up observer for compact mode changes");
  }

  // Setup preference change listener
  function setupPreferenceListener() {
    try {
      const prefObserver = {
        observe: function (subject, topic, data) {
          if (topic === 'nsPref:changed') {
            if (data === PREFS.alwaysShowPile) {
              const newValue = getAlwaysShowPile();
              debugLog(`[Preferences] Always-show-pile preference changed to: ${newValue}`);
              handleAlwaysShowPileChange(newValue);
            } else if (data === PREFS.useLibraryButton) {
              const newValue = getUseLibraryButton();
              console.log(`[Zen Stuff] Use-library-button preference changed to: ${newValue}`);
              debugLog(`[Preferences] Use-library-button preference changed to: ${newValue}`);
              // Re-find the download button with new preference (with retry for custom buttons)
              findDownloadButton().catch(error => {
                console.error('[Preferences] Error re-finding download button:', error);
              });
            }
          }
        }
      };

      Services.prefs.addObserver(PREFS.alwaysShowPile, prefObserver, false);
      Services.prefs.addObserver(PREFS.useLibraryButton, prefObserver, false);
      debugLog("[Preferences] Added observers for preferences");

      // Store observer for cleanup
      state.prefObserver = prefObserver;
    } catch (e) {
      debugLog("[Preferences] Error setting up preference observer:", e);
    }
  }

  // Handle preference change
  function handleAlwaysShowPileChange(newValue) {
    debugLog(`[Preferences] Handling always-show-pile change to: ${newValue}`);

    if (state.dismissedPods.size === 0) {
      debugLog("[Preferences] No dismissed pods, nothing to do");
      return;
    }

    if (newValue) {
      // Switched to always-show mode
      if (shouldPileBeVisible()) {
        showPile();
        debugLog("[Preferences] Switched to always-show mode - showing pile");
      }
    } else {
      // Switched to hover mode
      if (state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
        // If pile is currently visible, hide it (it will show again on hover)
        hidePile();
        debugLog("[Preferences] Switched to hover mode - hiding pile");
      }
    }
  }

  // Update pointer-events based on current state
  function updatePointerEvents() {
    if (!state.dynamicSizer || !state.pileContainer) return;
    const alwaysShow = getAlwaysShowPile();
    if (alwaysShow) {
      state.dynamicSizer.style.pointerEvents = 'none';
      state.pileContainer.style.pointerEvents = 'auto';
    } else {
      state.dynamicSizer.style.pointerEvents = 'auto';
      state.pileContainer.style.pointerEvents = 'auto';
    }
  }

  // --- Native XUL menupopup for pod context menu ---
  const podContextMenuFragment = window.MozXULElement.parseXULToFragment(`
    <menupopup id="zen-pile-pod-context-menu">
      <menuitem id="zenPilePodOpen" label="Open"/>
      <menuitem id="zenPilePodRename" label="Rename"/>
      <menuitem id="zenPilePodCopy" label="Copy to Clipboard"/>
      <menuseparator/>
      <menuitem id="zenPilePodRemove" label="Remove from Stuff"/>
      <menuitem id="zenPilePodDelete" label="Delete"/>
    </menupopup>
  `);
  let podContextMenu = null;
  let podContextMenuPodData = null;

  function ensurePodContextMenu() {
    if (!podContextMenu) {
      const frag = podContextMenuFragment.cloneNode(true);
      podContextMenu = frag.firstElementChild;
      document.getElementById("mainPopupSet")?.appendChild(podContextMenu) || document.body.appendChild(podContextMenu);
      // Open
      podContextMenu.querySelector("#zenPilePodOpen").addEventListener("command", () => {
        if (podContextMenuPodData) openPodFile(podContextMenuPodData);
      });
      // Rename (trigger inline editing)
      podContextMenu.querySelector("#zenPilePodRename").addEventListener("command", () => {
        if (podContextMenuPodData) {
          startInlineRename(podContextMenuPodData);
        }
      });
      // Remove from Stuff
      podContextMenu.querySelector("#zenPilePodRemove").addEventListener("command", async () => {
        if (podContextMenuPodData) {
          // Ask for confirmation (use Services.prompt with window so it works from context menu)
          const confirmed = Services.prompt.confirm(
            window,
            'Remove from Stuff',
            `Are you sure you want to remove "${podContextMenuPodData.filename}" from Stuff?\n\nThis will remove it from the pile but won't delete the file.`
          );
          if (!confirmed) {
            return; // User cancelled
          }
          
          try {
            window.zenTidyDownloads.permanentDelete(podContextMenuPodData.key);
            removePodFromPile(podContextMenuPodData.key);
            // --- Update carousel/grid after removal ---
            const allPods = Array.from(state.dismissedPods.keys()).reverse(); // Most recent first
            const MAX_PODS_TO_SHOW = 10;
            if (allPods.length < MAX_PODS_TO_SHOW) {
              state.carouselStartIndex = 0;
              state.visibleGridOrder = allPods.slice();
            } else {
              // If carouselStartIndex is out of bounds, reset
              if (state.carouselStartIndex >= allPods.length) {
                state.carouselStartIndex = 0;
              }
              state.visibleGridOrder = [];
              for (let i = 0; i < MAX_PODS_TO_SHOW; i++) {
                const podIndex = state.carouselStartIndex + i;
                if (podIndex < allPods.length) {
                  state.visibleGridOrder.push(allPods[podIndex]);
                }
              }
            }
            // Update positions for all pods
            state.dismissedPods.forEach((_, podKey) => {
              generateGridPosition(podKey);
              applyGridPosition(podKey, 0);
            });
            // Immediately hide all non-visible pods after removal
            state.dismissedPods.forEach((_, podKey) => {
              if (!state.visibleGridOrder.includes(podKey)) {
                const podElement = state.podElements.get(podKey);
                if (podElement) podElement.style.display = 'none';
              }
            });
          } catch (err) {
            showUserNotification(`Error removing pod: ${err.message}`);
          }
        }
      });

      // Add the popuphidden event listener here, after podContextMenu is created
      podContextMenu.addEventListener("popuphidden", () => {
        state.pileContextMenuActive = false;
        setTimeout(() => {
          const isHoveringPile = isHoveringPileArea();
          const isHoveringDownloadArea = state.downloadButton?.matches(':hover');
          const isPileVisible = state.dynamicSizer && state.dynamicSizer.style.height !== '0px';

          if (!isHoveringPile && !isHoveringDownloadArea) {
            // No mode transitions needed
            if (!getAlwaysShowPile()) {
              // --- handle pending pile close ---
              if (state.pendingPileClose) {
                debugLog('[ContextMenu] popuphidden: pendingPileClose was set, closing pile now');
                hidePile();
                state.pendingPileClose = false;
              } else {
                hidePile();
              }
            }
          } else {
            // If still hovering, just clear the flag
            state.pendingPileClose = false;
          }
          schedulePileLayoutRepair("contextmenu-popuphidden", 150);
        }, 100);
      });

      // Copy to Clipboard
      podContextMenu.querySelector("#zenPilePodCopy").addEventListener("command", async () => {
        if (podContextMenuPodData) {
          try {
            await copyPodFileToClipboard(podContextMenuPodData);
          } catch (err) {
            showUserNotification(`Error copying file to clipboard: ${err.message}`);
          }
        }
      });

      // Delete File
      podContextMenu.querySelector("#zenPilePodDelete").addEventListener("command", async () => {
        if (podContextMenuPodData) {
          try {
            await deletePodFile(podContextMenuPodData);
          } catch (err) {
            showUserNotification(`Error deleting file: ${err.message}`);
          }
        }
      });
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
          Services.prefs.removeObserver(PREFS.alwaysShowPile, state.prefObserver);
          Services.prefs.removeObserver(PREFS.useLibraryButton, state.prefObserver);
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

      // Remove global references
      if (window.zenPileContextMenu) {
        window.zenPileContextMenu = null;
      }

      debugLog("Cleanup completed successfully");
    } catch (error) {
      ErrorHandler.handleError(error, 'cleanup');
    }
  }

  // Enhanced file operations with proper error handling
  async function openPodFile(podData) {
    debugLog(`Attempting to open file: ${podData.key}`);

    try {
      validatePodData(podData);

      if (!podData.targetPath) {
        throw new Error('No file path available');
      }

      const fileExists = await FileSystem.fileExists(podData.targetPath);
      if (fileExists) {
        const file = await FileSystem.createFileInstance(podData.targetPath);
        file.launch();
        debugLog(`Successfully opened file: ${podData.filename}`);
      } else {
        // File doesn't exist, try to open the containing folder
        const parentDir = await FileSystem.getParentDirectory(podData.targetPath);
        if (parentDir && parentDir.exists()) {
          parentDir.launch();
          debugLog(`File not found, opened containing folder: ${podData.filename}`);
        } else {
          throw new Error('File and folder not found');
        }
      }
    } catch (error) {
      ErrorHandler.handleError(error, 'openPodFile');
      debugLog(`Error opening file: ${podData.filename}`, error);
    }
  }

  // Enhanced file explorer function
  async function showPodFileInExplorer(podData) {
    debugLog(`Attempting to show file in file explorer: ${podData.key}`);

    try {
      validatePodData(podData);

      if (!podData.targetPath) {
        throw new Error('No file path available');
      }

      const fileExists = await FileSystem.fileExists(podData.targetPath);
      if (fileExists) {
        const file = await FileSystem.createFileInstance(podData.targetPath);

        try {
          // Try to reveal the file in the file manager
          file.reveal();
          debugLog(`Successfully showed file in explorer: ${podData.filename}`);
        } catch (revealError) {
          // If reveal() doesn't work, fall back to opening the containing folder
          debugLog(`Reveal failed, trying to open containing folder: ${revealError}`);
          const parentDir = await FileSystem.getParentDirectory(podData.targetPath);
          if (parentDir && parentDir.exists()) {
            parentDir.launch();
            debugLog(`Opened containing folder: ${podData.filename}`);
          } else {
            throw new Error('Containing folder not found');
          }
        }
      } else {
        // File doesn't exist, try to open the containing folder
        const parentDir = await FileSystem.getParentDirectory(podData.targetPath);
        if (parentDir && parentDir.exists()) {
          parentDir.launch();
          debugLog(`File not found, opened containing folder: ${podData.filename}`);
        } else {
          throw new Error('File and folder not found');
        }
      }
    } catch (error) {
      ErrorHandler.handleError(error, 'showPodFileInExplorer');
      debugLog(`Error showing file in explorer: ${podData.filename}`, error);
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init, { once: true });
  }

  // Cleanup on page unload
  window.addEventListener("beforeunload", cleanup, { once: true });

  debugLog("Dismissed downloads pile script loaded");


  // --- Start inline rename editing ---
  function startInlineRename(podData) {
    const podElement = state.getPodElement(podData.key);
    if (!podElement) {
      debugLog(`[Rename] Cannot start inline rename - pod element not found: ${podData.key}`);
      return;
    }
    
    const filenameElement = podElement.querySelector('.dismissed-pod-filename');
    if (!filenameElement) {
      debugLog(`[Rename] Cannot start inline rename - filename element not found`);
      return;
    }
    
    // Check if already editing
    if (state.isEditing) {
      debugLog(`[Rename] Already editing a filename`);
      return;
    }
    
    state.isEditing = true; // Prevent pile from hiding during editing
    
    // Ensure pile is visible during editing
    if (state.dynamicSizer && state.dismissedPods.size > 0) {
      showPile();
    }
    
    const originalText = filenameElement.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = originalText;
    input.style.cssText = `
      width: 100%;
      padding: 0;
      border: none;
      border-radius: 0;
      background: transparent;
      color: var(--zen-text-color, #e0e0e0);
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      margin-bottom: 2px;
      box-sizing: border-box;
      outline: none;
    `;
    
    // Select filename without extension
    const lastDotIndex = originalText.lastIndexOf('.');
    if (lastDotIndex > 0) {
      input.setSelectionRange(0, lastDotIndex);
    } else {
      input.select();
    }
    
    // Replace filename with input
    const parent = filenameElement.parentNode;
    parent.replaceChild(input, filenameElement);
    input.focus();
    
    const finishEditing = async (save = false) => {
      if (!state.isEditing) return;
      state.isEditing = false; // Allow pile to hide again after editing
      
      const newName = input.value.trim();
      if (save && newName && newName !== originalText) {
        try {
          debugLog(`[Rename] Inline rename: ${originalText} -> ${newName}`);
          await renamePodFile(podData, newName);
        } catch (error) {
          debugLog(`[Rename] Error renaming file:`, error);
          showUserNotification(`Error renaming file: ${error.message}`);
          // Restore original text on error
          input.value = originalText;
        }
      }
      
      // Restore filename element
      filenameElement.textContent = podData.filename || originalText;
      parent.replaceChild(filenameElement, input);
      
      // Check if we should hide the pile after editing (if not hovering)
      if (!getAlwaysShowPile() && !shouldDisableHover()) {
        // Small delay to allow DOM to update
        setTimeout(() => {
          const isHoveringDownloadArea = state.downloadButton?.matches(':hover');
          const isHoveringPile = isHoveringPileArea();
          
          // Only hide if not hovering over download button or pile
          if (!isHoveringDownloadArea && !isHoveringPile) {
            debugLog("[Rename] Editing finished, hiding pile (not hovering)");
            clearTimeout(state.hoverTimeout);
            state.hoverTimeout = setTimeout(() => {
              hidePile();
            }, CONFIG.hoverDebounceMs);
          }
        }, 50);
      }
    };
    
    input.addEventListener('blur', () => finishEditing(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finishEditing(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finishEditing(false);
      }
    });
  }

  // --- Global pod file rename logic ---
  async function renamePodFile(podData, newFilename) {
    try {
      validatePodData(podData);
      if (!newFilename || typeof newFilename !== 'string') {
        throw new Error('Invalid new filename');
      }
      if (!podData.targetPath) {
        throw new Error('No file path available for renaming');
      }
      // Use the FileSystem utility for safe file operations (auto-increment)
      const newPath = await FileSystem.renameFile(podData.targetPath, newFilename);
      // Update pod data
      const oldFilename = podData.filename;
      // Extract the actual new filename from the path
      const newName = newPath.split(/[/\\]/).pop();
      podData.filename = newName;
      podData.targetPath = newPath;
      // Update the pod in our local storage
      state.setPodData(podData.key, podData);
      // Save updated pod data to SessionStore for persistence
      saveDismissedPodToSession(podData);
      // Update the pod element
      const podElement = state.getPodElement(podData.key);
      if (podElement) {
        podElement.title = `${newName}\nClick: Open file\nMiddle-click: Show in file explorer\nRight-click: Context menu`;

        // Update the displayed filename in the DOM
        const filenameElement = podElement.querySelector('.dismissed-pod-filename');
        if (filenameElement) {
          filenameElement.textContent = newName;
          debugLog(`[Rename] Updated displayed filename in DOM: ${newName}`);
        }

        // Force UI refresh if needed (e.g., update label/icon)
        if (podElement.querySelector('.dismissed-pod-preview')) {
          // Optionally update preview/icon if needed
          // podElement.querySelector('.dismissed-pod-preview').textContent = getFileIcon(podData.contentType);
        }
      }
      // Try to update the main script's dismissed pods if the API exists
      if (window.zenTidyDownloads && window.zenTidyDownloads.dismissedPods) {
        try {
          const mainScriptPod = window.zenTidyDownloads.dismissedPods.get(podData.key);
          if (mainScriptPod) {
            mainScriptPod.filename = newName;
            mainScriptPod.targetPath = newPath;
            window.zenTidyDownloads.dismissedPods.set(podData.key, mainScriptPod);
            debugLog(`[Rename] Updated main script pod data`);
          }
        } catch (error) {
          debugLog(`[Rename] Could not update main script pod data:`, error);
        }
      }
      // Try to update Firefox downloads list
      try {
        const list = await window.Downloads.getList(window.Downloads.ALL);
        const downloads = await list.getAll();
        // Find the download that matches our pod
        const targetDownload = downloads.find(download =>
          download.target?.path === podData.targetPath.replace(newName, oldFilename) ||
          (download.source?.url === podData.sourceUrl &&
            download.target?.path?.endsWith(oldFilename))
        );
        if (targetDownload && targetDownload.target) {
          targetDownload.target.path = newPath;
          debugLog(`[Rename] Updated Firefox download record`);
        }
      } catch (error) {
        debugLog(`[Rename] Could not update Firefox download record:`, error);
      }
      debugLog(`[Rename] Successfully renamed file: ${oldFilename} -> ${newName}`);
    } catch (error) {
      showUserNotification(`Error renaming file: ${error.message}`);
      throw error;
    }
  }

  // --- Helper for user notifications ---
  function showUserNotification(message, type = 'error') {
    // Simple alert for now; could be replaced with a custom toast/notification
    alert(message);
  }

  // --- Enhanced filename validation ---
  function isValidFilename(name) {
    // Windows forbidden chars: \\ / : * ? " < > |
    // Also disallow empty or all-whitespace
    return (
      typeof name === 'string' &&
      name.trim().length > 0 &&
      !/[\\/:*?"<>|]/.test(name)
    );
  }

  // --- Clipboard file copy logic ---
  async function copyPodFileToClipboard(podData) {
    debugLog(`[Clipboard] Attempting to copy file to clipboard: ${podData.filename}`);
    try {
      validatePodData(podData);
      if (!podData.targetPath) {
        throw new Error('No file path available');
      }
      const fileExists = await FileSystem.fileExists(podData.targetPath);
      if (!fileExists) {
        throw new Error('File does not exist');
      }
      // Get nsIFile instance
      const file = await FileSystem.createFileInstance(podData.targetPath);
      // Prepare transferable
      const transferable = Components.classes["@mozilla.org/widget/transferable;1"].createInstance(Components.interfaces.nsITransferable);
      transferable.init(null);
      // Add file flavor
      transferable.addDataFlavor("application/x-moz-file");
      transferable.setTransferData("application/x-moz-file", file);
      // Get clipboard
      const clipboard = Components.classes["@mozilla.org/widget/clipboard;1"].getService(Components.interfaces.nsIClipboard);
      clipboard.setData(transferable, null, Components.interfaces.nsIClipboard.kGlobalClipboard);
      debugLog(`[Clipboard] File copied to clipboard: ${podData.filename}`);
    } catch (error) {
      ErrorHandler.handleError(error, 'copyPodFileToClipboard');
      throw error;
    }
  }

  // --- Delete file from system ---
  async function deletePodFile(podData) {
    debugLog(`[DeleteFile] Attempting to delete file from system: ${podData.filename}`);
    try {
      validatePodData(podData);

      const confirmed = Services.prompt.confirm(
        window,
        'Delete File',
        `Are you sure you want to permanently delete "${podData.filename}"?\n\nThis action cannot be undone.`
      );

      if (!confirmed) {
        debugLog(`[DeleteFile] User cancelled deletion`);
        return;
      }

      let resolvedDownload = null;
      if (
        window.zenTidyDownloads &&
        typeof window.zenTidyDownloads.resolveDownloadFromPodData === 'function'
      ) {
        try {
          resolvedDownload = await window.zenTidyDownloads.resolveDownloadFromPodData(podData);
        } catch (resolveErr) {
          debugLog(`[DeleteFile] resolveDownloadFromPodData failed:`, resolveErr);
        }
      }

      const pathCandidates = [];
      if (resolvedDownload?.target?.path) {
        pathCandidates.push(resolvedDownload.target.path);
      }
      if (podData.targetPath) {
        pathCandidates.push(podData.targetPath);
      }
      const uniquePaths = [...new Set(pathCandidates.filter(Boolean))];

      let pathToDelete = null;
      for (const p of uniquePaths) {
        if (await FileSystem.fileExists(p)) {
          pathToDelete = p;
          break;
        }
      }

      if (!pathToDelete) {
        debugLog(
          `[DeleteFile] No file at Firefox-reported or saved path; clearing pile and downloads entry only: ${podData.filename}`
        );
        try {
          await removeDownloadFromFirefoxList(podData, resolvedDownload);
        } catch (error) {
          debugLog(`[DeleteFile] Could not remove from Firefox downloads list:`, error);
        }
        removePodFromPile(podData.key);
        if (window.zenTidyDownloads && window.zenTidyDownloads.dismissedPods) {
          try {
            window.zenTidyDownloads.dismissedPods.delete(podData.key);
          } catch (error) {
            debugLog(`[DeleteFile] Could not remove from main script dismissed pods:`, error);
          }
        }
        return;
      }

      const deleted = await FileSystem.deleteFile(pathToDelete);
      if (!deleted) {
        throw new Error('File deletion failed');
      }

      debugLog(`[DeleteFile] Successfully deleted file at ${pathToDelete}: ${podData.filename}`);

      try {
        await removeDownloadFromFirefoxList(podData, resolvedDownload);
      } catch (error) {
        debugLog(`[DeleteFile] Could not remove from Firefox downloads list:`, error);
      }

      removePodFromPile(podData.key);

      if (window.zenTidyDownloads && window.zenTidyDownloads.dismissedPods) {
        try {
          window.zenTidyDownloads.dismissedPods.delete(podData.key);
          debugLog(`[DeleteFile] Removed from main script dismissed pods`);
        } catch (error) {
          debugLog(`[DeleteFile] Could not remove from main script dismissed pods:`, error);
        }
      }
    } catch (error) {
      ErrorHandler.handleError(error, 'deletePodFile');
      throw error;
    }
  }

  // Utility to check if the pod context menu is visible (or opening)
  function isContextMenuVisible() {
    if (state.pileContextMenuActive) return true;
    const menu = document.getElementById('zen-pile-pod-context-menu');
    return Boolean(menu && typeof menu.state === 'string' && menu.state === 'open');
  }

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
