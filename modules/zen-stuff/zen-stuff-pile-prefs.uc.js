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

  /** @type {{ useLibraryButton: string }} */
  const PREFS = {
    useLibraryButton: "zen.tidy-downloads.use-library-button"
  };

  window.zenStuffPilePrefs = {
    PREFS,

    /**
     * @param {Object} ctx
     * @param {Object} ctx.state
     * @param {function(string, *=): void} ctx.debugLog
     * @param {function(): Promise<void>} ctx.findDownloadButton
     * @returns {{
     *  getUseLibraryButton: function(): boolean,
     *  setupCompactModeObserver: function(): void,
     *  setupPreferenceListener: function(): void,
     *  updatePointerEvents: function(): void,
     *  updateDownloadsButtonVisibility: function(): void,
     *  initPileSidebarWidthSync: function(): void
     * }}
     */
    createPilePrefsApi(ctx) {
      const { state, debugLog, findDownloadButton } = ctx;

      function getUseLibraryButton() {
        try {
          return Services.prefs.getBoolPref(PREFS.useLibraryButton, false);
        } catch (e) {
          debugLog("Error reading use-library-button preference, using default (false):", e);
          return false;
        }
      }

      function setupPreferenceListener() {
        try {
          const prefObserver = {
            observe(subject, topic, data) {
              if (topic === "nsPref:changed") {
                if (data === PREFS.useLibraryButton) {
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
        state.dynamicSizer.style.pointerEvents = "auto";
        state.pileContainer.style.pointerEvents = "auto";
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
        getUseLibraryButton,
        setupCompactModeObserver,
        setupPreferenceListener,
        updatePointerEvents,
        updateDownloadsButtonVisibility,
        initPileSidebarWidthSync
      };
    }
  };
})();
