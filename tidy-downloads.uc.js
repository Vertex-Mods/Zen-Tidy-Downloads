// ==UserScript==
// @include   main
// @loadOrder    99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads.uc.js
// AI-powered download preview and renaming with Mistral vision API support
(function () {
  "use strict";

  // Use Components for Firefox compatibility
  const { classes: Cc, interfaces: Ci } = Components;

  // Wait for browser window to be ready
  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  // === POPUP WINDOW EXCLUSION CHECKS ===
  // Method 1: Check window type attribute
  if (document.documentElement.getAttribute('windowtype') !== 'navigator:browser') {
    console.log('Zen Tidy Downloads: Skipping - not a main browser window (windowtype check)');
    return;
  }

  // Method 2: Check if this is a popup by examining window features
  try {
    // Check if window has minimal UI (characteristic of popups)
    if (window.toolbar && !window.toolbar.visible) {
      console.log('Zen Tidy Downloads: Skipping - appears to be a popup (toolbar check)');
      return;
    }
    
    // Check window opener (popups usually have an opener)
    if (window.opener) {
      console.log('Zen Tidy Downloads: Skipping - window has opener (popup check)');
      return;
    }
  } catch (e) {
    // If we can't check these properties, continue but log it
    console.log('Zen Tidy Downloads: Could not check window properties:', e);
  }

  // Method 3: Check for essential browser UI elements that should exist in main window
  // Wait a bit for DOM to be ready, then check for main browser elements
  setTimeout(() => {
    const mainBrowserElements = [
      '#navigator-toolbox',  // Main toolbar container
      '#browser',            // Browser element
      '#sidebar-box'         // Sidebar container
    ];
    
    const missingElements = mainBrowserElements.filter(selector => !document.querySelector(selector));
    
    if (missingElements.length > 0) {
      console.log('Zen Tidy Downloads: Skipping - missing main browser elements:', missingElements);
      return;
    }
    
    // Method 4: Check window size (popups are usually smaller)
    if (window.outerWidth < 400 || window.outerHeight < 300) {
      console.log('Zen Tidy Downloads: Skipping - window too small (likely popup)');
      return;
    }
    
    // Method 5: Check for dialog-specific attributes
    if (document.documentElement.hasAttribute('dlgtype')) {
      console.log('Zen Tidy Downloads: Skipping - dialog window detected');
      return;
    }
    
    // If all checks pass, continue with initialization
    console.log('Zen Tidy Downloads: All popup exclusion checks passed, proceeding with initialization');

    // Single-flight: duplicate script evaluation would register listeners twice. Only arm after
    // we know this is the real browser chrome (popup checks above).
    if (window.__zenTidyDownloadsBundleExecuted) {
      console.warn("[Tidy Downloads] Bundle already executed in this window; skipping duplicate load.");
      return;
    }
    window.__zenTidyDownloadsBundleExecuted = true;
    
    // === MAIN SCRIPT INITIALIZATION CONTINUES HERE ===
    // Wait for utils (handles load-order races; utils must be in theme.json scripts)
    // Dependency order:
    // 1) core modules (utils/store/downloads-adapter), 2) feature modules (pods/tooltip/public-api/fileops/ai),
    // 3) orchestration support modules (download-ui/card-lifecycle/compact/listener), 4) this orchestrator.
    (function tryInit(attempt) {
      const utilsReady = window.zenTidyDownloadsUtils;
      const storeReady = window.zenTidyDownloadsStore?.createStore;
      const dlAdapterReady = window.zenTidyDownloadsDownloadsAdapter;
      const podsReady = window.zenTidyDownloadsPods?.init;
      const tooltipLayoutReady = window.zenTidyDownloadsTooltipLayout?.init;
      const publicApiReady = window.zenTidyDownloadsPublicApi?.createPublicApi;
      const fileopsReady = window.zenTidyDownloadsFileOps?.createRenameHandlers;
      const aiReady = window.zenTidyDownloadsAIRename?.init;
      const uiReady = window.zenTidyDownloadsDownloadUi?.init;
      const lifecycleReady = window.zenTidyDownloadsCardLifecycle?.createCardLifecycle;
      const compactReady = window.zenTidyDownloadsCompactVisibility?.createCompactVisibility;
      const listenerReady = window.zenTidyDownloadsDownloadsListener?.createController;
      if (
        utilsReady &&
        storeReady &&
        dlAdapterReady &&
        podsReady &&
        tooltipLayoutReady &&
        publicApiReady &&
        fileopsReady &&
        aiReady &&
        uiReady &&
        lifecycleReady &&
        compactReady &&
        listenerReady
      ) {
        initializeMainScript();
        return;
      }
      if (attempt < 40) { // ~2 seconds max (40 * 50ms)
        setTimeout(() => tryInit(attempt + 1), 50);
        return;
      }
      console.error(
        "[Tidy Downloads] Missing modules after 2s. Verify all tidy-downloads modules are loaded before tidy-downloads.uc.js."
      );
    })(0);
  }, 100); // Small delay to ensure DOM elements are loaded

  // === MAIN SCRIPT FUNCTIONS ===
  function initializeMainScript() {
    const Utils = window.zenTidyDownloadsUtils;
    if (!Utils) return;

    if (window.__zenTidyDownloadsMainInitialized) {
      console.warn("[Tidy Downloads] initializeMainScript already ran in this window; skip duplicate.");
      return;
    }
    window.__zenTidyDownloadsMainInitialized = true;
    const {
      getPref,
      SecurityUtils,
      RateLimiter,
      debugLog,
      redactSensitiveData,
      MISTRAL_API_KEY_PREF,
      DISABLE_AUTOHIDE_PREF,
      IMAGE_LOAD_ERROR_ICON,
      TEMP_LOADER_ICON,
      RENAMED_SUCCESS_ICON,
      IMAGE_EXTENSIONS,
      PATH_SEPARATOR,
      sanitizeFilename,
      waitForElement,
      formatBytes
    } = Utils;

    // Toast notifications from modules/toasts.uc.js
    const Toasts = window.zenTidyDownloadsToasts;
    const showSimpleToast = Toasts?.showSimpleToast || (() => {});
    const showRenameToast = Toasts?.showRenameToast || (() => null);

    // Animation module (downloads button detection, animation targeting, indicator patches)
    const animationApi = window.zenTidyDownloadsAnimation?.init({ waitForElement, debugLog }) || {
      findDownloadsButton: async () => null,
      patchDownloadsIndicatorMethods: () => {}
    };
    const { findDownloadsButton, patchDownloadsIndicatorMethods, cleanup: cleanupAnimation } = animationApi;

    // CRITICAL: Patch downloads indicator methods immediately to prevent errors
    patchDownloadsIndicatorMethods();

    if (typeof cleanupAnimation === "function") {
      window.addEventListener("beforeunload", cleanupAnimation, { once: true });
    }
    
    // --- Configuration via Firefox Preferences ---
    // Available preferences (set in about:config):
    // extensions.downloads.mistral_api_key - Your Mistral API key (required for AI renaming)
    // extensions.downloads.enable_debug - Enable debug logging (default: false)
    // extensions.downloads.debug_ai_only - Only log AI-related messages (default: true)
    // extensions.downloads.enable_ai_renaming - Enable AI-powered file renaming (default: true)
    // extensions.downloads.disable_autohide - Disable automatic hiding of completed downloads (default: false)
    // extensions.downloads.autohide_delay_ms - Delay before auto-hiding completed downloads (default: 10000)
    // extensions.downloads.interaction_grace_period_ms - Grace period after user interaction (default: 5000)
    // extensions.downloads.max_filename_length - Maximum length for AI-generated filenames (default: 70)
    // extensions.downloads.max_file_size_for_ai - Maximum file size for AI processing in bytes (default: 52428800 = 50MB)
    // extensions.downloads.mistral_api_url - Mistral API endpoint (default: "https://api.mistral.ai/v1/chat/completions")
    // extensions.downloads.mistral_model - Mistral model to use (default: "pixtral-large-latest")
    // extensions.downloads.stable_focus_mode - Prevent focus switching during multiple downloads (default: true)
    // extensions.downloads.show_old_downloads_hours - How many hours back to show old completed downloads on startup (default: 2)
    // zen.tidy-downloads.use-library-button - Use zen-library-button instead of downloads-button for hover detection (default: false)

    const DownloadsAdapter = window.zenTidyDownloadsDownloadsAdapter;
    const store = window.zenTidyDownloadsStore.createStore({ getPref });
    const {
      activeDownloadCards,
      renamedFiles,
      cardUpdateThrottle,
      sidebarWidthRef,
      focusedKeyRef,
      orderedPodKeys,
      dismissedDownloads,
      stickyPods,
      permanentlyDeletedPaths,
      permanentlyDeletedMeta,
      MAX_PERMANENTLY_DELETED_PATHS,
      actualDownloadRemovedEventListeners,
      dismissedPodsData,
      dismissEventListeners
    } = store;

    // DOM + session (not on store)
    let downloadCardsContainer;
    let aiRenamingPossible = false;
    let podsRowContainerElement = null;
    let masterTooltipDOMElement = null;
    let initSidebarWidthSyncFn = () => { };
    /** @type {{ getDownloadViewListener: function(): Object, destroy: function(): void }|null} */
    let libraryPieController = null;

    // File operations module (open, erase from history, content-type)
    const fileOpsApi = window.zenTidyDownloadsFileOps?.init({ SecurityUtils, debugLog }) || {
      openDownloadedFile: () => {},
      eraseDownloadFromHistory: async () => {},
      getContentTypeFromFilename: () => "application/octet-stream"
    };
    const { openDownloadedFile, eraseDownloadFromHistory, getContentTypeFromFilename } = fileOpsApi;

    // Preview module (icons, file preview, color extraction)
    const previewApi = window.zenTidyDownloadsPreview?.init({
      IMAGE_EXTENSIONS,
      debugLog,
      getPref,
      focusedKeyRef
    }) || {
      setGenericIcon: (el, ct) => {
        if (!el) return;
        let icon = "📄";
        if (typeof ct === "string") {
          if (ct.includes("image/")) icon = "🖼️";
          else if (ct.includes("video/")) icon = "🎬";
          else if (ct.includes("audio/")) icon = "🎵";
        }
        el.innerHTML = `<span style="font-size: 24px;">${icon}</span>`;
        el.style.display = "flex";
        el.style.alignItems = "center";
        el.style.justifyContent = "center";
      },
      setCompletedFilePreview: async (el, d) => {
        if (el && d) previewApi.setGenericIcon(el, d?.contentType);
      },
      updatePodGlowColor: () => {}
    };

    // AI Rename module (wired after createRenameHandlers, before init())
    let addToAIRenameQueue = () => false;
    let removeFromAIRenameQueue = () => false;
    let cancelAIProcessForDownload = async () => false;
    let isInQueue = () => false;
    let getQueuePosition = () => -1;
    let updateQueueStatusInUI = () => {};
    let throttledCreateOrUpdateCard = function () {};

    const tooltipLayoutRef = {
      updateUIForFocusedDownload() {},
      managePodVisibilityAndAnimations() {},
      handlePodScrollFocus() {}
    };

    function updateUIForFocusedDownload(keyToFocus, isNewOrSignificantUpdate = false) {
      tooltipLayoutRef.updateUIForFocusedDownload(keyToFocus, isNewOrSignificantUpdate);
    }
    function managePodVisibilityAndAnimations() {
      tooltipLayoutRef.managePodVisibilityAndAnimations();
    }
    function handlePodScrollFocus(event) {
      tooltipLayoutRef.handlePodScrollFocus(event);
    }

    function fireCustomEvent(eventName, detail) {
      try {
        const event = new CustomEvent(eventName, { 
          detail, 
          bubbles: true, 
          cancelable: true 
        });
        document.dispatchEvent(event);
        debugLog(`[Events] Fired custom event: ${eventName}`, detail);
      } catch (error) {
        debugLog(`[Events] Error firing custom event ${eventName}:`, error);
      }
    }

    window.zenTidyDownloads = window.zenTidyDownloadsPublicApi.createPublicApi({
      store,
      debugLog,
      SecurityUtils,
      DownloadsAdapter,
      getDownloadKey,
      getThrottledCreateOrUpdateCard: () => throttledCreateOrUpdateCard,
      fireCustomEvent,
      Cc,
      Ci
    });

    function capturePodDataForDismissal(downloadKey) {
      return lifecycleApi.capturePodDataForDismissal(downloadKey);
    }

    // Improved key generation for downloads
    function getDownloadKey(download) {
      // Use target path as primary key since id is often undefined
      if (download?.target?.path) {
        return download.target.path;
      }
      if (download?.id) {
        return download.id;
      }
      // For failed downloads, generate a more stable key based on URL and start time
      const url = download?.source?.url || download?.url || "unknown";
      const startTime = download?.startTime || Date.now();
      const key = `temp_${url}_${startTime}`;
      
      debugLog(`[KeyGen] Generated temporary key for download without path/id`, { 
        key, 
        hasPath: !!download?.target?.path, 
        hasId: !!download?.id, 
        url, 
        error: !!download?.error,
        startTime 
      });
      
      return key;
    }

    // Get safe filename from download object
    function getSafeFilename(download) {
      // Try multiple sources for filename
      if (download.filename) return download.filename;
      if (download.target?.path) {
        return download.target.path.split(/[\\/]/).pop();
      }
      if (download.source?.url) {
        const url = download.source.url;
        const match = url.match(/\/([^\/\?]+)$/);
        if (match) return match[1];
      }
      return "Untitled";
    }

    const tidyDeps = {
      SecurityUtils,
      debugLog,
      sanitizeFilename,
      PATH_SEPARATOR,
      Cc,
      Ci,
      scheduleCardRemoval,
      performAutohideSequence,
      updateUIForFocusedDownload,
      getMasterTooltip: () => masterTooltipDOMElement,
      /** @type {(oldKey: string, newKey: string) => void} */
      migrateAIRenameKeys() {}
    };

    const { renameDownloadFileAndUpdateRecord, undoRename } = window.zenTidyDownloadsFileOps.createRenameHandlers({
      store,
      deps: tidyDeps
    });

    const aiDeps = {
      ...tidyDeps,
      renameDownloadFileAndUpdateRecord,
      getPref,
      RateLimiter,
      redactSensitiveData,
      formatBytes,
      getContentTypeFromFilename,
      MISTRAL_API_KEY_PREF,
      IMAGE_EXTENSIONS,
      previewApi,
      showRenameToast,
      showSimpleToast,
      getDownloadKey
    };

    (function initAIRenameModule() {
      const api = window.zenTidyDownloadsAIRename?.init({
        store,
        deps: aiDeps
      });
      if (api) {
        addToAIRenameQueue = api.addToAIRenameQueue;
        removeFromAIRenameQueue = api.removeFromAIRenameQueue;
        cancelAIProcessForDownload = api.cancelAIProcessForDownload;
        isInQueue = api.isInQueue;
        getQueuePosition = api.getQueuePosition;
        updateQueueStatusInUI = api.updateQueueStatusInUI;
        tidyDeps.migrateAIRenameKeys = api.migrateAIRenameKeys;
      }
    })();

    const compactVisibilityApi = window.zenTidyDownloadsCompactVisibility.createCompactVisibility({
      debugLog,
      orderedPodKeys,
      getDownloadCardsContainer: () => downloadCardsContainer,
      getMasterTooltip: () => masterTooltipDOMElement,
      getPodsRowContainer: () => podsRowContainerElement
    });

    const lifecycleApi = window.zenTidyDownloadsCardLifecycle.createCardLifecycle({
      store,
      debugLog,
      getPref,
      DISABLE_AUTOHIDE_PREF,
      getSafeFilename,
      fireCustomEvent,
      updateUIForFocusedDownload,
      cancelAIProcessForDownload: (key) => cancelAIProcessForDownload(key),
      getDownloadCardsContainer: () => downloadCardsContainer,
      getMasterTooltip: () => masterTooltipDOMElement,
      getPodsRowContainer: () => podsRowContainerElement
    });

    async function init() {
      console.log("=== DOWNLOAD PREVIEW SCRIPT STARTING ===");
      debugLog("Starting initialization");
      if (!DownloadsAdapter.isAvailable()) {
        console.error("Download Preview Mistral AI: Downloads API not available");
        aiRenamingPossible = false;
        return;
      }
      try {
        DownloadsAdapter.getAllDownloadsList()
          .then(async (list) => {
            if (list) {
              debugLog("Downloads API verified");
              aiRenamingPossible = true; // Local AI is assumed to be available
              debugLog("AI renaming enabled - using Local AI");
              await initDownloadManager();
              initSidebarWidthSyncFn();
              debugLog("Initialization complete");
            }
          })
          .catch((e) => {
            console.error("Downloads API verification failed:", e);
            aiRenamingPossible = false;
          });
      } catch (e) {
        console.error("Download Preview Mistral AI: Init failed", e);
        aiRenamingPossible = false;
      }
    }

    // Wait for window load
    if (document.readyState === "complete") {
      init();
    } else {
      window.addEventListener("load", init, { once: true });
    }

    // Download manager UI and listeners
    async function initDownloadManager() {
      await new Promise((resolve) => setTimeout(resolve, 300));
      debugLog("Creating download manager UI elements...");

      try {
        const downloadsButton = await findDownloadsButton();
        if (!downloadsButton) {
          console.warn("[Tidy Downloads] Downloads button not found - hover detection may not work properly");
        }

        const uiApi = await window.zenTidyDownloadsDownloadUi.init({
          debugLog,
          removeCard,
          undoRename,
          cancelAIProcessForDownload: (key) => cancelAIProcessForDownload(key),
          eraseDownloadFromHistory,
          getFocusedKey: () => focusedKeyRef.current,
          getActiveCardByKey: (key) => activeDownloadCards.get(key),
          clearAllStickyPods,
          onPileHiddenRepair: () => {
            debugLog("[PileRepair] pile-hidden: restore download chrome + focus invariants");
            updateDownloadCardsVisibility();
            if (focusedKeyRef.current && !activeDownloadCards.has(focusedKeyRef.current)) {
              focusedKeyRef.current =
                orderedPodKeys.length > 0 ? orderedPodKeys[orderedPodKeys.length - 1] : null;
              updateUIForFocusedDownload(focusedKeyRef.current, false);
            }
          },
          setupCompactModeObserver
        });
        downloadCardsContainer = uiApi.getDownloadCardsContainer();
        masterTooltipDOMElement = uiApi.getMasterTooltip();
        podsRowContainerElement = uiApi.getPodsRow();

        Object.assign(
          tooltipLayoutRef,
          window.zenTidyDownloadsTooltipLayout.init({
            store,
            getPref,
            debugLog,
            formatBytes,
            previewApi,
            getAiRenamingPossible: () => aiRenamingPossible,
            addToAIRenameQueue,
            scheduleCardRemoval,
            isInQueue,
            updateQueueStatusInUI,
            getMasterTooltip: () => masterTooltipDOMElement,
            getPodsRowContainer: () => podsRowContainerElement,
            getDownloadCardsContainer: () => downloadCardsContainer,
            updateDownloadCardsVisibility
          })
        );

        if (window.zenTidyDownloadsSync?.init && masterTooltipDOMElement && podsRowContainerElement) {
          const syncFns = window.zenTidyDownloadsSync.init({
            getMasterTooltip: () => masterTooltipDOMElement,
            getPodsContainer: () => podsRowContainerElement,
            getActiveCards: () => activeDownloadCards,
            focusedKeyRef,
            updateUI: (k, b) => updateUIForFocusedDownload(k, b),
            sidebarWidthRef,
            debugLog
          });
          initSidebarWidthSyncFn = syncFns.initSidebarWidthSync;
        }

        if (podsRowContainerElement) {
          podsRowContainerElement.addEventListener("wheel", handlePodScrollFocus, { passive: false });
        }

        const podsApi = window.zenTidyDownloadsPods.init({
          store,
          getPref,
          debugLog,
          getDownloadKey,
          getSafeFilename,
          previewApi,
          openDownloadedFile,
          getContentTypeFromFilename,
          SecurityUtils,
          Cc,
          Ci,
          getAddToAIRenameQueue: () => addToAIRenameQueue,
          getAiRenamingPossible: () => aiRenamingPossible,
          scheduleCardRemoval,
          clearStickyPodsOnly,
          updateDownloadCardsVisibility,
          updateUIForFocusedDownload,
          getPodsRowContainer: () => podsRowContainerElement,
          migrateAIRenameKeys: (oldKey, newKey) => tidyDeps.migrateAIRenameKeys(oldKey, newKey)
        });
        throttledCreateOrUpdateCard = podsApi.throttledCreateOrUpdateCard;

        if (window.zenTidyDownloadsLibraryPie?.createController) {
          libraryPieController = window.zenTidyDownloadsLibraryPie.createController({ getPref, debugLog });
        }

        const downloadsListenerController = window.zenTidyDownloadsDownloadsListener.createController({
          store,
          DownloadsAdapter,
          debugLog,
          getDownloadKey,
          getPref,
          cancelAIProcessForDownload: (key) => cancelAIProcessForDownload(key),
          removeCard,
          fireCustomEvent,
          getThrottledCreateOrUpdateCard: () => throttledCreateOrUpdateCard,
          getLibraryPieController: () => libraryPieController
        });
        downloadsListenerController.start();
      } catch (e) {
        console.error("DL Preview Mistral AI: Init error", e);
      }
    }

  async function removeCard(downloadKey, force = false) {
    return lifecycleApi.removeCard(downloadKey, force);
  }

  function scheduleCardRemoval(downloadKey) {
    lifecycleApi.scheduleCardRemoval(downloadKey);
  }

  // Perform auto-dismiss: hide the tooltip, keep the pod visible (sticky), and silently add to pile.
  async function performAutohideSequence(downloadKey) {
    await lifecycleApi.performAutohideSequence(downloadKey);
  }

  // Make a pod sticky: hide its tooltip, add it to the pile silently, keep it visible in the pods row.
  // The pod will be removed from the pods row only when the pile expands on hover.
  async function makePodSticky(downloadKey) {
    await lifecycleApi.makePodSticky(downloadKey);
  }

  // Remove a single sticky pod from the pods row (called when pile expands).
  // Caller hides the pods row container first, so we remove immediately.
  function clearStickyPod(downloadKey) {
    lifecycleApi.clearStickyPod(downloadKey);
  }

  // Remove all sticky pods from the pods row (called when the pile expands).
  function clearAllStickyPods() {
    lifecycleApi.clearAllStickyPods();
  }

  // Remove sticky pods from DOM and state but keep containers visible (for new download replacing stickies).
  function clearStickyPodsOnly() {
    lifecycleApi.clearStickyPodsOnly();
  }

  // renameDownloadFileAndUpdateRecord, undoRename: tidy-downloads-fileops.uc.js (createRenameHandlers)

  // Setup compact mode observer to handle visibility changes
  function setupCompactModeObserver() {
    compactVisibilityApi.setupCompactModeObserver();
  }
  
  // Update download cards container visibility based on compact mode
  function updateDownloadCardsVisibility() {
    compactVisibilityApi.updateDownloadCardsVisibility();
  }

  console.log("=== DOWNLOAD PREVIEW SCRIPT LOADED SUCCESSFULLY ===");

  } // Close initializeMainScript function

})();
