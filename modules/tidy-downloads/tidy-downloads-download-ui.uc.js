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
     * @param {function(): Promise<Element|null|undefined>} [ctx.findDownloadsButton] - resolves
     *   the anchor toolbar control (native downloads or zen-library-button); pods row is reparented here
     * @returns {{ getDownloadCardsContainer: function, getMasterTooltip: function, getPodsRow: function }}
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
        findDownloadsButton
      } = ctx;

      let downloadCardsContainer = document.getElementById("userchrome-download-cards-container");
      let masterTooltipDOMElement = null;
      let podsRowContainerElement = null;
      /** @type {MutationObserver|null} */
      let footToolbarObserver = null;
      /** @type {Element|null} */
      let preparedAnchorRef = null;

      /**
       * @param {Element} anchor
       */
      function prepareAnchorForBadges(anchor) {
        try {
          anchor.classList.add("zen-tidy-download-badge-anchor");
          const cs = window.getComputedStyle(anchor);
          if (cs.position === "static") {
            anchor.style.position = "relative";
          }
          anchor.style.setProperty("overflow", "visible", "important");
        } catch (e) {
          debugLog("[DownloadUI] prepareAnchorForBadges:", e);
        }
      }

      /**
       * Reparent #userchrome-pods-row-container under the resolved downloads / library button.
       * @param {Element|null|undefined} anchor
       */
      function mountPodsRowToAnchor(anchor) {
        if (!podsRowContainerElement) return;
        if (anchor && anchor.isConnected) {
          if (preparedAnchorRef && preparedAnchorRef !== anchor) {
            try {
              preparedAnchorRef.classList.remove("zen-tidy-download-badge-anchor");
            } catch (_e) {
              /* ignore */
            }
          }
          prepareAnchorForBadges(anchor);
          preparedAnchorRef = anchor;
          if (podsRowContainerElement.parentNode !== anchor) {
            anchor.appendChild(podsRowContainerElement);
            debugLog("[DownloadUI] Pods row mounted on download anchor");
          }
          podsRowContainerElement.classList.add("zen-tidy-pods-badge-stack");
          return;
        }
        if (preparedAnchorRef) {
          try {
            preparedAnchorRef.classList.remove("zen-tidy-download-badge-anchor");
          } catch (_e) {
            /* ignore */
          }
          preparedAnchorRef = null;
        }
        if (downloadCardsContainer && podsRowContainerElement.parentNode !== downloadCardsContainer) {
          downloadCardsContainer.appendChild(podsRowContainerElement);
          debugLog("[DownloadUI] Pods row fallback: appended to download-cards container (no anchor)");
        }
        podsRowContainerElement.classList.remove("zen-tidy-pods-badge-stack");
      }

      async function remountPodsRowToAnchor() {
        if (typeof findDownloadsButton !== "function") return;
        try {
          const anchor = await findDownloadsButton();
          mountPodsRowToAnchor(anchor || null);
        } catch (e) {
          debugLog("[DownloadUI] remountPodsRowToAnchor failed:", e);
        }
      }

      function setupFootToolbarRemountObserver() {
        if (typeof findDownloadsButton !== "function") return;
        const foot = document.getElementById("zen-sidebar-foot-buttons");
        if (!foot) {
          debugLog("[DownloadUI] #zen-sidebar-foot-buttons not found; skipping foot toolbar observer");
          return;
        }
        let debounceId = 0;
        const schedule = () => {
          clearTimeout(debounceId);
          debounceId = setTimeout(() => {
            remountPodsRowToAnchor();
          }, 80);
        };
        try {
          footToolbarObserver = new MutationObserver(schedule);
          footToolbarObserver.observe(foot, { childList: true, subtree: true });
          window.addEventListener(
            "unload",
            () => {
              try {
                footToolbarObserver?.disconnect();
              } catch (_e) {
                /* ignore */
              }
              footToolbarObserver = null;
            },
            { once: true }
          );
          debugLog("[DownloadUI] Observing #zen-sidebar-foot-buttons for anchor remounts");
        } catch (e) {
          debugLog("[DownloadUI] Foot toolbar observer setup failed:", e);
        }
      }

      if (!downloadCardsContainer) {
        downloadCardsContainer = document.createElement("div");
        downloadCardsContainer.id = "userchrome-download-cards-container";
        downloadCardsContainer.style.display = "none";
        downloadCardsContainer.style.opacity = "0";
        downloadCardsContainer.style.visibility = "hidden";

        const mediaControlsToolbar = document.getElementById("zen-media-controls-toolbar");
        const zenMainAppWrapper = document.getElementById("zen-main-app-wrapper");
        let parentContainer = null;
        if (mediaControlsToolbar && mediaControlsToolbar.parentNode) {
          parentContainer = mediaControlsToolbar.parentNode;
          parentContainer.insertBefore(downloadCardsContainer, mediaControlsToolbar.nextSibling);
        } else if (zenMainAppWrapper) {
          parentContainer = zenMainAppWrapper;
          zenMainAppWrapper.appendChild(downloadCardsContainer);
        } else {
          parentContainer = document.body;
          document.body.appendChild(downloadCardsContainer);
        }

        if (parentContainer && parentContainer !== document.body) {
          const parentStyle = window.getComputedStyle(parentContainer);
          if (parentStyle.position === "static") {
            parentContainer.style.position = "relative";
          }
        }
        downloadCardsContainer.style.cssText =
          "box-sizing: border-box; display: none; opacity: 0; visibility: hidden;";
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

        podsRowContainerElement = document.createElement("div");
        podsRowContainerElement.id = "userchrome-pods-row-container";

        document.addEventListener("pile-shown", clearAllStickyPods);
        document.addEventListener("pile-hidden", onPileHiddenRepair);

        const masterCloseBtn = masterTooltipDOMElement.querySelector(".card-close-button");
        if (masterCloseBtn) {
          const masterCloseHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const focusedKey = getFocusedKey();
            if (!focusedKey) return;
            const cardData = getActiveCardByKey(focusedKey);
            if (masterTooltipDOMElement) {
              masterTooltipDOMElement.style.opacity = "0";
              masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
              masterTooltipDOMElement.style.pointerEvents = "none";
            }
            setTimeout(async () => {
              if (!cardData?.download) return;
              try {
                const download = cardData.download;
                if (download.succeeded) {
                  await cancelAIProcessForDownload(focusedKey);
                  removeCard(focusedKey, true);
                  return;
                }
                if (download.error || cardData.permanentlyDeleted) {
                  cardData.isManuallyCleaning = true;
                  await eraseDownloadFromHistory(download);
                  removeCard(focusedKey, true);
                  return;
                }
              } catch (_error) {
                removeCard(focusedKey, true);
              }
            }, 300);
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
            if (focusedKey) await undoRename(focusedKey);
          };
          masterUndoBtn.addEventListener("click", masterUndoHandler);
          masterUndoBtn.addEventListener("keydown", async (e) => {
            if (e.key === "Enter" || e.key === " ") await masterUndoHandler(e);
          });
        }
      } else {
        podsRowContainerElement = document.getElementById("userchrome-pods-row-container");
        masterTooltipDOMElement = downloadCardsContainer.querySelector(".master-tooltip");
      }

      await remountPodsRowToAnchor();
      setupFootToolbarRemountObserver();

      debugLog("Download UI shell initialized");

      return {
        getDownloadCardsContainer: () => downloadCardsContainer,
        getMasterTooltip: () => masterTooltipDOMElement,
        getPodsRow: () => podsRowContainerElement
      };
    }
  };
})();
