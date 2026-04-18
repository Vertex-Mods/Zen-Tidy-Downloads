// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-card-lifecycle.uc.js
// Authoritative pod lifecycle: owns the phase model (progress → live-pod →
// sticky → dismissed), fans every Firefox download event into the right
// renderer via apply(), and manages autohide / sticky / dismiss transitions.
// (Rename to tidy-downloads-pod-lifecycle.uc.js deferred to Step 6.)
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
     * @param {function} [ctx.getDownloadKey] - canonical key resolver (required for apply())
     * @param {function} [ctx.getLibraryPieController] - () => pie controller; apply() feeds it every event
     * @param {function} [ctx.getThrottledCreateOrUpdateCard] - () => pods renderer entry; apply() calls it on terminal state
     * @param {function} [ctx.getHandoffAnimator] - () => pod-handoff animator; optional visual bridge on progress → live-pod
     * @returns {{ capturePodDataForDismissal: function, removeCard: function, scheduleCardRemoval: function, performAutohideSequence: function, makePodSticky: function, clearStickyPod: function, clearAllStickyPods: function, clearStickyPodsOnly: function, apply: function, getPhase: function, reconcileDismissedForIncoming: function, destroy: function }}
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
        getPodsRowContainer,
        getDownloadKey,
        getLibraryPieController,
        getThrottledCreateOrUpdateCard,
        getHandoffAnimator
      } = ctx;

      const {
        activeDownloadCards,
        cardUpdateThrottle,
        focusedKeyRef,
        orderedPodKeys,
        dismissedDownloads,
        stickyPods,
        dismissedPodsData,
        dismissEventListeners,
        progressingDownloads,
        actualDownloadRemovedEventListeners
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
          cardData.phase = "dismissed";
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
        cardData.phase = "sticky";
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

      /**
       * Decide whether an incoming download event should be admitted as a new
       * pod or skipped because its key was previously dismissed. Single
       * source of truth for the dismissed/newer logic — both the pods
       * renderer and any future caller should route through here instead of
       * poking at store.dismissedDownloads directly.
       *
       *   - "allow" : not dismissed, OR dismissed but superseded by a newer
       *              re-download (dismissed set is evicted as a side effect
       *              so subsequent events see a clean slate)
       *   - "skip"  : dismissed and the incoming event is not newer; caller
       *              should abort rendering
       *
       * @param {string} key
       * @param {{ startTime?: string|Date|number }} download
       * @returns {{ action: "allow"|"skip", reason?: string, dismissedTime?: number, currentTime?: number }}
       */
      function reconcileDismissedForIncoming(key, download) {
        if (!key || !dismissedDownloads.has(key) || activeDownloadCards.has(key)) {
          return { action: "allow" };
        }
        const dismissedData = dismissedPodsData.get(key);
        const dismissedTime = dismissedData?.startTime
          ? new Date(dismissedData.startTime).getTime()
          : 0;
        const currentTime = download?.startTime
          ? new Date(download.startTime).getTime()
          : 0;
        const isNewerDownload =
          !dismissedData ||
          !dismissedData.startTime ||
          !download?.startTime ||
          currentTime > dismissedTime;

        if (isNewerDownload) {
          dismissedDownloads.delete(key);
          return {
            action: "allow",
            reason: "newer-than-dismissed",
            dismissedTime,
            currentTime
          };
        }
        return {
          action: "skip",
          reason: "older-than-dismissed",
          dismissedTime,
          currentTime
        };
      }

      /**
       * Report the current lifecycle phase of a download key.
       *   - "progress"  : in-flight, rendered by the library-pie
       *   - "live-pod"  : completed, pod card visible in the pods row
       *   - "sticky"    : autohide elapsed; pod waiting to be absorbed by the pile
       *   - "dismissed" : fade-out in flight or already removed
       *   - null        : unknown key
       * @param {string} key
       * @returns {"progress"|"live-pod"|"sticky"|"dismissed"|null}
       */
      function getPhase(key) {
        if (!key) return null;
        const cardData = activeDownloadCards.get(key);
        if (cardData) {
          return cardData.phase || "live-pod";
        }
        if (progressingDownloads && progressingDownloads.has(key)) {
          return "progress";
        }
        if (dismissedDownloads.has(key)) {
          return "dismissed";
        }
        return null;
      }

      /**
       * Authoritative dispatcher for a single raw download event. Every
       * onDownloadAdded / onDownloadChanged / onDownloadRemoved from Firefox's
       * Downloads view should funnel through here.
       *
       *   - Always feeds the pie renderer so progress state stays current
       *     (the pie also handles rekey and removal-on-terminal internally).
       *   - On Firefox list removal: cancel AI, remove the card if present,
       *     notify external listeners, fire the actual-download-removed event.
       *   - On terminal succeeded/error (non-removal): hand off to the pods
       *     renderer so the record transitions from "progress" to "live-pod".
       *   - In-progress events: nothing to do on the pods side; the pie
       *     already saw the event.
       *
       * Startup batch of already-completed downloads should bypass this path
       * and call getThrottledCreateOrUpdateCard() directly with the init flag.
       *
       * @param {unknown} dl
       * @param {boolean} [removed]
       */
      async function apply(dl, removed = false) {
        if (!dl) return;

        if (typeof getDownloadKey !== "function") {
          try {
            getLibraryPieController?.()?.syncDownload?.(dl, removed);
          } catch (e) {
            debugLog("[Lifecycle] pie.syncDownload error", e);
          }
          debugLog("[Lifecycle] apply() called without getDownloadKey; skipping pods dispatch");
          return;
        }

        const key = getDownloadKey(dl);
        const pie = typeof getLibraryPieController === "function" ? getLibraryPieController() : null;

        // Detect the about-to-happen progress → live-pod transition so we can
        // snapshot the pie position BEFORE syncDownload auto-hides it on
        // terminal state. Conditions:
        //   - non-removal, terminal (succeeded or error)
        //   - no existing card yet (we're creating a brand-new live-pod, not re-rendering)
        //   - handoff animator available and enabled
        const isTerminalTransition = !removed && (dl.succeeded === true || !!dl.error);
        const wasAlreadyLive = activeDownloadCards.has(key);
        const animator = typeof getHandoffAnimator === "function" ? getHandoffAnimator() : null;
        const shouldCaptureSnapshot =
          isTerminalTransition && !wasAlreadyLive && animator && animator.isEnabled?.();

        let handoffSnapshot = null;
        if (shouldCaptureSnapshot) {
          try {
            handoffSnapshot = pie?.captureHandoffSnapshot?.() || null;
          } catch (e) {
            debugLog("[Lifecycle] pie.captureHandoffSnapshot error", e);
          }
        }

        try {
          pie?.syncDownload?.(dl, removed);
        } catch (e) {
          debugLog("[Lifecycle] pie.syncDownload error", e);
        }

        if (removed) {
          try {
            await cancelAIProcessForDownload(key);
          } catch (e) {
            debugLog("[Lifecycle] cancelAIProcessForDownload error", e);
          }

          const cardData = activeDownloadCards.get(key);
          if (cardData?.isManuallyCleaning) return;

          await removeCard(key, false);

          if (actualDownloadRemovedEventListeners) {
            actualDownloadRemovedEventListeners.forEach((callback) => {
              try {
                callback(key);
              } catch (error) {
                debugLog("[API Event] Error in actualDownloadRemoved callback:", error);
              }
            });
          }
          fireCustomEvent("actual-download-removed", { podKey: key });
          return;
        }

        // Non-terminal events stay in the "progress" phase — pie already handled it.
        if (!isTerminalTransition) return;

        // Terminal succeeded/error → transition progress → live-pod via pods renderer.
        const throttledUpdate = typeof getThrottledCreateOrUpdateCard === "function"
          ? getThrottledCreateOrUpdateCard()
          : null;
        if (typeof throttledUpdate === "function") {
          throttledUpdate(dl);
        }

        // Fire the handoff animation if we captured a snapshot and the new
        // pod element is actually in the DOM and has real dimensions.
        if (handoffSnapshot && animator) {
          const newCardData = activeDownloadCards.get(key);
          const podEl = newCardData?.podElement;
          if (podEl && podEl.parentNode) {
            try {
              animator.animate({
                fromRect: handoffSnapshot.rect,
                iconClone: handoffSnapshot.iconClone,
                toElement: podEl
              });
            } catch (e) {
              debugLog("[Lifecycle] handoff animator threw", e);
            }
          }
        }
      }

      /**
       * Tear down any active timers the lifecycle owns. Currently limited to
       * per-card autohide timeouts — DOM listeners attached to pod elements
       * are cleaned up when the pods themselves are removed. Idempotent.
       */
      function destroy() {
        activeDownloadCards.forEach((cardData) => {
          if (cardData?.autohideTimeoutId) {
            clearTimeout(cardData.autohideTimeoutId);
            cardData.autohideTimeoutId = null;
          }
        });
      }

      return {
        capturePodDataForDismissal,
        removeCard,
        scheduleCardRemoval,
        performAutohideSequence,
        makePodSticky,
        clearStickyPod,
        clearAllStickyPods,
        clearStickyPodsOnly,
        apply,
        getPhase,
        reconcileDismissedForIncoming,
        destroy
      };
    }
  };
})();
