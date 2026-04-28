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
     * @param {function} [ctx.updateDownloadCardsVisibility] - refresh pods shell vs cards container visibility
     * @param {function} [ctx.managePodVisibilityAndAnimations] - run after sticky transition so layout/row height refresh without jukebox keys
     * @param {function} [ctx.getDownloadKey] - canonical key resolver (required for apply())
     * @param {function} [ctx.getLibraryPieController] - () => pie controller; apply() feeds it every event
     * @param {function} [ctx.getThrottledCreateOrUpdateCard] - () => pods renderer entry; apply() calls it on terminal state
     * @param {function} [ctx.getHandoffAnimator] - () => pod-handoff animator; optional visual bridge on progress → live-pod
     * @param {function} [ctx.formatBytes] - human-readable byte formatter (progress sublabel)
     * @returns {{ capturePodDataForDismissal: function, removeCard: function, scheduleCardRemoval: function, scheduleImmediateSticky: function, performAutohideSequence: function, makePodSticky: function, clearStickyPod: function, clearAllStickyPods: function, clearStickyPodsOnly: function, apply: function, getPhase: function, reconcileDismissedForIncoming: function, destroy: function }}
     */
    createCardLifecycle(ctx) {
      const {
        store,
        debugLog,
        getPref,
        DISABLE_AUTOHIDE_PREF,
        getSafeFilename,
        formatBytes: formatBytesFn = (n) => `${n} B`,
        fireCustomEvent,
        updateUIForFocusedDownload,
        cancelAIProcessForDownload,
        getDownloadCardsContainer,
        getMasterTooltip,
        getPodsRowContainer,
        updateDownloadCardsVisibility,
        managePodVisibilityAndAnimations,
        getDownloadKey,
        getLibraryPieController,
        getThrottledCreateOrUpdateCard,
        getHandoffAnimator,
        getAiRenamingPossible
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
        actualDownloadRemovedEventListeners,
        renamedFiles
      } = store;

      function formatProgressSubLabel(dl) {
        const cur = dl.currentBytes || 0;
        const total = dl.totalBytes;
        if (typeof total === "number" && total > 0) {
          const pct = Math.round((cur / total) * 100);
          return `${pct}% · ${formatBytesFn(cur)} / ${formatBytesFn(total)}`;
        }
        const speed = dl.speed;
        if (typeof speed === "number" && speed > 0) {
          return `${formatBytesFn(cur)} · ${formatBytesFn(speed)}/s`;
        }
        if (cur > 0) return formatBytesFn(cur);
        return "Starting…";
      }

      function buildProgressPodData(dl) {
        const downloadKey = getDownloadKey(dl);
        return {
          key: downloadKey,
          filename: getSafeFilename(dl),
          originalFilename: getSafeFilename(dl),
          inProgress: true,
          fileSize: typeof dl.totalBytes === "number" ? dl.totalBytes : 0,
          progressSubLabel: formatProgressSubLabel(dl),
          contentType: dl.contentType,
          targetPath: dl.target?.path,
          downloadId: dl.id != null ? dl.id : undefined,
          sourceUrl: dl.source?.url,
          startTime: dl.startTime
        };
      }

      function notifyProgressPileListeners(payload) {
        const listeners = store.progressPileListeners;
        if (!listeners) return;
        listeners.forEach((callback) => {
          try {
            callback(payload);
          } catch (err) {
            debugLog("[ProgressPile] listener error", err);
          }
        });
      }

      /**
       * Snapshot the live completed pod into `dismissedPodsData` and notify pile
       * listeners once, so zen-stuff's pile is non-empty before autohide → sticky.
       * Idempotent per card (`pileSnapshotSeeded`). Does not add `dismissedDownloads`
       * (that remains the sticky/removeCard concern for reconcile).
       * @param {string} downloadKey
       */
      function seedPileEntryForLivePod(downloadKey) {
        try {
          const cardData = activeDownloadCards.get(downloadKey);
          if (!cardData || !cardData.download || cardData.isBeingRemoved) return;
          if (stickyPods.has(downloadKey)) return;
          if (cardData.pileSnapshotSeeded) return;
          if (dismissedPodsData.has(downloadKey)) {
            cardData.pileSnapshotSeeded = true;
            return;
          }
          const dismissedData = capturePodDataForDismissal(downloadKey);
          if (!dismissedData) return;
          dismissedPodsData.set(downloadKey, dismissedData);
          cardData.pileSnapshotSeeded = true;
          dismissEventListeners.forEach((callback) => {
            try {
              callback(dismissedData);
            } catch (_error) {}
          });
          fireCustomEvent("pod-dismissed", {
            podKey: downloadKey,
            podData: dismissedData,
            wasManual: false,
            phase: "live-preview"
          });
          debugLog("[Dismiss] Seeded pile entry for live pod:", downloadKey);
        } catch (err) {
          debugLog("[seedPileEntryForLivePod] error", err);
        }
      }

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

            if (typeof updateDownloadCardsVisibility === "function") {
              updateDownloadCardsVisibility();
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
          const cardData = activeDownloadCards.get(downloadKey);
          if (!cardData) return;
          seedPileEntryForLivePod(downloadKey);
          if (getPref(DISABLE_AUTOHIDE_PREF, false)) return;
          if (cardData.autohideTimeoutId) clearTimeout(cardData.autohideTimeoutId);
          cardData.autohideTimeoutId = setTimeout(
            () => performAutohideSequence(downloadKey),
            getPref("extensions.downloads.autohide_delay_ms", 10000)
          );
        } catch (error) {
          console.error("Error scheduling card removal:", error);
        }
      }

      /**
       * When a download reaches a terminal jukebox state (success/error), move it
       * to sticky immediately instead of waiting for autohide_delay_ms.
       * @param {string} downloadKey
       */
      function scheduleImmediateSticky(downloadKey) {
        try {
          const cardData = activeDownloadCards.get(downloadKey);
          if (!cardData) return;
          seedPileEntryForLivePod(downloadKey);
          if (cardData.autohideTimeoutId) {
            clearTimeout(cardData.autohideTimeoutId);
            cardData.autohideTimeoutId = null;
          }
          Promise.resolve()
            .then(() => makePodSticky(downloadKey))
            .catch((e) => debugLog("[Lifecycle] scheduleImmediateSticky makePodSticky error", e));
        } catch (error) {
          console.error("Error in scheduleImmediateSticky:", error);
        }
      }

      /** Match chrome.css `.details-tooltip`: transition delay 0.15s + duration 0.3s */
      const MASTER_TOOLTIP_FADEOUT_MS = 450;

      function collapseDownloadCardsContainerWithTooltipFade(downloadCardsContainer) {
        store.masterTooltipFadeoutActive = false;
        if (!downloadCardsContainer) return;
        downloadCardsContainer.style.display = "none";
        downloadCardsContainer.style.opacity = "0";
        downloadCardsContainer.style.visibility = "hidden";
        downloadCardsContainer.style.pointerEvents = "none";
      }

      /**
       * Keep cards container mounted and painted while `.master-tooltip` CSS opacity/transform run.
       * @param {HTMLElement|null|undefined} downloadCardsContainer
       */
      function beginMasterTooltipFadeout(downloadCardsContainer) {
        store.masterTooltipFadeoutActive = true;
        if (downloadCardsContainer) {
          downloadCardsContainer.style.pointerEvents = "none";
        }
      }

      /**
       * After autohide_delay_ms, a pod may already be sticky (e.g. AI rename showed
       * rename-success chrome). Collapse master tooltip + cards without re-running makePodSticky.
       * @param {string} downloadKey
       */
      function dismissStickyPostRenameChrome(downloadKey) {
        store.masterRenameTooltipSuppressed = true;
        store.pileHoverBlockedByRenameTooltip = false;

        if (focusedKeyRef.current === downloadKey) {
          focusedKeyRef.current =
            orderedPodKeys.length > 0 ? orderedPodKeys[orderedPodKeys.length - 1] : null;
        }

        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();

        beginMasterTooltipFadeout(downloadCardsContainer);
        if (masterTooltipDOMElement) {
          masterTooltipDOMElement.style.opacity = "0";
          masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
          masterTooltipDOMElement.style.pointerEvents = "none";
        }

        setTimeout(() => {
          if (masterTooltipDOMElement && masterTooltipDOMElement.style.opacity === "0") {
            masterTooltipDOMElement.style.display = "none";
          }
          collapseDownloadCardsContainerWithTooltipFade(downloadCardsContainer);
          if (typeof managePodVisibilityAndAnimations === "function") {
            try {
              managePodVisibilityAndAnimations();
            } catch (err) {
              debugLog("[Lifecycle] managePod after dismissStickyPostRenameChrome", err);
            }
          }
          if (typeof updateDownloadCardsVisibility === "function") {
            updateDownloadCardsVisibility();
          }
        }, MASTER_TOOLTIP_FADEOUT_MS);
        if (typeof updateDownloadCardsVisibility === "function") {
          updateDownloadCardsVisibility();
        }
      }

      async function performAutohideSequence(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData) return;
        if (cardData.autohideTimeoutId) {
          clearTimeout(cardData.autohideTimeoutId);
          cardData.autohideTimeoutId = null;
        }
        try {
          if (cardData.isSticky) {
            dismissStickyPostRenameChrome(downloadKey);
            return;
          }
          await makePodSticky(downloadKey);
        } catch (_error) {
          await removeCard(downloadKey, false);
        }
      }

      function shouldAbsorbInsteadOfStickyPod() {
        try {
          const api = window.__zenDismissedPileIntegration;
          const sup = api?.shouldSuppressStickyPod;
          if (typeof sup === "function") return sup() === true;
          const leg = api?.isHoveringPileArea;
          return typeof leg === "function" && leg() === true;
        } catch (_e) {
          return false;
        }
      }

      /**
       * Download finished while the user hovers the dismissed pile or the
       * library/downloads control: keep the completed row in the pile only (no sticky in the toolbar).
       */
      async function absorbIntoPileWithoutSticky(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || cardData.isSticky || cardData.isBeingRemoved) return;

        store.masterRenameTooltipSuppressed = true;
        store.pileHoverBlockedByRenameTooltip = false;

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

        dismissedDownloads.add(downloadKey);
        cardData.isBeingRemoved = true;
        cardData.phase = "dismissed";

        const wasFocused = focusedKeyRef.current === downloadKey;
        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();
        let layoutAfterTooltipFadeMs = 0;

        await cancelAIProcessForDownload(downloadKey);

        const podElement = cardData.podElement;
        if (podElement?.parentNode) podElement.parentNode.removeChild(podElement);

        activeDownloadCards.delete(downloadKey);
        cardUpdateThrottle.delete(downloadKey);

        const removedPodIndex = orderedPodKeys.indexOf(downloadKey);
        if (removedPodIndex > -1) orderedPodKeys.splice(removedPodIndex, 1);

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

        const podsRowContainerElement = getPodsRowContainer();
        if (podsRowContainerElement && stickyPods.size === 0) {
          podsRowContainerElement.style.pointerEvents = "";
        }

        if (wasFocused && masterTooltipDOMElement) {
          beginMasterTooltipFadeout(downloadCardsContainer);
          masterTooltipDOMElement.style.opacity = "0";
          masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
          masterTooltipDOMElement.style.pointerEvents = "none";
          layoutAfterTooltipFadeMs = MASTER_TOOLTIP_FADEOUT_MS;
          setTimeout(() => {
            if (masterTooltipDOMElement.style.opacity === "0") {
              masterTooltipDOMElement.style.display = "none";
            }
            collapseDownloadCardsContainerWithTooltipFade(downloadCardsContainer);
          }, MASTER_TOOLTIP_FADEOUT_MS);
        }

        if (
          layoutAfterTooltipFadeMs > 0 &&
          typeof updateDownloadCardsVisibility === "function"
        ) {
          updateDownloadCardsVisibility();
        }

        updateUIForFocusedDownload(focusedKeyRef.current, false);

        const runLayout = () => {
          if (typeof managePodVisibilityAndAnimations === "function") {
            try {
              managePodVisibilityAndAnimations();
            } catch (err) {
              debugLog("[Lifecycle] managePod after absorbIntoPileWithoutSticky", err);
            }
          }
          if (typeof updateDownloadCardsVisibility === "function") {
            updateDownloadCardsVisibility();
          }
        };
        if (layoutAfterTooltipFadeMs > 0) {
          setTimeout(runLayout, layoutAfterTooltipFadeMs);
        } else {
          runLayout();
        }
      }

      function shouldPileHoverBlockForPendingAIAfterSticky(cardData) {
        const dl = cardData?.download;
        if (!dl?.succeeded || !dl.target?.path) return false;
        if (!getPref("extensions.downloads.enable_ai_renaming", true)) return false;
        if (typeof getAiRenamingPossible === "function" && !getAiRenamingPossible()) return false;
        if (renamedFiles?.has(dl.target.path)) return false;
        return true;
      }

      async function makePodSticky(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || cardData.isSticky || cardData.isBeingRemoved) return;

        if (shouldAbsorbInsteadOfStickyPod()) {
          await absorbIntoPileWithoutSticky(downloadKey);
          return;
        }

        store.masterRenameTooltipSuppressed = true;
        store.pileHoverBlockedByRenameTooltip = false;

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
          /* mouseenter → request-pile-expand is wired at pod-creation time in
             tidy-downloads-pods.uc.js so the pile is hoverable from the moment
             the pod appears, not only after sticky transition. */
        }

        if (shouldPileHoverBlockForPendingAIAfterSticky(cardData)) {
          store.pileHoverExpandBlockedUntilAIDoneKeys.add(downloadKey);
        }

        const podsRowContainerElement = getPodsRowContainer();
        if (podsRowContainerElement) {
          podsRowContainerElement.style.pointerEvents = "none";
        }

        /* Keep key in orderedPodKeys so sticky pods stay in the jukebox pile with newer downloads. */

        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();
        let layoutAfterTooltipFadeMs = 0;
        if (focusedKeyRef.current === downloadKey && masterTooltipDOMElement) {
          beginMasterTooltipFadeout(downloadCardsContainer);
          masterTooltipDOMElement.style.opacity = "0";
          masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
          masterTooltipDOMElement.style.pointerEvents = "none";
          layoutAfterTooltipFadeMs = MASTER_TOOLTIP_FADEOUT_MS;
          setTimeout(() => {
            if (masterTooltipDOMElement.style.opacity === "0") {
              masterTooltipDOMElement.style.display = "none";
            }
            collapseDownloadCardsContainerWithTooltipFade(downloadCardsContainer);
          }, MASTER_TOOLTIP_FADEOUT_MS);
          focusedKeyRef.current = orderedPodKeys.length > 0 ? orderedPodKeys[orderedPodKeys.length - 1] : null;
        }

        if (
          layoutAfterTooltipFadeMs > 0 &&
          typeof updateDownloadCardsVisibility === "function"
        ) {
          updateDownloadCardsVisibility();
        }

        const runLayout = () => {
          if (typeof managePodVisibilityAndAnimations === "function") {
            try {
              managePodVisibilityAndAnimations();
            } catch (err) {
              debugLog("[Lifecycle] managePodVisibilityAndAnimations after makePodSticky", err);
            }
          }
        };
        if (layoutAfterTooltipFadeMs > 0) {
          setTimeout(runLayout, layoutAfterTooltipFadeMs);
        } else {
          runLayout();
        }
      }

      function clearStickyPod(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || !cardData.isSticky) return;
        const podElement = cardData.podElement;
        stickyPods.delete(downloadKey);
        const oi = orderedPodKeys.indexOf(downloadKey);
        if (oi > -1) orderedPodKeys.splice(oi, 1);
        if (focusedKeyRef.current === downloadKey) {
          focusedKeyRef.current =
            orderedPodKeys.length > 0 ? orderedPodKeys[orderedPodKeys.length - 1] : null;
        }
        if (podElement && podElement.parentNode) podElement.parentNode.removeChild(podElement);
        activeDownloadCards.delete(downloadKey);
        cardUpdateThrottle.delete(downloadKey);
      }

      function clearAllStickyPods() {
        const keys = Array.from(stickyPods);
        if (keys.length === 0) return;
        keys.forEach(clearStickyPod);
        if (typeof updateDownloadCardsVisibility === "function") {
          updateDownloadCardsVisibility();
        }
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
        //   - non-removal, terminal (succeeded, error, or canceled)
        //   - no existing card yet (we're creating a brand-new live-pod, not re-rendering)
        //   - handoff animator available and enabled
        const isTerminalTransition = !removed && (dl.succeeded === true || !!dl.error || !!dl.canceled);
        const isHandoffTerminal = !removed && (dl.succeeded === true || !!dl.error);
        const wasAlreadyLive = activeDownloadCards.has(key);
        const animator = typeof getHandoffAnimator === "function" ? getHandoffAnimator() : null;
        const shouldCaptureSnapshot =
          isHandoffTerminal && !wasAlreadyLive && animator && animator.isEnabled?.();

        let handoffSnapshot = null;
        if (shouldCaptureSnapshot) {
          try {
            handoffSnapshot = pie?.captureHandoffSnapshot?.() || null;
          } catch (e) {
            debugLog("[Lifecycle] pie.captureHandoffSnapshot error", e);
          }
        }

        const prevProgressKey = store.progressPileKeyByDownload?.get(dl);

        try {
          pie?.syncDownload?.(dl, removed);
        } catch (e) {
          debugLog("[Lifecycle] pie.syncDownload error", e);
        }

        const canonicalKey = getDownloadKey(dl);

        if (removed) {
          store.progressPileKeyByDownload?.delete(dl);
          if (prevProgressKey) store.progressPileUpsertThrottle?.delete(prevProgressKey);
          if (canonicalKey) store.progressPileUpsertThrottle?.delete(canonicalKey);
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

        store.progressPileKeyByDownload?.set(dl, canonicalKey);

        let rekeyedThisApply = false;
        if (prevProgressKey && prevProgressKey !== canonicalKey) {
          notifyProgressPileListeners({
            kind: "rekey",
            oldKey: prevProgressKey,
            podData: buildProgressPodData(dl)
          });
          store.progressPileUpsertThrottle?.delete(prevProgressKey);
          rekeyedThisApply = true;
        }

        if (!isTerminalTransition) {
          if (!dl.canceled && !rekeyedThisApply) {
            const throttle = store.progressPileUpsertThrottle;
            const now = Date.now();
            const last = throttle?.get(canonicalKey) ?? 0;
            if (!throttle || last === 0 || now - last >= store.MIN_UI_UPDATE_INTERVAL_MS) {
              throttle?.set(canonicalKey, now);
              notifyProgressPileListeners({ kind: "upsert", podData: buildProgressPodData(dl) });
            }
          }
          return;
        }

        // Terminal succeeded/error → transition progress → live-pod via pods renderer.
        // On very fast downloads, Zen's arc-flight animation may still be playing;
        // defer pod creation until it completes so the pod doesn't pop in on top.
        if (pie?.waitForArcDone) {
          try {
            await pie.waitForArcDone();
          } catch (e) {
            debugLog("[Lifecycle] pie.waitForArcDone error", e);
          }
        }

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
        scheduleImmediateSticky,
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
