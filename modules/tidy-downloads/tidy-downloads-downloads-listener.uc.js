// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-downloads-listener.uc.js
// Owns DownloadsAdapter listener registration + startup recent-download scan.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsDownloadsListener = {
    /**
     * @param {Object} ctx
     * @param {Object} ctx.store
     * @param {Object} ctx.DownloadsAdapter
     * @param {function} ctx.debugLog
     * @param {function} ctx.getDownloadKey
     * @param {function} ctx.getPref
     * @param {function} ctx.cancelAIProcessForDownload
     * @param {function} ctx.removeCard
     * @param {function} ctx.fireCustomEvent
     * @param {function(): function} ctx.getThrottledCreateOrUpdateCard
     * @param {function(): ({getDownloadViewListener: function}|null)} ctx.getLibraryPieController
     * @returns {{ start: function }}
     */
    createController(ctx) {
      const {
        store,
        DownloadsAdapter,
        debugLog,
        getDownloadKey,
        getPref,
        cancelAIProcessForDownload,
        removeCard,
        fireCustomEvent,
        getThrottledCreateOrUpdateCard,
        getLibraryPieController
      } = ctx;

      const {
        activeDownloadCards,
        dismissedDownloads,
        actualDownloadRemovedEventListeners
      } = store;

      function start() {
        const downloadListener = DownloadsAdapter.createDownloadViewListener({
          onCompletedState: (dl) => getThrottledCreateOrUpdateCard()(dl),
          onRemoved: async (dl) => {
            const key = getDownloadKey(dl);
            await cancelAIProcessForDownload(key);

            const cardData = activeDownloadCards.get(key);
            if (cardData?.isManuallyCleaning) return;

            await removeCard(key, false);
            actualDownloadRemovedEventListeners.forEach((callback) => {
              try {
                callback(key);
              } catch (error) {
                debugLog("[API Event] Error in actualDownloadRemoved callback:", error);
              }
            });
            fireCustomEvent("actual-download-removed", { podKey: key });
          }
        });

        DownloadsAdapter.getAllDownloadsList()
          .then((list) => {
            if (!list) return;
            list.addView(downloadListener);

            const libraryPieController = getLibraryPieController();
            if (libraryPieController?.getDownloadViewListener) {
              list.addView(libraryPieController.getDownloadViewListener());
            }

            list.getAll().then((all) => {
              const recentDownloads = DownloadsAdapter.filterInitialCompletedDownloads(all, {
                getDownloadKey,
                getPref,
                dismissedDownloads,
                activeDownloadCards,
                debugLog
              });
              recentDownloads.forEach((dl) => getThrottledCreateOrUpdateCard()(dl, true));
            });
          })
          .catch((e) => console.error("DL Preview Mistral AI: List error:", e));
      }

      return { start };
    }
  };
})();
