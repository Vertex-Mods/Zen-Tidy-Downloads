// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-public-api.uc.js
// window.zenTidyDownloads surface for zen-stuff and other integrations (registries + pile helpers)
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsPublicApi = {
    /**
     * Build the global integration object. Registries live on `store`; this module only exposes methods.
     *
     * @param {Object} deps
     * @param {Object} deps.store - createStore() result (dismiss listeners, dismissedPodsData, maps, caps, …)
     * @param {function} deps.debugLog
     * @param {Object} deps.SecurityUtils
     * @param {Object} deps.DownloadsAdapter
     * @param {function} deps.getDownloadKey
     * @param {function} deps.getThrottledCreateOrUpdateCard
     * @param {function} deps.fireCustomEvent
     * @param {typeof Components.classes} deps.Cc
     * @param {typeof Components.interfaces} deps.Ci
     * @returns {Object} window.zenTidyDownloads
     */
    createPublicApi(deps) {
      const {
        store,
        debugLog,
        SecurityUtils,
        DownloadsAdapter,
        getDownloadKey,
        getThrottledCreateOrUpdateCard,
        fireCustomEvent,
        Cc,
        Ci
      } = deps;

      const {
        dismissEventListeners,
        actualDownloadRemovedEventListeners,
        dismissedPodsData,
        dismissedDownloads,
        permanentlyDeletedPaths,
        permanentlyDeletedMeta,
        MAX_PERMANENTLY_DELETED_PATHS,
        activeDownloadCards,
        stickyPods
      } = store;

      /**
       * @param {string} [p]
       * @returns {string}
       */
      function normPath(p) {
        return typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "";
      }

      /**
       * Match a pile snapshot to the current Firefox Downloads list (source of truth at action time).
       * @param {unknown[]} downloads
       * @param {Object} podData
       * @param {string} [podKey] - optional key when podData.key missing
       * @returns {unknown|null}
       */
      function findDownloadMatchingPodData(downloads, podData, podKey) {
        const key = podKey || podData?.key;
        if (!podData || !Array.isArray(downloads)) {
          return null;
        }

        if (podData.downloadId != null && podData.downloadId !== "") {
          const byId = downloads.find(
            (dl) => dl.id != null && String(dl.id) === String(podData.downloadId)
          );
          if (byId) {
            return byId;
          }
        }

        if (key) {
          const byKey = downloads.find((dl) => getDownloadKey(dl) === key);
          if (byKey) {
            return byKey;
          }
        }

        const snap = normPath(podData.targetPath);
        if (snap) {
          const byPath = downloads.find((dl) => normPath(dl.target?.path) === snap);
          if (byPath) {
            return byPath;
          }
        }

        if (key && (key.includes("/") || key.includes("\\"))) {
          const nk = normPath(key);
          const byKeyPath = downloads.find((dl) => normPath(dl.target?.path) === nk);
          if (byKeyPath) {
            return byKeyPath;
          }
        }

        if (podData.sourceUrl && podData.startTime) {
          const t0 = new Date(podData.startTime).getTime();
          const byUrlTime = downloads.find((dl) => {
            if (!dl.source?.url || dl.source.url !== podData.sourceUrl) {
              return false;
            }
            if (!dl.startTime) {
              return false;
            }
            return Math.abs(new Date(dl.startTime).getTime() - t0) < 5000;
          });
          if (byUrlTime) {
            return byUrlTime;
          }
        }

        if (podData.sourceUrl) {
          const fn = podData.filename || podData.originalFilename;
          const byUrlFn = downloads.find((dl) => {
            if (dl.source?.url !== podData.sourceUrl) {
              return false;
            }
            const p = dl.target?.path;
            if (!p || !fn) {
              return false;
            }
            const base = p.split(/[/\\]/).pop();
            return base === fn || base === podData.originalFilename;
          });
          if (byUrlFn) {
            return byUrlFn;
          }
        }

        return null;
      }

      return {
        onPodDismissed(callback) {
          if (typeof callback === "function") {
            dismissEventListeners.add(callback);
            debugLog("[API] Registered pod dismiss listener");
          }
        },

        offPodDismissed(callback) {
          dismissEventListeners.delete(callback);
          debugLog("[API] Unregistered pod dismiss listener");
        },

        dismissedPods: {
          getAll: () => new Map(dismissedPodsData),
          get: (key) => dismissedPodsData.get(key),
          count: () => dismissedPodsData.size,
          clear: () => {
            dismissedPodsData.clear();
            debugLog("[API] Cleared all dismissed pods data");
          }
        },

        get activeDownloadCards() {
          return activeDownloadCards;
        },

        get stickyPods() {
          return stickyPods;
        },

        onActualDownloadRemoved(callback) {
          if (typeof callback === "function") {
            actualDownloadRemovedEventListeners.add(callback);
            debugLog("[API] Registered actual download removed listener");
          }
        },

        offActualDownloadRemoved(callback) {
          actualDownloadRemovedEventListeners.delete(callback);
          debugLog("[API] Unregistered actual download removed listener");
        },

        async restorePod(podKey) {
          debugLog(`[API] Restore pod requested: ${podKey}`);
          const dismissedData = dismissedPodsData.get(podKey);
          if (!dismissedData) {
            debugLog(`[API] Cannot restore pod - no dismissed data found: ${podKey}`);
            return false;
          }

          try {
            dismissedDownloads.delete(podKey);
            dismissedPodsData.delete(podKey);

            const list = await DownloadsAdapter.getAllDownloadsList();
            if (!list) {
              debugLog(`[API] Downloads list unavailable for restoration: ${podKey}`);
              return false;
            }
            const downloads = await list.getAll();
            const download = downloads.find((dl) => getDownloadKey(dl) === podKey);

            if (download) {
              debugLog(`[API] Found download for restoration: ${podKey}`);
              getThrottledCreateOrUpdateCard()(download, true);
              fireCustomEvent("pod-restored-from-pile", { podKey, download });
              return true;
            }
            debugLog(`[API] Download no longer exists in Firefox for restoration: ${podKey}`);
            return false;
          } catch (error) {
            debugLog(`[API] Error restoring pod ${podKey}:`, error);
            return false;
          }
        },

        permanentDelete(podKey) {
          debugLog(`[API] Permanent delete requested: ${podKey}`);
          const podData = dismissedPodsData.get(podKey);
          const wasPresent = dismissedPodsData.delete(podKey);

          const normalizePath = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "");
          dismissedDownloads.delete(podKey);
          const pathsToAllow = new Set();
          if (podData?.targetPath) {
            pathsToAllow.add(normalizePath(podData.targetPath));
          }
          if (podKey && !podKey.startsWith("temp_") && (podKey.includes("/") || podKey.includes("\\"))) {
            pathsToAllow.add(normalizePath(podKey));
          }
          for (const norm of pathsToAllow) {
            if (!norm) continue;
            try {
              const deletedTime = podData?.startTime ? new Date(podData.startTime).getTime() : Date.now();
              permanentlyDeletedMeta.set(norm, { startTime: deletedTime });
            } catch (e) {
              debugLog("[PermanentDelete] Failed to record deletion time meta", { error: e, norm });
            }
            for (const dk of [...dismissedDownloads]) {
              if (normalizePath(dk) === norm) dismissedDownloads.delete(dk);
            }
            permanentlyDeletedPaths.add(norm);
            if (permanentlyDeletedPaths.size > MAX_PERMANENTLY_DELETED_PATHS) {
              const first = permanentlyDeletedPaths.values().next().value;
              if (first) permanentlyDeletedPaths.delete(first);
            }
            if (permanentlyDeletedMeta.size > MAX_PERMANENTLY_DELETED_PATHS) {
              const firstMeta = permanentlyDeletedMeta.keys().next().value;
              if (firstMeta) permanentlyDeletedMeta.delete(firstMeta);
            }
          }

          if (wasPresent) {
            fireCustomEvent("pod-permanently-deleted", { podKey });
          }

          return wasPresent;
        },

        /**
         * @param {Object} podData
         * @returns {Promise<boolean>}
         */
        async addExternalFile(podData) {
          debugLog(`[API] Add external file requested: ${podData?.filename}`);

          try {
            if (!podData || typeof podData !== "object") {
              throw new Error("Invalid pod data: must be an object");
            }

            const requiredFields = ["key", "filename", "targetPath"];
            const missingFields = requiredFields.filter((field) => !podData[field]);
            if (missingFields.length > 0) {
              throw new Error(`Invalid pod data: missing required fields: ${missingFields.join(", ")}`);
            }

            if (typeof podData.key !== "string" || podData.key.length === 0) {
              throw new Error("Invalid pod data: key must be a non-empty string");
            }
            if (typeof podData.filename !== "string" || podData.filename.length === 0) {
              throw new Error("Invalid pod data: filename must be a non-empty string");
            }
            if (typeof podData.targetPath !== "string" || podData.targetPath.length === 0) {
              throw new Error("Invalid pod data: targetPath must be a non-empty string");
            }

            const pathValidation = SecurityUtils.validateFilePath(podData.targetPath, { strict: true });
            if (!pathValidation.valid) {
              throw new Error(`Invalid file path: ${pathValidation.error} (code: ${pathValidation.code})`);
            }

            const allowedDirs = ["Downloads", "Desktop", "Documents", "Pictures", "Videos", "Music"];
            const pathLower = podData.targetPath.toLowerCase();
            const isInAllowedDir = allowedDirs.some((dir) => pathLower.includes(dir.toLowerCase()));
            if (!isInAllowedDir) {
              debugLog(`[API] Warning: File path is outside common directories: ${podData.targetPath}`);
            }

            const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            file.initWithPath(podData.targetPath);

            if (!file.exists()) {
              throw new Error("File does not exist at the specified path");
            }
            if (file.isDirectory()) {
              throw new Error("Path points to a directory, not a file");
            }

            if (!podData.fileSize || podData.fileSize <= 0) {
              podData.fileSize = file.fileSize;
            }

            const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
            if (podData.fileSize > MAX_FILE_SIZE) {
              throw new Error(`File size exceeds maximum allowed: ${podData.fileSize} bytes`);
            }

            dismissedPodsData.set(podData.key, podData);

            dismissEventListeners.forEach((callback) => {
              try {
                callback(podData);
              } catch (error) {
                debugLog(`[API] Error in dismiss event listener:`, error);
              }
            });

            fireCustomEvent("external-file-added-to-stuff", { podData });

            debugLog(`[API] Successfully added external file: ${podData.filename}`);
            return true;
          } catch (error) {
            const errorInfo = {
              error: error.message || error.toString(),
              name: error.name || "Error",
              filename: podData?.filename,
              path: podData?.targetPath
            };
            debugLog(`[API] Error adding external file:`, errorInfo);
            throw error;
          }
        },

        /**
         * Resolve the live Download object from Firefox's list using id, path key, paths, and URL heuristics.
         * @param {Object} podData - pile / dismissed snapshot
         * @returns {Promise<unknown|null>}
         */
        async resolveDownloadFromPodData(podData) {
          try {
            const list = await DownloadsAdapter.getAllDownloadsList();
            if (!list) {
              debugLog("[API] resolveDownloadFromPodData: Downloads list unavailable");
              return null;
            }
            const downloads = await list.getAll();
            const found = findDownloadMatchingPodData(downloads, podData, podData?.key);
            if (found) {
              debugLog("[API] resolveDownloadFromPodData: matched download", {
                id: found.id,
                path: found.target?.path
              });
            } else {
              debugLog("[API] resolveDownloadFromPodData: no match", {
                key: podData?.key,
                downloadId: podData?.downloadId
              });
            }
            return found || null;
          } catch (error) {
            debugLog("[API] resolveDownloadFromPodData error:", error);
            return null;
          }
        },

        /**
         * Remove the download that corresponds to pile snapshot data from Firefox's history (Downloads API).
         * @param {Object} podData
         * @param {unknown} [resolvedDownload] - optional result of resolveDownloadFromPodData to avoid a second scan
         * @returns {Promise<boolean>}
         */
        async removeDownloadFromListForPodData(podData, resolvedDownload = null) {
          try {
            const list = await DownloadsAdapter.getAllDownloadsList();
            if (!list) {
              return false;
            }
            const target =
              resolvedDownload ||
              findDownloadMatchingPodData(await list.getAll(), podData, podData?.key);
            if (!target) {
              debugLog("[API] removeDownloadFromListForPodData: no matching download");
              return false;
            }
            await list.remove(target);
            debugLog("[API] removeDownloadFromListForPodData: removed", {
              id: target.id,
              path: target.target?.path
            });
            return true;
          } catch (error) {
            debugLog("[API] removeDownloadFromListForPodData error:", error);
            return false;
          }
        }
      };
    }
  };
})();
