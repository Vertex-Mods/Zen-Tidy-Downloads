// ==UserScript==
// @include   main
// @loadOrder 99999999999998
// @ignorecache
// ==/UserScript==

// tidy-downloads-store.uc.js
// Mutable application state for Zen Tidy Downloads (maps, sets, refs, UI throttle prefs)
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsStore = {
    /**
     * Create a fresh state bag for one browser window / script run.
     * @param {{ getPref?: function }} options
     * @returns {ZenTidyDownloadsStore}
     */
    createStore(options = {}) {
      const { getPref } = options;
      let minUi = 150;
      let filePreviewEnabled = false;
      try {
        if (typeof getPref === "function") {
          minUi = getPref("extensions.downloads.ui_update_min_interval_ms", 150);
          filePreviewEnabled = getPref("extensions.downloads.enable_file_preview", false);
        }
      } catch (e) {
        // keep defaults
      }

      return {
        activeDownloadCards: new Map(),
        renamedFiles: new Set(),
        cardUpdateThrottle: new Map(),
        /** @type {number} */
        lastUIUpdateTime: 0,
        MIN_UI_UPDATE_INTERVAL_MS: minUi,
        filePreviewEnabled,
        sidebarWidthRef: { value: "" },
        focusedKeyRef: { current: null },
        orderedPodKeys: [],
        lastRotationDirection: null,
        dismissedDownloads: new Set(),
        stickyPods: new Set(),
        permanentlyDeletedPaths: new Set(),
        permanentlyDeletedMeta: new Map(),
        MAX_PERMANENTLY_DELETED_PATHS: 50,
        actualDownloadRemovedEventListeners: new Set(),
        dismissedPodsData: new Map(),
        dismissEventListeners: new Set()
      };
    }
  };
})();
