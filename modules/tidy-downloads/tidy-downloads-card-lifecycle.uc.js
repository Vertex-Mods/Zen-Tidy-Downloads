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
     * @param {function} [ctx.getAddToAIRenameQueue] - () => addToAIRenameQueue impl (terminal enqueue, not pod-owned)
     * @param {function} [ctx.formatBytes] - human-readable byte formatter (progress sublabel)
     * @returns {{ capturePodDataForDismissal: function, removeCard: function, scheduleCardRemoval: function, scheduleImmediateSticky: function, performAutohideSequence: function, makePodSticky: function, absorbIntoPileWithoutSticky: function, clearStickyPod: function, clearAllStickyPods: function, clearStickyPodsOnly: function, apply: function, getPhase: function, reconcileDismissedForIncoming: function, onPileHidden: function, destroy: function }}
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
        getAiRenamingPossible,
        getAddToAIRenameQueue
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

      const clearCardTimers = window.zenTidyDownloadsUtils.clearCardTimers;

      /**
       * Compact ETA string from remaining seconds (download pod sublabel).
       * @param {number} seconds
       * @returns {string|null}
       */
      function formatCompactEta(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return null;
        const totalSec = Math.max(1, Math.ceil(seconds));
        if (totalSec < 60) return `~${totalSec}s`;
        const totalMin = Math.ceil(totalSec / 60);
        if (totalMin < 60) return `~${totalMin}m`;
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        return m === 0 ? `~${h}h` : `~${h}h ${m}m`;
      }

      /**
       * @param {unknown} dl
       * @returns {string} suffix like " · ~3m", or ""
       */
      function formatEstimatedTimeSuffix(dl) {
        const cur = dl.currentBytes || 0;
        const total = dl.totalBytes;
        const speed = dl.speed;
        if (typeof total !== "number" || total <= cur || !(typeof speed === "number" && speed > 0)) {
          return "";
        }
        const eta = formatCompactEta((total - cur) / speed);
        return eta ? ` · ${eta}` : "";
      }

      function formatProgressSubLabel(dl) {
        const cur = dl.currentBytes || 0;
        const total = dl.totalBytes;
        const etaSuffix = formatEstimatedTimeSuffix(dl);
        if (typeof total === "number" && total > 0) {
          return `${formatBytesFn(cur)} / ${formatBytesFn(total)}${etaSuffix}`;
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
        window.zenTidyDownloadsUtils.notifyListeners(store.progressPileListeners, payload, "");
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
          canceled: !!download.canceled,
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

      /**
       * Wall-clock ms when the download reached a terminal succeeded state (for autohide window math).
       * @param {Object|undefined} dl
       * @returns {number}
       */
      function getTerminalWallTimeFromDownload(dl) {
        if (!dl) return Date.now();
        if (dl.endTime != null) {
          const n = typeof dl.endTime === "number" ? dl.endTime : new Date(dl.endTime).getTime();
          if (Number.isFinite(n)) return n;
        }
        if (dl.startTime != null) {
          const n = typeof dl.startTime === "number" ? dl.startTime : new Date(dl.startTime).getTime();
          if (Number.isFinite(n)) return n;
        }
        return Date.now();
      }

      /**
       * Enqueue AI rename from lifecycle (not pod renderer). Idempotent with queue dedupe.
       * @param {string} downloadKey
       */
      function maybeEnqueueAIRename(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData?.download?.succeeded || !cardData.download.target?.path) return;
        if (!getPref("extensions.downloads.enable_ai_renaming", true)) return;
        if (typeof getAiRenamingPossible === "function" && !getAiRenamingPossible()) return;
        if (renamedFiles.has(cardData.download.target.path)) return;
        const fn = typeof getAddToAIRenameQueue === "function" ? getAddToAIRenameQueue() : null;
        if (typeof fn !== "function") return;
        // Pre-arm AI-pending key BEFORE enqueueing so a fast AI completion's
        // releasePileHoverExpandBlockForKey runs against an existing entry.
        // Otherwise add() in makePodStickyCore could lose the race and leave
        // the set wrong for tooltip fade coordination.
        try {
          store.pileHoverExpandBlockedUntilAIDoneKeys?.add(downloadKey);
          cardData.suppressToolbarPodForAIRename = true;
          const ok = fn(downloadKey, cardData.download, cardData.originalFilename);
          if (ok === false) {
            store.pileHoverExpandBlockedUntilAIDoneKeys?.delete(downloadKey);
            cardData.suppressToolbarPodForAIRename = false;
            if (typeof managePodVisibilityAndAnimations === "function") {
              try {
                managePodVisibilityAndAnimations();
              } catch (_e) {}
            }
          }
        } catch (e) {
          debugLog("[Lifecycle] maybeEnqueueAIRename error", e);
          store.pileHoverExpandBlockedUntilAIDoneKeys?.delete(downloadKey);
          cardData.suppressToolbarPodForAIRename = false;
          if (typeof managePodVisibilityAndAnimations === "function") {
            try {
              managePodVisibilityAndAnimations();
            } catch (_e2) {}
          }
        }
      }

      /**
       * Emit pod-dismissed payload and listener callbacks.
       * @param {string} downloadKey
       * @param {{ wasManual?: boolean, phase?: string }} [opts]
       * @returns {any|null}
       */
      function emitPodDismissed(downloadKey, opts = {}) {
        const { wasManual = false, phase } = opts;
        const dismissedData = capturePodDataForDismissal(downloadKey);
        if (!dismissedData) return null;
        dismissedPodsData.set(downloadKey, dismissedData);
        dismissEventListeners.forEach((callback) => {
          try {
            callback(dismissedData);
          } catch (_error) {}
        });
        const detail = { podKey: downloadKey, podData: dismissedData, wasManual };
        if (phase) detail.phase = phase;
        fireCustomEvent("pod-dismissed", detail);
        return dismissedData;
      }

      /**
       * Remove key from active maps and ordered list.
       * @param {string} downloadKey
       * @returns {number}
       */
      function removePodTracking(downloadKey) {
        activeDownloadCards.delete(downloadKey);
        cardUpdateThrottle.delete(downloadKey);
        const removedPodIndex = orderedPodKeys.indexOf(downloadKey);
        if (removedPodIndex > -1) orderedPodKeys.splice(removedPodIndex, 1);
        return removedPodIndex;
      }

      /**
       * Next focused sticky pod when the jukebox list is empty (piled toolbar stickies only).
       * Prefers newer stickies first (reverse insertion order).
       * @param {string|null} [excludeKey] - omit e.g. a key just attached to stickyPods but focus should leave it
       * @returns {string|null}
       */
      function pickFocusKeyFromStickySurvivors(excludeKey = null) {
        if (!(stickyPods instanceof Set) || stickyPods.size === 0) return null;
        const keysFromNewest = Array.from(stickyPods).reverse();
        for (const key of keysFromNewest) {
          if (excludeKey != null && key === excludeKey) continue;
          const cd = activeDownloadCards.get(key);
          if (cd && !cd.isBeingRemoved) return key;
        }
        return null;
      }

      /**
       * @param {number} removedPodIndex
       * @param {string[]} hypotheticalOrdered - keys after removal (or current ordered if not yet removed)
       * @param {string|null} [stickyExcludeKey] - passed to sticky fallback when `hypotheticalOrdered` is empty
       * @returns {string|null}
       */
      function getReplacementFocusKeyWithSnapshot(removedPodIndex, hypotheticalOrdered, stickyExcludeKey = null) {
        if (hypotheticalOrdered.length === 0) {
          return pickFocusKeyFromStickySurvivors(stickyExcludeKey);
        }
        if (removedPodIndex >= 0 && removedPodIndex < hypotheticalOrdered.length) {
          return hypotheticalOrdered[removedPodIndex];
        }
        if (removedPodIndex > 0 && removedPodIndex - 1 < hypotheticalOrdered.length) {
          return hypotheticalOrdered[removedPodIndex - 1];
        }
        return hypotheticalOrdered[hypotheticalOrdered.length - 1] || null;
      }

      /**
       * Compute focus target after removing a pod from ordered tracking (`removePodTracking`).
       * Uses jukebox neighbor keys when live pods remain; falls back to a surviving sticky pile pod.
       * @param {number} removedPodIndex - index returned by removePodTracking (before splice); may be `-1`.
       * @returns {string|null}
       */
      function getReplacementFocusKey(removedPodIndex) {
        return getReplacementFocusKeyWithSnapshot(removedPodIndex, orderedPodKeys, null);
      }

      /**
       * Predict `focusedKeyRef` after `removeCard(key)` without mutating state (master close handoff).
       * @param {string} downloadKey
       * @returns {string|null}
       */
      function peekFocusSuccessorAfterRemove(downloadKey) {
        const removedPodIndex = orderedPodKeys.indexOf(downloadKey);
        const hypotheticalOrdered =
          removedPodIndex > -1
            ? orderedPodKeys.filter((k) => k !== downloadKey)
            : [...orderedPodKeys];
        return getReplacementFocusKeyWithSnapshot(removedPodIndex, hypotheticalOrdered, downloadKey);
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

          emitPodDismissed(downloadKey, { wasManual: force });

          cardData.isBeingRemoved = true;
          cardData.phase = "dismissed";
          clearCardTimers(cardData, { autohide: false, deferredSticky: true });
          await cancelAIProcessForDownload(downloadKey);
          clearCardTimers(cardData, { autohide: true, deferredSticky: false });

          podElement.style.transition = "opacity 0.3s ease-out, transform 0.3s ease-in-out";
          podElement.style.opacity = "0";
          podElement.style.transform = "translateX(-60px) scale(0.8)";

          setTimeout(() => {
            const current = activeDownloadCards.get(downloadKey);
            const download = current?.download;
            if (podElement.parentNode) podElement.parentNode.removeChild(podElement);
            const removedPodIndex = removePodTracking(downloadKey);

            if (
              force ||
              !download ||
              !download.succeeded ||
              (download.succeeded && Date.now() - (download.endTime || download.startTime || 0) > 60000)
            ) {
              dismissedDownloads.add(downloadKey);
            }

            if (focusedKeyRef.current === downloadKey) {
              focusedKeyRef.current = getReplacementFocusKey(removedPodIndex);
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
          clearCardTimers(cardData, { autohide: true, deferredSticky: false });
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
          if (cardData.download?.canceled) {
            clearCardTimers(cardData, { autohide: true, deferredSticky: false });
            Promise.resolve()
              .then(() => absorbIntoPileWithoutSticky(downloadKey))
              .catch((e) => debugLog("[Lifecycle] scheduleImmediateSticky absorb (canceled) error", e));
            return;
          }
          seedPileEntryForLivePod(downloadKey);
          if (cardData.download?.succeeded) {
            if (cardData.terminalCompletedAtMs == null) {
              cardData.terminalCompletedAtMs = getTerminalWallTimeFromDownload(cardData.download);
            }
            maybeEnqueueAIRename(downloadKey);
          }
          clearCardTimers(cardData, { autohide: true, deferredSticky: false });
          Promise.resolve()
            .then(() => makePodSticky(downloadKey))
            .catch((e) => debugLog("[Lifecycle] scheduleImmediateSticky makePodSticky error", e));
        } catch (error) {
          console.error("Error in scheduleImmediateSticky:", error);
        }
      }

      const MASTER_TOOLTIP_FADEOUT_MS = window.zenTidyDownloadsUtils.MASTER_TOOLTIP_FADEOUT_MS;

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
       * Run shared master tooltip fade with jukebox-successor guard.
       * @param {HTMLElement|null|undefined} masterTooltipDOMElement
       * @param {HTMLElement|null|undefined} downloadCardsContainer
       * @param {() => void} [onAfterFade]
       */
      function runMasterTooltipFadeout(masterTooltipDOMElement, downloadCardsContainer, onAfterFade) {
        const sharedFade = window.zenTidyDownloadsUtils?.runMasterTooltipFade;
        if (typeof sharedFade === "function") {
          sharedFade({
            store,
            masterTooltipDOMElement,
            downloadCardsContainer,
            beginFade: beginMasterTooltipFadeout,
            collapseContainer: collapseDownloadCardsContainerWithTooltipFade,
            onAfterFade
          });
          return;
        }
        beginMasterTooltipFadeout(downloadCardsContainer);
        if (masterTooltipDOMElement) {
          masterTooltipDOMElement.style.opacity = "0";
          masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
          masterTooltipDOMElement.style.pointerEvents = "none";
        }
        setTimeout(() => {
          if (store.masterRenameTooltipSuppressed === false) {
            store.masterTooltipFadeoutActive = false;
            return;
          }
          if (masterTooltipDOMElement && masterTooltipDOMElement.style.opacity === "0") {
            masterTooltipDOMElement.style.display = "none";
          }
          collapseDownloadCardsContainerWithTooltipFade(downloadCardsContainer);
          if (typeof onAfterFade === "function") onAfterFade();
        }, MASTER_TOOLTIP_FADEOUT_MS);
      }

      /**
       * After autohide_delay_ms, a pod may already be sticky (e.g. AI rename showed
       * rename-success chrome). Collapse master tooltip + cards without re-running makePodSticky.
       * @param {string} downloadKey
       */
      function dismissStickyPostRenameChrome(downloadKey) {
        store.masterRenameTooltipSuppressed = true;
        store.pileHoverBlockedByRenameTooltip = false;

        const cd = activeDownloadCards.get(downloadKey);
        clearCardTimers(cd, { autohide: false, deferredSticky: true });

        if (focusedKeyRef.current === downloadKey) {
          focusedKeyRef.current =
            orderedPodKeys.length > 0
              ? orderedPodKeys[orderedPodKeys.length - 1]
              : pickFocusKeyFromStickySurvivors(downloadKey);
        }

        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();

        runMasterTooltipFadeout(masterTooltipDOMElement, downloadCardsContainer, () => {
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
        });
        if (typeof updateDownloadCardsVisibility === "function") {
          updateDownloadCardsVisibility();
        }
      }

      async function performAutohideSequence(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData) return;
        clearCardTimers(cardData, { autohide: true, deferredSticky: false });
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

        clearCardTimers(cardData);
        emitPodDismissed(downloadKey, { wasManual: false });

        dismissedDownloads.add(downloadKey);
        cardData.isBeingRemoved = true;
        cardData.phase = "dismissed";

        const wasFocused = focusedKeyRef.current === downloadKey;
        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();
        let layoutAfterTooltipFadeMs = 0;

        const podElement = cardData.podElement;
        if (podElement?.parentNode) podElement.parentNode.removeChild(podElement);

        const removedPodIndex = removePodTracking(downloadKey);

        if (focusedKeyRef.current === downloadKey) {
          focusedKeyRef.current = getReplacementFocusKey(removedPodIndex);
        }

        const podsRowContainerElement = getPodsRowContainer();
        if (podsRowContainerElement && stickyPods.size === 0) {
          podsRowContainerElement.style.pointerEvents = "";
        }

        if (wasFocused && masterTooltipDOMElement) {
          layoutAfterTooltipFadeMs = MASTER_TOOLTIP_FADEOUT_MS;
          runMasterTooltipFadeout(masterTooltipDOMElement, downloadCardsContainer);
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

      /**
       * Toolbar pod is hidden while pile is expanded; absorb after remaining autohide window unless pile collapses first.
       * @param {string} downloadKey
       */
      function enterDeferredStickyPhase(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || cardData.isSticky || cardData.isBeingRemoved) return;
        if (cardData.phase === "deferred-sticky") return;

        if (cardData.terminalCompletedAtMs == null) {
          cardData.terminalCompletedAtMs = getTerminalWallTimeFromDownload(cardData.download);
        }

        clearCardTimers(cardData, { autohide: false, deferredSticky: true });

        cardData.phase = "deferred-sticky";
        cardData.deferredStickyAt = Date.now();

        const podElement = cardData.podElement;
        if (podElement) {
          podElement.style.display = "none";
        }

        // Force-refresh the pile entry with completion data. seedPileEntryForLivePod
        // (called earlier in scheduleImmediateSticky) early-returns if dismissedPodsData
        // already has this key (e.g. from a prior re-download or stale sidecar), so
        // when the pile is currently expanded we re-fire the dismiss event here to
        // guarantee the in-progress row swaps to the completed row.
        try {
          emitPodDismissed(downloadKey, { wasManual: false, phase: "deferred-sticky" });
        } catch (err) {
          debugLog("[Lifecycle] enterDeferredStickyPhase pile refresh error", err);
        }

        const wasFocused = focusedKeyRef.current === downloadKey;
        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();
        let layoutAfterTooltipFadeMs = 0;

        if (wasFocused && masterTooltipDOMElement) {
          layoutAfterTooltipFadeMs = MASTER_TOOLTIP_FADEOUT_MS;
          runMasterTooltipFadeout(masterTooltipDOMElement, downloadCardsContainer);
          focusedKeyRef.current =
            orderedPodKeys.length > 0
              ? orderedPodKeys[orderedPodKeys.length - 1]
              : pickFocusKeyFromStickySurvivors(downloadKey);
        }

        if (
          layoutAfterTooltipFadeMs > 0 &&
          typeof updateDownloadCardsVisibility === "function"
        ) {
          updateDownloadCardsVisibility();
        }

        const disableAutohide = getPref(DISABLE_AUTOHIDE_PREF, false);
        const autohideMs = disableAutohide ? null : getPref("extensions.downloads.autohide_delay_ms", 10000);
        const remainingMs =
          autohideMs == null ? null : Math.max(0, autohideMs - (Date.now() - cardData.terminalCompletedAtMs));

        const runLayout = () => {
          if (typeof managePodVisibilityAndAnimations === "function") {
            try {
              managePodVisibilityAndAnimations();
            } catch (err) {
              debugLog("[Lifecycle] managePod after enterDeferredStickyPhase", err);
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

        updateUIForFocusedDownload(focusedKeyRef.current, false);

        // While AI rename is in-flight, deferred-sticky would otherwise schedule absorb
        // immediately or on the autohide timer against the pile-block key — the card gets
        // removed before Mistral finishes, breaking post-rename tooltip/pod handoff (NO_CARD_DATA).
        const aiBlocksDeferredAbsorb =
          store.pileHoverExpandBlockedUntilAIDoneKeys instanceof Set &&
          store.pileHoverExpandBlockedUntilAIDoneKeys.has(downloadKey);

        if (aiBlocksDeferredAbsorb) {
          debugLog(
            "[Lifecycle] enterDeferredStickyPhase: AI rename in flight — skipping absorb scheduling until AI completes",
            downloadKey
          );
          return;
        }

        if (remainingMs === 0) {
          Promise.resolve()
            .then(() => absorbIntoPileWithoutSticky(downloadKey))
            .catch((e) => debugLog("[Lifecycle] enterDeferredStickyPhase immediate absorb error", e));
          return;
        }
        if (remainingMs == null) {
          return;
        }

        cardData.deferredStickyTimeoutId = setTimeout(() => {
          cardData.deferredStickyTimeoutId = null;
          Promise.resolve()
            .then(() => absorbIntoPileWithoutSticky(downloadKey))
            .catch((e) => debugLog("[Lifecycle] commitDeferredAbsorb error", e));
        }, remainingMs);
      }

      /**
       * If enterDeferredStickyPhase skipped absorb while AI held `pileHoverExpandBlockedUntilAIDoneKeys`,
       * reschedule immediate or delayed absorb once AI has released — idempotent if a timer already exists.
       * @param {string} downloadKey
       */
      function scheduleDeferredStickyAbsorbIfNeeded(downloadKey) {
        if (!downloadKey) return;
        const cardData = activeDownloadCards.get(downloadKey);
        if (
          !cardData ||
          cardData.isBeingRemoved ||
          cardData.phase !== "deferred-sticky" ||
          cardData.isSticky
        ) {
          return;
        }

        const pileBlock = store.pileHoverExpandBlockedUntilAIDoneKeys;
        if (pileBlock instanceof Set && pileBlock.has(downloadKey)) {
          return;
        }
        if (cardData.deferredStickyTimeoutId != null) return;

        if (cardData.terminalCompletedAtMs == null) {
          cardData.terminalCompletedAtMs = getTerminalWallTimeFromDownload(cardData.download);
        }

        const disableAutohide = getPref(DISABLE_AUTOHIDE_PREF, false);
        const autohideMs = disableAutohide ? null : getPref("extensions.downloads.autohide_delay_ms", 10000);
        const remainingMs =
          autohideMs == null ? null : Math.max(0, autohideMs - (Date.now() - cardData.terminalCompletedAtMs));

        if (remainingMs === 0) {
          Promise.resolve()
            .then(() => absorbIntoPileWithoutSticky(downloadKey))
            .catch((e) => debugLog("[Lifecycle] scheduleDeferredStickyAbsorbIfNeeded immediate absorb error", e));
          return;
        }
        if (remainingMs == null) {
          return;
        }

        cardData.deferredStickyTimeoutId = setTimeout(() => {
          cardData.deferredStickyTimeoutId = null;
          Promise.resolve()
            .then(() => absorbIntoPileWithoutSticky(downloadKey))
            .catch((e) => debugLog("[Lifecycle] scheduleDeferredStickyAbsorbIfNeeded deferred absorb error", e));
        }, remainingMs);
      }

      /**
       * Apply sticky toolbar pod + pile sidecar (shared by normal sticky and pile-collapse reveal).
       * @param {string} downloadKey
       * @param {{ fadeTooltipIfFocused?: boolean }} [opts]
       */
      async function makePodStickyCore(downloadKey, opts = {}) {
        const { fadeTooltipIfFocused = true } = opts;
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || cardData.isSticky || cardData.isBeingRemoved) return;

        store.masterRenameTooltipSuppressed = true;
        store.pileHoverBlockedByRenameTooltip = false;

        clearCardTimers(cardData);
        emitPodDismissed(downloadKey, { wasManual: false });

        stickyPods.add(downloadKey);
        cardData.isSticky = true;
        cardData.phase = "sticky";
        dismissedDownloads.add(downloadKey);
        if (cardData.podElement) {
          const podElement = cardData.podElement;
          podElement.style.display = "";
          podElement.classList.add("zen-tidy-sticky-pod");
          podElement.style.pointerEvents = "auto";
          podElement.style.cursor = "pointer";
        }

        // AI-pending key is pre-armed in maybeEnqueueAIRename so a fast AI
        // completion can't lose its release; do NOT re-add here, otherwise an
        // already-released "suitable name"/error could leave the set inconsistent.

        const podsRowContainerElement = getPodsRowContainer();
        if (podsRowContainerElement) {
          podsRowContainerElement.style.pointerEvents = "none";
        }

        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();
        let layoutAfterTooltipFadeMs = 0;
        // Skip the live-pod-to-sticky tooltip fadeout while AI rename is pending
        // for this key. AI rename writes "Analyzing file..." → "Renaming to: …"
        // → "Download renamed to:" into the same tooltip; fading it out here and
        // relying on AI completion to fade it back in causes the tooltip to never
        // re-appear due to a timing race between the 450ms fade-out setTimeout
        // and updateUIForFocusedDownload() reapplying styles.
        const aiPendingForKey =
          store.pileHoverExpandBlockedUntilAIDoneKeys instanceof Set &&
          store.pileHoverExpandBlockedUntilAIDoneKeys.has(downloadKey);
        if (
          fadeTooltipIfFocused &&
          !aiPendingForKey &&
          focusedKeyRef.current === downloadKey &&
          masterTooltipDOMElement
        ) {
          layoutAfterTooltipFadeMs = MASTER_TOOLTIP_FADEOUT_MS;
          runMasterTooltipFadeout(masterTooltipDOMElement, downloadCardsContainer);
          focusedKeyRef.current =
            orderedPodKeys.length > 0
              ? orderedPodKeys[orderedPodKeys.length - 1]
              : pickFocusKeyFromStickySurvivors(downloadKey);
        } else if (aiPendingForKey) {
          // AI is in flight; keep tooltip visible and let AI status writes / final
          // updateUIForFocusedDownload drive its content. Don't suppress so the
          // status text stays painted.
          store.masterRenameTooltipSuppressed = false;
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
              debugLog("[Lifecycle] managePodVisibilityAndAnimations after makePodStickyCore", err);
            }
          }
        };
        if (layoutAfterTooltipFadeMs > 0) {
          setTimeout(runLayout, layoutAfterTooltipFadeMs);
        } else {
          runLayout();
        }
      }

      async function makePodSticky(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || cardData.isSticky || cardData.isBeingRemoved) return;

        if (cardData.download?.canceled) {
          await absorbIntoPileWithoutSticky(downloadKey);
          return;
        }

        if (shouldAbsorbInsteadOfStickyPod()) {
          if (cardData.download?.succeeded) {
            enterDeferredStickyPhase(downloadKey);
            return;
          }
          await absorbIntoPileWithoutSticky(downloadKey);
          return;
        }

        await makePodStickyCore(downloadKey, { fadeTooltipIfFocused: true });
      }

      /**
       * After AI rename completes on a `deferred-sticky` card: surface toolbar pod + tooltip when
       * the pile is not expanded or the autohide window has elapsed; if the pile is expanded and
       * autohide is still pending, defer (same as pre-AI behavior). If expanded and autohide just
       * elapsed (remainingMs === 0), absorb pile-only.
       * @param {string} downloadKey
       * @returns {Promise<boolean>} true if absorb or toolbar promotion ran; false if still deferred
       */
      async function finishDeferredStickyAfterAISuccess(downloadKey) {
        const cardData = activeDownloadCards.get(downloadKey);
        if (!cardData || cardData.phase !== "deferred-sticky") return false;

        let pileExpanded = false;
        try {
          pileExpanded = window.__zenDismissedPileIntegration?.isPileExpanded?.() === true;
        } catch (_e) {}

        const terminalMs = cardData.terminalCompletedAtMs ?? Date.now();
        const disableAutohide = getPref(DISABLE_AUTOHIDE_PREF, false);
        const autohideMs = disableAutohide ? null : getPref("extensions.downloads.autohide_delay_ms", 10000);
        const remainingMs =
          autohideMs == null ? null : Math.max(0, autohideMs - (Date.now() - terminalMs));

        const shouldDeferToolbarChrome =
          pileExpanded && remainingMs !== null && remainingMs > 0;

        if (shouldDeferToolbarChrome) {
          debugLog(
            "[Lifecycle] finishDeferredStickyAfterAISuccess: pile expanded + autohide pending — defer toolbar chrome until pile collapses",
            { downloadKey }
          );
          return false;
        }

        clearCardTimers(cardData, { autohide: false, deferredSticky: true });

        if (remainingMs === 0) {
          await absorbIntoPileWithoutSticky(downloadKey);
          return true;
        }

        if (cardData.podElement) {
          cardData.podElement.style.display = "";
        }

        await makePodStickyCore(downloadKey, { fadeTooltipIfFocused: false });

        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();
        if (downloadCardsContainer) {
          downloadCardsContainer.style.display = "flex";
          downloadCardsContainer.style.visibility = "visible";
          downloadCardsContainer.style.opacity = "1";
          downloadCardsContainer.style.pointerEvents = "auto";
        }
        if (masterTooltipDOMElement) {
          masterTooltipDOMElement.style.display = "";
          masterTooltipDOMElement.style.opacity = "1";
          masterTooltipDOMElement.style.transform = "";
          masterTooltipDOMElement.style.pointerEvents = "auto";
          masterTooltipDOMElement.style.visibility = "visible";
        }
        store.masterTooltipFadeoutActive = false;

        focusedKeyRef.current = downloadKey;
        updateUIForFocusedDownload(downloadKey, true);

        if (remainingMs != null && remainingMs > 0) {
          cardData.autohideTimeoutId = setTimeout(() => {
            performAutohideSequence(downloadKey);
          }, remainingMs);
        }

        if (typeof managePodVisibilityAndAnimations === "function") {
          try {
            managePodVisibilityAndAnimations();
          } catch (_err) {
            debugLog("[Lifecycle] managePod after finishDeferredStickyAfterAISuccess", _err);
          }
        }
        if (typeof updateDownloadCardsVisibility === "function") {
          updateDownloadCardsVisibility();
        }
        return true;
      }

      /**
       * Pile collapsed: reveal deferred toolbar pods + tooltip with remaining autohide budget.
       */
      async function onPileHidden() {
        const keysSnapshot = Array.from(activeDownloadCards.keys());
        for (const downloadKey of keysSnapshot) {
          const cardData = activeDownloadCards.get(downloadKey);
          if (!cardData || cardData.phase !== "deferred-sticky") continue;
          if (cardData.suppressToolbarPodForAIRename) continue;

          clearCardTimers(cardData, { autohide: false, deferredSticky: true });

          const terminalMs = cardData.terminalCompletedAtMs ?? Date.now();
          const disableAutohide = getPref(DISABLE_AUTOHIDE_PREF, false);
          const autohideMs = disableAutohide ? null : getPref("extensions.downloads.autohide_delay_ms", 10000);
          const remainingMs =
            autohideMs == null ? null : Math.max(0, autohideMs - (Date.now() - terminalMs));

          if (remainingMs === 0) {
            await absorbIntoPileWithoutSticky(downloadKey);
            continue;
          }

          if (cardData.podElement) {
            cardData.podElement.style.display = "";
          }

          await makePodStickyCore(downloadKey, { fadeTooltipIfFocused: false });

          const masterTooltipDOMElement = getMasterTooltip();
          const downloadCardsContainer = getDownloadCardsContainer();
          if (downloadCardsContainer) {
            downloadCardsContainer.style.display = "flex";
            downloadCardsContainer.style.visibility = "visible";
            downloadCardsContainer.style.opacity = "1";
            downloadCardsContainer.style.pointerEvents = "auto";
          }
          if (masterTooltipDOMElement) {
            masterTooltipDOMElement.style.display = "";
            masterTooltipDOMElement.style.opacity = "1";
            masterTooltipDOMElement.style.transform = "";
            masterTooltipDOMElement.style.pointerEvents = "auto";
          }
          store.masterTooltipFadeoutActive = false;

          focusedKeyRef.current = downloadKey;
          updateUIForFocusedDownload(downloadKey, true);

          if (remainingMs != null && remainingMs > 0) {
            cardData.autohideTimeoutId = setTimeout(() => {
              performAutohideSequence(downloadKey);
            }, remainingMs);
          }
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
            orderedPodKeys.length > 0
              ? orderedPodKeys[orderedPodKeys.length - 1]
              : pickFocusKeyFromStickySurvivors(null);
        }
        if (podElement && podElement.parentNode) podElement.parentNode.removeChild(podElement);
        activeDownloadCards.delete(downloadKey);
        cardUpdateThrottle.delete(downloadKey);
      }

      function clearAllStickyPods() {
        const keys = Array.from(stickyPods);
        if (keys.length === 0) return;
        /* Dismissed pile expanded: drop toolbar focus and suppress rename-success chrome
           *before* clearing each sticky so a transient focusedKeyRef / aiName card cannot
           * make compact-visibility show the cards container for one frame. Also clear the
           * fade flag so the "fadeout in progress → keep subtree flex" branch does not run. */
        store.masterRenameTooltipSuppressed = true;
        store.pileHoverBlockedByRenameTooltip = false;
        store.masterTooltipFadeoutActive = false;
        focusedKeyRef.current = null;
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
       *   - "progress"        : in-flight, rendered by the library-pie
       *   - "live-pod"      : completed, pod card visible in the pods row
       *   - "deferred-sticky" : completed while pile expanded; toolbar pod hidden until collapse or absorb timer
       *   - "sticky"        : autohide elapsed; pod waiting to be absorbed by the pile
       *   - "dismissed"     : fade-out in flight or already removed
       *   - null        : unknown key
       * @param {string} key
       * @returns {"progress"|"live-pod"|"deferred-sticky"|"sticky"|"dismissed"|null}
       */
      function getPhase(key) {
        if (!key) return null;
        const cardData = activeDownloadCards.get(key);
        if (cardData) {
          if (cardData.phase === "deferred-sticky") return "deferred-sticky";
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

        function getPieController() {
          return typeof getLibraryPieController === "function" ? getLibraryPieController() : null;
        }
        function syncPieDownload(pieController) {
          try {
            pieController?.syncDownload?.(dl, removed);
          } catch (e) {
            debugLog("[Lifecycle] pie.syncDownload error", e);
          }
        }
        function captureHandoffSnapshotIfNeeded(pieController, key) {
          const isTerminalTransition = !removed && (dl.succeeded === true || !!dl.error || !!dl.canceled);
          const isHandoffTerminal = !removed && (dl.succeeded === true || !!dl.error);
          const wasAlreadyLive = activeDownloadCards.has(key);
          const animator = typeof getHandoffAnimator === "function" ? getHandoffAnimator() : null;
          const shouldCaptureSnapshot =
            isHandoffTerminal && !wasAlreadyLive && animator && animator.isEnabled?.();
          let handoffSnapshot = null;
          if (shouldCaptureSnapshot) {
            try {
              handoffSnapshot = pieController?.captureHandoffSnapshot?.() || null;
            } catch (e) {
              debugLog("[Lifecycle] pie.captureHandoffSnapshot error", e);
            }
          }
          return { isTerminalTransition, animator, handoffSnapshot };
        }
        async function applyRemovedBranch(key, canonicalKey, prevProgressKey) {
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
        }
        function applyProgressBranch(canonicalKey, prevProgressKey) {
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
          if (!dl.canceled && !rekeyedThisApply) {
            const throttle = store.progressPileUpsertThrottle;
            const now = Date.now();
            const last = throttle?.get(canonicalKey) ?? 0;
            if (!throttle || last === 0 || now - last >= store.MIN_UI_UPDATE_INTERVAL_MS) {
              throttle?.set(canonicalKey, now);
              notifyProgressPileListeners({ kind: "upsert", podData: buildProgressPodData(dl) });
            }
          }
        }
        async function applyTerminalBranch(key, pieController, animator, handoffSnapshot) {
          if (pieController?.waitForArcDone) {
            try {
              await pieController.waitForArcDone();
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

        if (typeof getDownloadKey !== "function") {
          syncPieDownload(getPieController());
          debugLog("[Lifecycle] apply() called without getDownloadKey; skipping pods dispatch");
          return;
        }

        const key = getDownloadKey(dl);
        const pie = getPieController();
        const { isTerminalTransition, animator, handoffSnapshot } = captureHandoffSnapshotIfNeeded(pie, key);
        const prevProgressKey = store.progressPileKeyByDownload?.get(dl);
        syncPieDownload(pie);
        const canonicalKey = getDownloadKey(dl);

        if (removed) {
          await applyRemovedBranch(key, canonicalKey, prevProgressKey);
          return;
        }
        if (!isTerminalTransition) {
          applyProgressBranch(canonicalKey, prevProgressKey);
          return;
        }
        await applyTerminalBranch(key, pie, animator, handoffSnapshot);
      }

      /**
       * Tear down any active timers the lifecycle owns. Currently limited to
       * per-card autohide timeouts — DOM listeners attached to pod elements
       * are cleaned up when the pods themselves are removed. Idempotent.
       */
      function destroy() {
        activeDownloadCards.forEach((cardData) => {
          clearCardTimers(cardData);
        });
      }

      return {
        capturePodDataForDismissal,
        removeCard,
        peekFocusSuccessorAfterRemove,
        scheduleCardRemoval,
        scheduleImmediateSticky,
        performAutohideSequence,
        makePodSticky,
        absorbIntoPileWithoutSticky,
        clearStickyPod,
        clearAllStickyPods,
        clearStickyPodsOnly,
        apply,
        getPhase,
        reconcileDismissedForIncoming,
        onPileHidden,
        finishDeferredStickyAfterAISuccess,
        scheduleDeferredStickyAbsorbIfNeeded,
        destroy
      };
    }
  };
})();
