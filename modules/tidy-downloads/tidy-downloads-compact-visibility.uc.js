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

      /**
       * Master tooltip is the only child left in #userchrome-download-cards-container
       * after pods moved to the anchor; show that strip only when the tooltip is actually used.
       * @param {HTMLElement|null} masterEl
       */
      function isMasterTooltipShown(masterEl) {
        if (!masterEl) return false;
        if (masterEl.style.display !== "flex") return false;
        if (masterEl.style.visibility === "hidden") return false;
        return true;
      }

      function updateDownloadCardsVisibility() {
        const downloadCardsContainer = getDownloadCardsContainer();
        if (!downloadCardsContainer) return;

        const masterTooltipDOMElement = getMasterTooltip();
        const podsRowContainerElement = getPodsRowContainer();
        const useBadgeStack = !!(
          podsRowContainerElement && podsRowContainerElement.classList.contains("zen-tidy-pods-badge-stack")
        );

        const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
        const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";

        const hasProgressing = store?.progressingDownloads instanceof Map && store.progressingDownloads.size > 0;

        debugLog(
          `[CompactModeObserver] Checking visibility: isCompactMode=${isCompactMode}, isSidebarExpanded=${isSidebarExpanded}, hasPods=${orderedPodKeys.length > 0}, hasProgressing=${hasProgressing}, badgeStack=${useBadgeStack}, masterTooltipShown=${isMasterTooltipShown(masterTooltipDOMElement)}`
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
          debugLog("[CompactModeObserver] Pods row / pie active — syncing strip visibility");
          if (podsRowContainerElement) {
            podsRowContainerElement.style.display = "flex";
            podsRowContainerElement.style.visibility = "visible";
            podsRowContainerElement.style.opacity = "1";
            /* Row is a badge overlay on the anchor button; leave hit-testing to .download-pod (pointer-events: auto in CSS). */
            podsRowContainerElement.style.pointerEvents = "none";
          }
          const legacyStrip =
            !useBadgeStack && (orderedPodKeys.length > 0 || hasProgressing);
          const showCardsContainer =
            legacyStrip || isMasterTooltipShown(masterTooltipDOMElement);
          if (showCardsContainer) {
            downloadCardsContainer.style.display = "flex";
            downloadCardsContainer.style.opacity = "1";
            downloadCardsContainer.style.visibility = "visible";
            downloadCardsContainer.style.pointerEvents = "auto";
          } else {
            downloadCardsContainer.style.display = "none";
            downloadCardsContainer.style.opacity = "0";
            downloadCardsContainer.style.visibility = "hidden";
            downloadCardsContainer.style.pointerEvents = "none";
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
