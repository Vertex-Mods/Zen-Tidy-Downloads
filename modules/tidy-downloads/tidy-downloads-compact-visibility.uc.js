// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-compact-visibility.uc.js
// Owns compact-mode observer and container visibility decisions.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsCompactVisibility = {
    /**
     * @param {Object} ctx
     * @param {function} ctx.debugLog
     * @param {Array<string>} ctx.orderedPodKeys
     * @param {function(): (HTMLElement|null)} ctx.getDownloadCardsContainer
     * @param {function(): (HTMLElement|null)} ctx.getMasterTooltip
     * @param {function(): (HTMLElement|null)} ctx.getPodsRowContainer
     * @param {Object} [ctx.store] - shared store; used to keep the pods-row visible
     *   while the library pie is mid-download even if no completed pod exists yet
     * @returns {{ setupCompactModeObserver: function, updateDownloadCardsVisibility: function }}
     */
    createCompactVisibility(ctx) {
      const {
        debugLog,
        orderedPodKeys,
        getDownloadCardsContainer,
        getMasterTooltip,
        getPodsRowContainer,
        store
      } = ctx;

      function updateDownloadCardsVisibility() {
        const downloadCardsContainer = getDownloadCardsContainer();
        if (!downloadCardsContainer) return;

        const masterTooltipDOMElement = getMasterTooltip();
        const podsRowContainerElement = getPodsRowContainer();

        const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
        const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";

        const hasProgressing = store?.progressingDownloads instanceof Map && store.progressingDownloads.size > 0;

        debugLog(
          `[CompactModeObserver] Checking visibility: isCompactMode=${isCompactMode}, isSidebarExpanded=${isSidebarExpanded}, hasPods=${orderedPodKeys.length > 0}, hasProgressing=${hasProgressing}`
        );

        if (isCompactMode && !isSidebarExpanded) {
          debugLog("[CompactModeObserver] Compact mode with collapsed sidebar - FORCING hide of download cards");
          downloadCardsContainer.style.display = "none";
          downloadCardsContainer.style.opacity = "0";
          downloadCardsContainer.style.visibility = "hidden";
          downloadCardsContainer.style.pointerEvents = "none";
          if (masterTooltipDOMElement) {
            masterTooltipDOMElement.style.display = "none";
            masterTooltipDOMElement.style.opacity = "0";
            masterTooltipDOMElement.style.visibility = "hidden";
            masterTooltipDOMElement.style.pointerEvents = "none";
          }
          if (podsRowContainerElement) {
            podsRowContainerElement.style.display = "none";
            podsRowContainerElement.style.opacity = "0";
            podsRowContainerElement.style.visibility = "hidden";
            podsRowContainerElement.style.pointerEvents = "none";
          }
          return;
        }

        if (orderedPodKeys.length > 0 || hasProgressing) {
          debugLog("[CompactModeObserver] Showing download cards (pods or in-progress pie present)");
          downloadCardsContainer.style.display = "flex";
          downloadCardsContainer.style.opacity = "1";
          downloadCardsContainer.style.visibility = "visible";
          downloadCardsContainer.style.pointerEvents = "auto";
          if (podsRowContainerElement) {
            podsRowContainerElement.style.display = "flex";
            podsRowContainerElement.style.visibility = "visible";
            podsRowContainerElement.style.opacity = "1";
            podsRowContainerElement.style.pointerEvents = "auto";
          }
          // Compact collapse set master tooltip to display:none + visibility:hidden; restore when pods exist so
          // tooltip-layout can show it again without a redundant focus event.
          if (masterTooltipDOMElement && orderedPodKeys.length > 0) {
            masterTooltipDOMElement.style.display = "flex";
            masterTooltipDOMElement.style.visibility = "visible";
          }
          return;
        }

        debugLog("[CompactModeObserver] No pods and no in-progress downloads, hiding download cards");
        downloadCardsContainer.style.display = "none";
        downloadCardsContainer.style.opacity = "0";
        downloadCardsContainer.style.visibility = "hidden";
        downloadCardsContainer.style.pointerEvents = "none";
      }

      function setupCompactModeObserver() {
        const mainWindow = document.getElementById("main-window");
        const zenMainAppWrapper = document.getElementById("zen-main-app-wrapper");

        if (!mainWindow && !zenMainAppWrapper) {
          debugLog("[CompactModeObserver] Target elements not found, cannot set up observer");
          return;
        }

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type !== "attributes") continue;
            const attributeName = mutation.attributeName;
            if (attributeName === "zen-compact-mode" || attributeName === "zen-sidebar-expanded") {
              debugLog(`[CompactModeObserver] ${attributeName} changed, updating download cards visibility`);
              updateDownloadCardsVisibility();
            }
          }
        });

        if (mainWindow) {
          observer.observe(mainWindow, { attributes: true, attributeFilter: ["zen-compact-mode"] });
          debugLog("[CompactModeObserver] Observing main-window for zen-compact-mode");
        }

        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["zen-compact-mode", "zen-sidebar-expanded"]
        });
        debugLog("[CompactModeObserver] Observing documentElement for zen-compact-mode and zen-sidebar-expanded");

        setTimeout(updateDownloadCardsVisibility, 100);
      }

      return { setupCompactModeObserver, updateDownloadCardsVisibility };
    }
  };
})();
