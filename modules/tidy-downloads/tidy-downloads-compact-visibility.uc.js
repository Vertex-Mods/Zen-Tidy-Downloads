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
     * @param {function(): (HTMLElement|null)} [ctx.getPodsShell] - #userchrome-download-pods-shell (pie + pods row)
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
        getPodsShell,
        store
      } = ctx;

      /**
       * Per-card rename-success chrome (sticky + AI rename), keyed by map key for sticky membership.
       * @param {{ podElement?: HTMLElement|null, download?: { succeeded?: boolean, aiName?: string|null }, phase?: string, isSticky?: boolean }} [cardData]
       * @param {string|null|undefined} mapKey
       * @returns {boolean}
       */
      function cardQualifiesStickyRenameChrome(cardData, mapKey) {
        if (!cardData?.podElement || !cardData.download) return false;
        const download = cardData.download;
        const isProgress =
          cardData.phase === "progress" || cardData.podElement.dataset?.state === "progress";
        if (isProgress) return false;
        const inStickySet =
          !!(mapKey && store?.stickyPods instanceof Set && store.stickyPods.has(mapKey));
        if (cardData.isSticky !== true && !inStickySet) return false;
        return !!(download.succeeded && download.aiName);
      }

      /**
       * Like tooltip-layout rename-success eligibility, plus `!store.masterRenameTooltipSuppressed`.
       * Uses focused key **or** any sticky so an empty jukebox with multiple piled stickies still
       * shows `#userchrome-download-cards-container` when focus is transiently wrong (`patch 2`).
       * @returns {boolean}
       */
      function shouldShowRenameSuccessChromeFromStore() {
        if (store?.masterRenameTooltipSuppressed) return false;
        const cards = store?.activeDownloadCards;
        if (!cards) return false;
        const fk = store?.focusedKeyRef?.current;
        if (fk && cardQualifiesStickyRenameChrome(cards.get(fk), fk)) return true;
        const sticky = store?.stickyPods;
        if (!(sticky instanceof Set) || sticky.size === 0) return false;
        for (const sk of sticky) {
          if (cardQualifiesStickyRenameChrome(cards.get(sk), sk)) return true;
        }
        return false;
      }

      function updateDownloadCardsVisibility() {
        const downloadCardsContainer = getDownloadCardsContainer();
        const masterTooltipDOMElement = getMasterTooltip();
        const podsRowContainerElement = getPodsRowContainer();
        const podsShellElement =
          typeof getPodsShell === "function" ? getPodsShell() : document.getElementById("userchrome-download-pods-shell");

        const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
        const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";

        const hasProgressing = store?.progressingDownloads instanceof Map && store.progressingDownloads.size > 0;
        const hasLivePodsInJukebox = orderedPodKeys.length > 0;
        const hasStickyPods = store?.stickyPods instanceof Set && store.stickyPods.size > 0;
        const needsPodsChrome = hasLivePodsInJukebox || hasProgressing || hasStickyPods;

        debugLog(
          `[CompactModeObserver] Checking visibility: isCompactMode=${isCompactMode}, isSidebarExpanded=${isSidebarExpanded}, hasPods=${hasLivePodsInJukebox}, hasProgressing=${hasProgressing}, hasSticky=${hasStickyPods}`
        );

        if (isCompactMode && !isSidebarExpanded) {
          debugLog("[CompactModeObserver] Compact mode with collapsed sidebar - FORCING hide of download UI");
          if (downloadCardsContainer) {
            downloadCardsContainer.style.display = "none";
            downloadCardsContainer.style.opacity = "0";
            downloadCardsContainer.style.visibility = "hidden";
            downloadCardsContainer.style.pointerEvents = "none";
          }
          if (masterTooltipDOMElement) {
            masterTooltipDOMElement.style.display = "none";
            masterTooltipDOMElement.style.opacity = "0";
            masterTooltipDOMElement.style.visibility = "hidden";
            masterTooltipDOMElement.style.pointerEvents = "none";
          }
          if (podsShellElement) {
            podsShellElement.style.display = "none";
            podsShellElement.style.opacity = "0";
            podsShellElement.style.visibility = "hidden";
            podsShellElement.style.pointerEvents = "none";
          }
          if (podsRowContainerElement) {
            podsRowContainerElement.style.display = "none";
            podsRowContainerElement.style.opacity = "0";
            podsRowContainerElement.style.visibility = "hidden";
            podsRowContainerElement.style.pointerEvents = "none";
          }
          return;
        }

        if (needsPodsChrome) {
          debugLog("[CompactModeObserver] Showing pods shell (live pods, pie, and/or sticky); cards only when jukebox pods exist");
          if (podsShellElement) {
            podsShellElement.style.display = "block";
            podsShellElement.style.opacity = "1";
            podsShellElement.style.visibility = "visible";
            podsShellElement.style.pointerEvents = "none";
          }
          if (podsRowContainerElement) {
            podsRowContainerElement.style.display = "flex";
            podsRowContainerElement.style.visibility = "visible";
            podsRowContainerElement.style.opacity = "1";
            /* Match chrome.css: row is non-interactive; pods set pointer-events: auto. */
            podsRowContainerElement.style.pointerEvents = "none";
          }

          /* Cards container + tooltip: hidden when only sticky/pie unless AI rename-success
             UI is active (orderedPodKeys empty but master tooltip must stay visible). */
          if (!hasLivePodsInJukebox && downloadCardsContainer) {
            const keepRenameChrome = shouldShowRenameSuccessChromeFromStore();
            if (keepRenameChrome) {
              downloadCardsContainer.style.display = "flex";
              downloadCardsContainer.style.opacity = "1";
              downloadCardsContainer.style.visibility = "visible";
              downloadCardsContainer.style.pointerEvents = "none";
              if (masterTooltipDOMElement) {
                masterTooltipDOMElement.style.display = "flex";
                masterTooltipDOMElement.style.opacity = "1";
                masterTooltipDOMElement.style.visibility = "visible";
                masterTooltipDOMElement.style.transform = "scaleY(1) translateY(0)";
                masterTooltipDOMElement.style.pointerEvents = "auto";
              }
              if (store) store.pileHoverBlockedByRenameTooltip = true;
            } else if (store?.masterTooltipFadeoutActive) {
              /* Fade-out in progress — keep subtree painted so `.details-tooltip` transitions run. */
              downloadCardsContainer.style.display = "flex";
              downloadCardsContainer.style.opacity = "1";
              downloadCardsContainer.style.visibility = "visible";
              downloadCardsContainer.style.pointerEvents = "none";
              if (masterTooltipDOMElement) {
                masterTooltipDOMElement.style.display = "flex";
                masterTooltipDOMElement.style.visibility = "visible";
                masterTooltipDOMElement.style.pointerEvents = "none";
              }
            } else {
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
            }
          }
          return;
        }

        debugLog("[CompactModeObserver] No pods and no in-progress downloads, hiding download UI");
        if (downloadCardsContainer) {
          downloadCardsContainer.style.display = "none";
          downloadCardsContainer.style.opacity = "0";
          downloadCardsContainer.style.visibility = "hidden";
          downloadCardsContainer.style.pointerEvents = "none";
        }
        if (podsShellElement) {
          podsShellElement.style.display = "none";
          podsShellElement.style.opacity = "0";
          podsShellElement.style.visibility = "hidden";
          podsShellElement.style.pointerEvents = "none";
        }
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
