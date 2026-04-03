// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-card-lifecycle.uc.js
// Dismiss/auto-hide/sticky lifecycle for pod cards.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsCardLifecycle = {
    /**
     * @param {Object} ctx
     * @param {Object} ctx.store
     * @param {function} ctx.debugLog
     * @param {function} ctx.getPref
     * @param {string} ctx.DISABLE_AUTOHIDE_PREF
     * @param {function} ctx.getSafeFilename
     * @param {function} ctx.fireCustomEvent
     * @param {function} ctx.updateUIForFocusedDownload
     * @param {function} ctx.cancelAIProcessForDownload
     * @param {function} ctx.getDownloadCardsContainer
     * @param {function} ctx.getMasterTooltip
     * @param {function} ctx.getPodsRowContainer
     * @returns {{ capturePodDataForDismissal: function, removeCard: function, scheduleCardRemoval: function, performAutohideSequence: function, makePodSticky: function, clearStickyPod: function, clearAllStickyPods: function, clearStickyPodsOnly: function }}
     */
    createCardLifecycle(ctx) {
      const {
        store,
        debugLog,
        getPref,
        DISABLE_AUTOHIDE_PREF,
        getSafeFilename,
        fireCustomEvent,
        updateUIForFocusedDownload,
        cancelAIProcessForDownload,
        getDownloadCardsContainer,
        getMasterTooltip,
        getPodsRowContainer
      } = ctx;

      const {
        activeDownloadCards,
        cardUpdateThrottle,
        focusedKeyRef,
        orderedPodKeys,
        dismissedDownloads,
        stickyPods,
        dismissedPodsData,
        dismissEventListeners
      } = store;

      function capturePodDataForDismissal(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || !cardData.download) {
          debugLog(`[Dismiss] No card data found for capturing: ${downloadKey}`);
          return null;
        }

        const download = cardData.download;
        const podElement = cardData.podElement;
        const dismissedData = {
          key: downloadKey,
          filename: download.aiName || cardData.originalFilename || getSafeFilename(download),
          originalFilename: cardData.originalFilename,
          fileSize: download.currentBytes || download.totalBytes || 0,
          contentType: download.contentType,
          targetPath: download.target?.path,
          downloadId: download.id != null ? download.id : undefined,
          sourceUrl: download.source?.url,
          startTime: download.startTime,
          endTime: download.endTime,
          dismissTime: Date.now(),
          wasRenamed: !!download.aiName,
          previewData: null,
          dominantColor: podElement?.dataset?.dominantColor || null
        };

        if (podElement) {
          const previewContainer = podElement.querySelector(".card-preview-container");
          if (previewContainer) {
            const img = previewContainer.querySelector("img");
            dismissedData.previewData = img?.src ? { type: "image", src: img.src } : { type: "icon" };
          }
        }
        debugLog("[Dismiss] Captured pod data for pile:", dismissedData);
        return dismissedData;
      }

      async function removeCard(downloadKey, force = false) {
        try {
          const cardData = activeDownloadCards.get(downloadKey);
          if (!cardData) return false;
          const podElement = cardData.podElement;
          if (!podElement) return false;

          if (
            !force &&
            cardData.lastInteractionTime &&
            Date.now() - cardData.lastInteractionTime <
              getPref("extensions.downloads.interaction_grace_period_ms", 5000)
          ) {
            debugLog(`removeCard: Skipping removal due to recent interaction: ${downloadKey}`, null, "autohide");
            return false;
          }

          const dismissedData = capturePodDataForDismissal(downloadKey);
          if (dismissedData) {
            dismissedPodsData.set(downloadKey, dismissedData);
            dismissEventListeners.forEach((callback) => {
              try {
                callback(dismissedData);
              } catch (_error) {}
            });
            fireCustomEvent("pod-dismissed", { podKey: downloadKey, podData: dismissedData, wasManual: force });
          }

          cardData.isBeingRemoved = true;
          await cancelAIProcessForDownload(downloadKey);
          if (cardData.autohideTimeoutId) {
            clearTimeout(cardData.autohideTimeoutId);
            cardData.autohideTimeoutId = null;
          }

          podElement.style.transition = "opacity 0.3s ease-out, transform 0.3s ease-in-out";
          podElement.style.opacity = "0";
          podElement.style.transform = "translateX(-60px) scale(0.8)";

          setTimeout(() => {
            const current = activeDownloadCards.get(downloadKey);
            const download = current?.download;
            if (podElement.parentNode) podElement.parentNode.removeChild(podElement);
            activeDownloadCards.delete(downloadKey);
            cardUpdateThrottle.delete(downloadKey);

            const removedPodIndex = orderedPodKeys.indexOf(downloadKey);
            if (removedPodIndex > -1) orderedPodKeys.splice(removedPodIndex, 1);

            if (
              force ||
              !download ||
              !download.succeeded ||
              (download.succeeded && Date.now() - (download.endTime || download.startTime || 0) > 60000)
            ) {
              dismissedDownloads.add(downloadKey);
            }

            if (focusedKeyRef.current === downloadKey) {
              focusedKeyRef.current = null;
              if (orderedPodKeys.length > 0) {
                let newFocusKey = null;
                if (removedPodIndex < orderedPodKeys.length) newFocusKey = orderedPodKeys[removedPodIndex];
                else if (removedPodIndex > 0 && orderedPodKeys.length > 0) {
                  newFocusKey = orderedPodKeys[removedPodIndex - 1];
                } else if (orderedPodKeys.length > 0) {
                  newFocusKey = orderedPodKeys[orderedPodKeys.length - 1];
                }
                focusedKeyRef.current = newFocusKey;
              }
            }

            updateUIForFocusedDownload(focusedKeyRef.current, false);

            const downloadCardsContainer = getDownloadCardsContainer();
            if (orderedPodKeys.length === 0 && downloadCardsContainer) {
              downloadCardsContainer.style.display = "none";
              downloadCardsContainer.style.opacity = "0";
              downloadCardsContainer.style.visibility = "hidden";
            }
          }, 300);

          return true;
        } catch (error) {
          console.error("Error removing card:", error);
          return false;
        }
      }

      function scheduleCardRemoval(downloadKey) {
        try {
          if (getPref(DISABLE_AUTOHIDE_PREF, false)) return;
          const cardData = activeDownloadCards.get(downloadKey);
          if (!cardData) return;
          if (cardData.autohideTimeoutId) clearTimeout(cardData.autohideTimeoutId);
          cardData.autohideTimeoutId = setTimeout(
            () => performAutohideSequence(downloadKey),
            getPref("extensions.downloads.autohide_delay_ms", 10000)
          );
        } catch (error) {
          console.error("Error scheduling card removal:", error);
        }
      }

      async function performAutohideSequence(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData) return;
        try {
          await makePodSticky(downloadKey);
        } catch (_error) {
          await removeCard(downloadKey, false);
        }
      }

      async function makePodSticky(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || cardData.isSticky || cardData.isBeingRemoved) return;

        if (cardData.autohideTimeoutId) {
          clearTimeout(cardData.autohideTimeoutId);
          cardData.autohideTimeoutId = null;
        }

        const dismissedData = capturePodDataForDismissal(downloadKey);
        if (dismissedData) {
          dismissedPodsData.set(downloadKey, dismissedData);
          dismissEventListeners.forEach((cb) => {
            try {
              cb(dismissedData);
            } catch (_error) {}
          });
          fireCustomEvent("pod-dismissed", { podKey: downloadKey, podData: dismissedData, wasManual: false });
        }

        stickyPods.add(downloadKey);
        cardData.isSticky = true;
        dismissedDownloads.add(downloadKey);
        if (cardData.podElement) {
          const podElement = cardData.podElement;
          podElement.classList.add("zen-tidy-sticky-pod");
          podElement.style.pointerEvents = "auto";
          podElement.style.cursor = "pointer";

          podElement.addEventListener("mouseenter", () => {
            document.dispatchEvent(new CustomEvent("request-pile-expand", { bubbles: true }));
          });
        }

        const podsRowContainerElement = getPodsRowContainer();
        if (podsRowContainerElement) {
          podsRowContainerElement.style.pointerEvents = "none";
        }

        const idx = orderedPodKeys.indexOf(downloadKey);
        if (idx > -1) orderedPodKeys.splice(idx, 1);

        const masterTooltipDOMElement = getMasterTooltip();
        if (focusedKeyRef.current === downloadKey && masterTooltipDOMElement) {
          masterTooltipDOMElement.style.opacity = "0";
          masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
          masterTooltipDOMElement.style.pointerEvents = "none";
          setTimeout(() => {
            if (masterTooltipDOMElement.style.opacity === "0") {
              masterTooltipDOMElement.style.display = "none";
            }
          }, 300);
          focusedKeyRef.current = orderedPodKeys.length > 0 ? orderedPodKeys[orderedPodKeys.length - 1] : null;
        }

        await cancelAIProcessForDownload(downloadKey);
      }

      function clearStickyPod(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || !cardData.isSticky) return;
        const podElement = cardData.podElement;
        stickyPods.delete(downloadKey);
        if (podElement && podElement.parentNode) podElement.parentNode.removeChild(podElement);
        activeDownloadCards.delete(downloadKey);
        cardUpdateThrottle.delete(downloadKey);
      }

      function clearAllStickyPods() {
        const keys = Array.from(stickyPods);
        if (keys.length === 0) return;
        const podsRowContainerElement = getPodsRowContainer();
        if (podsRowContainerElement) {
          podsRowContainerElement.style.visibility = "hidden";
          podsRowContainerElement.style.display = "none";
          podsRowContainerElement.style.pointerEvents = "";
        }
        const downloadCardsContainer = getDownloadCardsContainer();
        if (downloadCardsContainer) {
          downloadCardsContainer.style.display = "none";
          downloadCardsContainer.style.opacity = "0";
          downloadCardsContainer.style.visibility = "hidden";
        }
        keys.forEach(clearStickyPod);
      }

      function clearStickyPodsOnly() {
        const keys = Array.from(stickyPods);
        if (keys.length === 0) return;
        keys.forEach(clearStickyPod);
        const podsRowContainerElement = getPodsRowContainer();
        if (podsRowContainerElement) podsRowContainerElement.style.pointerEvents = "";
      }

      return {
        capturePodDataForDismissal,
        removeCard,
        scheduleCardRemoval,
        performAutohideSequence,
        makePodSticky,
        clearStickyPod,
        clearAllStickyPods,
        clearStickyPodsOnly
      };
    }
  };
})();
