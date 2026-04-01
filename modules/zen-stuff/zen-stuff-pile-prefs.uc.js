// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-pile-prefs.uc.js
// Firefox prefs, compact/sidebar MutationObserver, pointer-events, preference observers.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  /** @type {{ alwaysShowPile: string, useLibraryButton: string }} */
  const PREFS = {
    alwaysShowPile: "zen.stuff-pile.always-show",
    useLibraryButton: "zen.tidy-downloads.use-library-button"
  };

  window.zenStuffPilePrefs = {
    PREFS,

    /**
     * @param {Object} ctx
     * @param {Object} ctx.state
     * @param {function(string, *=): void} ctx.debugLog
     * @param {function(): void} ctx.getShowPile
     * @param {function(): void} ctx.getHidePile
     * @param {function(): Promise<void>} ctx.findDownloadButton
     * @returns {{
     *  getAlwaysShowPile: function(): boolean,
     *  getUseLibraryButton: function(): boolean,
     *  shouldPileBeVisible: function(): boolean,
     *  setupCompactModeObserver: function(): void,
     *  setupPreferenceListener: function(): void,
     *  updatePointerEvents: function(): void,
     *  updateDownloadsButtonVisibility: function(): void,
     *  initPileSidebarWidthSync: function(): void
     * }}
     */
    createPilePrefsApi(ctx) {
      const { state, debugLog, getShowPile, getHidePile, findDownloadButton } = ctx;

      function getAlwaysShowPile() {
        try {
          return Services.prefs.getBoolPref(PREFS.alwaysShowPile, false);
        } catch (e) {
          debugLog("Error reading always-show-pile preference, using default (false):", e);
          return false;
        }
      }

      function getUseLibraryButton() {
        try {
          const value = Services.prefs.getBoolPref(PREFS.useLibraryButton, false);
          console.log(`[Zen Stuff] getUseLibraryButton() returning: ${value}`);
          console.log(`[Zen Stuff] Preference name: ${PREFS.useLibraryButton}`);

          const libraryBtn = document.getElementById("zen-library-button");
          const downloadsBtn = document.getElementById("downloads-button");
          console.log(`[Zen Stuff] Available buttons - Library: ${!!libraryBtn}, Downloads: ${!!downloadsBtn}`);

          return value;
        } catch (e) {
          console.log(`[Zen Stuff] Error reading use-library-button preference, using default (false):`, e);
          debugLog("Error reading use-library-button preference, using default (false):", e);
          return false;
        }
      }

      function shouldPileBeVisible() {
        if (state.dismissedPods.size === 0) return false;

        if (getAlwaysShowPile()) {
          return !state.isAltPressed;
        }
        return false;
      }

      function handleAlwaysShowPileChange(newValue) {
        debugLog(`[Preferences] Handling always-show-pile change to: ${newValue}`);

        if (state.dismissedPods.size === 0) {
          debugLog("[Preferences] No dismissed pods, nothing to do");
          return;
        }

        if (newValue) {
          if (shouldPileBeVisible()) {
            getShowPile();
            debugLog("[Preferences] Switched to always-show mode - showing pile");
          }
        } else {
          if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
            getHidePile();
            debugLog("[Preferences] Switched to hover mode - hiding pile");
          }
        }
      }

      function setupPreferenceListener() {
        try {
          const prefObserver = {
            observe(subject, topic, data) {
              if (topic === "nsPref:changed") {
                if (data === PREFS.alwaysShowPile) {
                  const newValue = getAlwaysShowPile();
                  debugLog(`[Preferences] Always-show-pile preference changed to: ${newValue}`);
                  handleAlwaysShowPileChange(newValue);
                } else if (data === PREFS.useLibraryButton) {
                  const newValue = getUseLibraryButton();
                  console.log(`[Zen Stuff] Use-library-button preference changed to: ${newValue}`);
                  debugLog(`[Preferences] Use-library-button preference changed to: ${newValue}`);
                  findDownloadButton().catch((error) => {
                    console.error("[Preferences] Error re-finding download button:", error);
                  });
                }
              }
            }
          };

          Services.prefs.addObserver(PREFS.alwaysShowPile, prefObserver, false);
          Services.prefs.addObserver(PREFS.useLibraryButton, prefObserver, false);
          debugLog("[Preferences] Added observers for preferences");

          state.prefObserver = prefObserver;
        } catch (e) {
          debugLog("[Preferences] Error setting up preference observer:", e);
        }
      }

      function setupCompactModeObserver() {
        const zenMainAppWrapper = document.getElementById("zen-main-app-wrapper");
        const targetElement = zenMainAppWrapper || document.documentElement;

        if (!targetElement) {
          debugLog("[CompactModeObserver] Target element not found, cannot set up observer");
          return;
        }

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === "attributes") {
              const attributeName = mutation.attributeName;
              if (attributeName === "zen-compact-mode" || attributeName === "zen-sidebar-expanded") {
                debugLog(`[CompactModeObserver] ${attributeName} changed, updating pile visibility`);
                if (state.dynamicSizer && state.dismissedPods.size > 0) {
                  const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
                  const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";

                  if (isCompactMode && !isSidebarExpanded) {
                    state.dynamicSizer.style.display = "none";
                  } else if (shouldPileBeVisible()) {
                    getShowPile();
                  }
                }
              }
            }
          }
        });

        observer.observe(targetElement, {
          attributes: true,
          attributeFilter: ["zen-compact-mode", "zen-sidebar-expanded"]
        });

        if (targetElement !== document.documentElement) {
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["zen-sidebar-expanded"]
          });
        }

        debugLog("[CompactModeObserver] Set up observer for compact mode changes");
      }

      function updatePointerEvents() {
        if (!state.dynamicSizer || !state.pileContainer) return;
        const alwaysShow = getAlwaysShowPile();
        if (alwaysShow) {
          state.dynamicSizer.style.pointerEvents = "none";
          state.pileContainer.style.pointerEvents = "auto";
        } else {
          state.dynamicSizer.style.pointerEvents = "auto";
          state.pileContainer.style.pointerEvents = "auto";
        }
      }

      function updateDownloadsButtonVisibility() {
        debugLog(
          `[DownloadsButton] Button visibility managed by hover - ${state.dismissedPods.size} dismissed pods`
        );
      }

      function initPileSidebarWidthSync() {
        debugLog(
          "[PileWidthSync] initPileSidebarWidthSync called but automatic sync is disabled to prevent feedback loops."
        );
      }

      return {
        getAlwaysShowPile,
        getUseLibraryButton,
        shouldPileBeVisible,
        setupCompactModeObserver,
        setupPreferenceListener,
        updatePointerEvents,
        updateDownloadsButtonVisibility,
        initPileSidebarWidthSync
      };
    }
  };
})();
