// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-download-ui.uc.js
// Download manager shell DOM creation/rehydration and UI-only handlers.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsDownloadUi = {
    /**
     * @param {Object} ctx
     * @param {function} ctx.debugLog
     * @param {function} ctx.removeCard
     * @param {function} ctx.undoRename
     * @param {function} ctx.cancelAIProcessForDownload
     * @param {function} ctx.eraseDownloadFromHistory
     * @param {function} ctx.getFocusedKey
     * @param {function} ctx.getActiveCardByKey
     * @param {function} ctx.clearAllStickyPods
     * @param {function} ctx.onPileHiddenRepair
     * @param {function} ctx.setupCompactModeObserver
     * @param {function} [ctx.peekFocusSuccessorAfterRemove] - (key) => next focus key if `removeCard(key)` ran now
     * @param {function} [ctx.prepareMasterCloseHandoffToSuccessor] - (successorKey) => swap tooltip before deferred remove (patch 3)
     * @returns {{ getDownloadCardsContainer: function, getMasterTooltip: function, getPodsRow: function, getPodsShell: function }}
     */
    async init(ctx) {
      const {
        debugLog,
        removeCard,
        undoRename,
        cancelAIProcessForDownload,
        eraseDownloadFromHistory,
        getFocusedKey,
        getActiveCardByKey,
        clearAllStickyPods,
        onPileHiddenRepair,
        setupCompactModeObserver,
        peekFocusSuccessorAfterRemove,
        prepareMasterCloseHandoffToSuccessor
      } = ctx;

      let downloadCardsContainer = document.getElementById("userchrome-download-cards-container");
      let podsShellElement = document.getElementById("userchrome-download-pods-shell");
      let masterTooltipDOMElement = null;
      let podsRowContainerElement = null;

      if (!downloadCardsContainer) {
        downloadCardsContainer = document.createElement("div");
        downloadCardsContainer.id = "userchrome-download-cards-container";
        downloadCardsContainer.style.display = "none";
        downloadCardsContainer.style.opacity = "0";
        downloadCardsContainer.style.visibility = "hidden";

        podsShellElement = document.createElement("div");
        podsShellElement.id = "userchrome-download-pods-shell";
        podsRowContainerElement = document.createElement("div");
        podsRowContainerElement.id = "userchrome-pods-row-container";
        podsShellElement.appendChild(podsRowContainerElement);

        const mediaControlsToolbar = document.getElementById("zen-media-controls-toolbar");
        const zenMainAppWrapper = document.getElementById("zen-main-app-wrapper");
        let parentContainer = null;
        if (mediaControlsToolbar && mediaControlsToolbar.parentNode) {
          parentContainer = mediaControlsToolbar.parentNode;
          parentContainer.insertBefore(podsShellElement, mediaControlsToolbar.nextSibling);
          parentContainer.insertBefore(downloadCardsContainer, podsShellElement.nextSibling);
        } else if (zenMainAppWrapper) {
          parentContainer = zenMainAppWrapper;
          zenMainAppWrapper.appendChild(podsShellElement);
          zenMainAppWrapper.appendChild(downloadCardsContainer);
        } else {
          parentContainer = document.body;
          document.body.appendChild(podsShellElement);
          document.body.appendChild(downloadCardsContainer);
        }

        if (parentContainer && parentContainer !== document.body) {
          const parentStyle = window.getComputedStyle(parentContainer);
          if (parentStyle.position === "static") {
            parentContainer.style.position = "relative";
          }
        }
        downloadCardsContainer.style.boxSizing = "border-box";
        setupCompactModeObserver();

        masterTooltipDOMElement = document.createElement("div");
        masterTooltipDOMElement.className = "details-tooltip master-tooltip";
        masterTooltipDOMElement.style.position = "relative";
        masterTooltipDOMElement.innerHTML = `
          <div class="ai-sparkle-layer">
            <div class="sparkle-icon"></div>
            <div class="sparkle-icon"></div>
            <div class="sparkle-icon"></div>
            <div class="sparkle-icon"></div>
            <div class="sparkle-icon"></div>
          </div>
          <div class="card-status">Tooltip Status</div>
          <div class="card-title">Tooltip Title</div>
          <div class="card-original-filename">Original Filename</div>
          <div class="card-progress">Tooltip Progress</div>
          <div class="card-filesize">File Size</div>
          <div class="tooltip-buttons-container">
            <span class="card-undo-button" title="Undo Rename" tabindex="0" role="button">↩</span>
            <span class="card-close-button" title="Close" tabindex="0" role="button">✕</span>
          </div>
          <div class="tooltip-tail"></div>
        `;
        downloadCardsContainer.appendChild(masterTooltipDOMElement);

        document.addEventListener("pile-shown", clearAllStickyPods);
        document.addEventListener("pile-hidden", onPileHiddenRepair);

        const MASTER_TOOLTIP_FADEOUT_MS = window.zenTidyDownloadsUtils.MASTER_TOOLTIP_FADEOUT_MS;
        /**
         * Mirrors tooltip-layout rename-success eligibility (post–AI rename UI only).
         * @param {string|null|undefined} successorKey
         * @returns {boolean}
         */
        function successorKeepsRenameSuccessChrome(successorKey) {
          if (!successorKey) return false;
          const cd = getActiveCardByKey(successorKey);
          if (!cd?.podElement || !cd.download) return false;
          const isProgress =
            cd.phase === "progress" || cd.podElement.dataset?.state === "progress";
          if (isProgress) return false;
          return !!(cd.download.succeeded && cd.download.aiName);
        }

        /**
         * Shared by master close + undo-revert-as-close (patch 3 handoff vs dismiss).
         * @param {string} keyUsedForSuccessorPeek - map key of the pod being dismissed
         * @param {{ download?: unknown, permanentlyDeleted?: boolean }|undefined} cardForRemoval
         */
        function applyMasterTooltipDismissTail(keyUsedForSuccessorPeek, cardForRemoval) {
          if (!keyUsedForSuccessorPeek || !cardForRemoval?.download) return;
          let handoffSuccessor = false;
          const successorAfterClose =
            typeof peekFocusSuccessorAfterRemove === "function"
              ? peekFocusSuccessorAfterRemove(keyUsedForSuccessorPeek)
              : null;
          if (
            successorAfterClose &&
            typeof prepareMasterCloseHandoffToSuccessor === "function" &&
            cardForRemoval.download.succeeded &&
            successorKeepsRenameSuccessChrome(successorAfterClose)
          ) {
            prepareMasterCloseHandoffToSuccessor(successorAfterClose);
            handoffSuccessor = true;
          }
          if (!handoffSuccessor) {
            /* Shared fade path (do not set parent display:none here — it kills CSS transitions). */
            window.zenTidyDownloads?.dismissMasterRenameTooltip?.();
          }
          const keyToRemove = keyUsedForSuccessorPeek;
          const cardSnapshot = cardForRemoval;
          setTimeout(async () => {
            if (!cardSnapshot?.download) return;
            try {
              const download = cardSnapshot.download;
              if (download.succeeded) {
                await cancelAIProcessForDownload(keyToRemove);
                removeCard(keyToRemove, true);
                return;
              }
              if (download.error || cardSnapshot.permanentlyDeleted) {
                cardSnapshot.isManuallyCleaning = true;
                await eraseDownloadFromHistory(download);
                removeCard(keyToRemove, true);
                return;
              }
            } catch (_error) {
              removeCard(keyToRemove, true);
            }
          }, handoffSuccessor ? 0 : MASTER_TOOLTIP_FADEOUT_MS);
        }

        const masterCloseBtn = masterTooltipDOMElement.querySelector(".card-close-button");
        if (masterCloseBtn) {
          const masterCloseHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const focusedKey = getFocusedKey();
            if (!focusedKey) return;
            const cardData = getActiveCardByKey(focusedKey);
            applyMasterTooltipDismissTail(focusedKey, cardData);
          };
          masterCloseBtn.addEventListener("click", masterCloseHandler);
          masterCloseBtn.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") masterCloseHandler(e);
          });
        }

        const masterUndoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");
        if (masterUndoBtn) {
          const masterUndoHandler = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const focusedKey = getFocusedKey();
            if (!focusedKey) return;
            const ok = await undoRename(focusedKey, { skipAutohideAfterSuccess: true });
            if (!ok) return;
            const keyAfterUndo = getFocusedKey();
            if (!keyAfterUndo) return;
            const cardAfterUndo = getActiveCardByKey(keyAfterUndo);
            applyMasterTooltipDismissTail(keyAfterUndo, cardAfterUndo);
          };
          masterUndoBtn.addEventListener("click", masterUndoHandler);
          masterUndoBtn.addEventListener("keydown", async (e) => {
            if (e.key === "Enter" || e.key === " ") await masterUndoHandler(e);
          });
        }
      } else {
        masterTooltipDOMElement = downloadCardsContainer.querySelector(".master-tooltip");
        podsRowContainerElement = document.getElementById("userchrome-pods-row-container");
        podsShellElement = document.getElementById("userchrome-download-pods-shell");
        if (podsRowContainerElement && podsRowContainerElement.parentElement === downloadCardsContainer) {
          if (!podsShellElement) {
            podsShellElement = document.createElement("div");
            podsShellElement.id = "userchrome-download-pods-shell";
            downloadCardsContainer.parentNode.insertBefore(podsShellElement, downloadCardsContainer.nextSibling);
          }
          podsShellElement.appendChild(podsRowContainerElement);
          debugLog("[DownloadUI] Migrated #userchrome-pods-row-container out of cards container into pods shell");
        } else if (!podsShellElement && podsRowContainerElement?.parentElement?.id === "userchrome-download-pods-shell") {
          podsShellElement = podsRowContainerElement.parentElement;
        }
      }

      debugLog("Download UI shell initialized");

      return {
        getDownloadCardsContainer: () => downloadCardsContainer,
        getMasterTooltip: () => masterTooltipDOMElement,
        getPodsRow: () => podsRowContainerElement,
        getPodsShell: () => podsShellElement
      };
    }
  };
})();
