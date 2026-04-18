// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-downloads-listener.uc.js
// Single Downloads view registrar. Delegates every add/change/remove event
// to the pod-lifecycle dispatcher (tidy-downloads-card-lifecycle.apply), and
// runs the startup recent-download scan directly against the pods renderer
// (bypassing the progress phase since those downloads already completed).
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
     * @param {function(dl: unknown, removed: boolean): unknown} ctx.applyDownloadEvent - lifecycle.apply bound to the current lifecycle api
     * @param {function(): function} ctx.getThrottledCreateOrUpdateCard - () => pods renderer for startup batch only
     * @returns {{ start: function, stop: function }}
     */
    createController(ctx) {
      const {
        store,
        DownloadsAdapter,
        debugLog,
        getDownloadKey,
        getPref,
        applyDownloadEvent,
        getThrottledCreateOrUpdateCard
      } = ctx;

      const {
        activeDownloadCards,
        dismissedDownloads
      } = store;

      /** @type {Object|null} */
      let registeredView = null;
      /** @type {Object|null} */
      let registeredList = null;

      function start() {
        const unifiedView = {
          onDownloadAdded: (dl) => {
            const p = applyDownloadEvent(dl, false);
            if (p && typeof p.catch === "function") {
              p.catch((e) => debugLog("[DownloadsListener] applyDownloadEvent(add) error", e));
            }
          },
          onDownloadChanged: (dl) => {
            const p = applyDownloadEvent(dl, false);
            if (p && typeof p.catch === "function") {
              p.catch((e) => debugLog("[DownloadsListener] applyDownloadEvent(change) error", e));
            }
          },
          onDownloadRemoved: (dl) => {
            const p = applyDownloadEvent(dl, true);
            if (p && typeof p.catch === "function") {
              p.catch((e) => debugLog("[DownloadsListener] applyDownloadEvent(remove) error", e));
            }
          }
        };

        DownloadsAdapter.getAllDownloadsList()
          .then((list) => {
            if (!list) return;
            list.addView(unifiedView);
            registeredView = unifiedView;
            registeredList = list;

            list.getAll().then((all) => {
              const recentDownloads = DownloadsAdapter.filterInitialCompletedDownloads(all, {
                getDownloadKey,
                getPref,
                dismissedDownloads,
                activeDownloadCards,
                debugLog
              });
              const throttledUpdate = getThrottledCreateOrUpdateCard();
              if (typeof throttledUpdate === "function") {
                recentDownloads.forEach((dl) => throttledUpdate(dl, true));
              }
            });
          })
          .catch((e) => console.error("DL Preview Mistral AI: List error:", e));
      }

      /**
       * Unregister the unified view from Firefox's Downloads list. Safe to
       * call if start() never registered (no-op) or has already been stopped.
       */
      function stop() {
        if (registeredList && registeredView) {
          try {
            const result = registeredList.removeView(registeredView);
            if (result && typeof result.catch === "function") {
              result.catch((e) => debugLog("[DownloadsListener] removeView rejection", e));
            }
          } catch (e) {
            debugLog("[DownloadsListener] removeView error", e);
          }
        }
        registeredList = null;
        registeredView = null;
      }

      return { start, stop };
    }
  };
})();
