// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-session.uc.js
// Session persistence helpers for dismissed pile pods.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffSession = {
    /**
     * @param {Object} deps
     * @returns {{ initSessionStore: function, saveDismissedPodToSession: function, removeDismissedPodFromSession: function, restoreDismissedPodsFromSession: function, updatePodKeysInSession: function }}
     */
    createSessionApi(deps) {
      const {
        debugLog,
        validateFilePathOrThrow,
        FileSystem,
        state,
        createPodElement,
        generateGridPosition,
        applyGridPosition,
        updatePileVisibility,
        updateDownloadsButtonVisibility,
        getAlwaysShowPile,
        shouldPileBeVisible,
        showPile
      } = deps;

      async function initSessionStore() {
        if (!window.SessionStore) {
          console.warn("[Dismissed Pile] SessionStore not available, retrying...");
          await new Promise((resolve) => setTimeout(resolve, 200));
          return initSessionStore();
        }
        try {
          if (window.SessionStore.promiseInitialized) {
            await window.SessionStore.promiseInitialized;
          }
          debugLog("[SessionStore] SessionStore initialized and ready");
        } catch (error) {
          console.error("[Dismissed Pile] Error initializing SessionStore:", error);
        }
      }

      function saveDismissedPodToSession(podData) {
        try {
          if (!window.SessionStore) return;
          const serializedData = {
            key: podData.key,
            filename: podData.filename,
            originalFilename: podData.originalFilename,
            fileSize: podData.fileSize,
            contentType: podData.contentType,
            targetPath: podData.targetPath,
            downloadId: podData.downloadId,
            sourceUrl: podData.sourceUrl,
            startTime: podData.startTime,
            endTime: podData.endTime,
            dismissTime: podData.dismissTime,
            wasRenamed: podData.wasRenamed,
            previewData: podData.previewData,
            dominantColor: podData.dominantColor
          };
          SessionStore.setCustomWindowValue(window, `zen-stuff-pod-${podData.key}`, JSON.stringify(serializedData));
        } catch (error) {
          console.error("[Dismissed Pile] Error saving pod to SessionStore:", error);
        }
      }

      function removeDismissedPodFromSession(podKey) {
        try {
          if (!window.SessionStore) return;
          SessionStore.deleteCustomWindowValue(window, `zen-stuff-pod-${podKey}`);
        } catch (error) {
          console.error("[Dismissed Pile] Error removing pod from SessionStore:", error);
        }
      }

      function updatePodKeysInSession() {
        try {
          if (!window.SessionStore) return;
          const podKeys = Array.from(state.dismissedPods.keys());
          SessionStore.setCustomWindowValue(window, "zen-stuff-pod-keys", JSON.stringify(podKeys));
        } catch (error) {
          console.error("[Dismissed Pile] Error updating pod keys in SessionStore:", error);
        }
      }

      async function restoreDismissedPodsFromSession() {
        try {
          if (!window.SessionStore) return;
          const podKeysJson = SessionStore.getCustomWindowValue(window, "zen-stuff-pod-keys");
          if (!podKeysJson) return;

          let podKeys;
          try {
            podKeys = JSON.parse(podKeysJson);
          } catch (_error) {
            return;
          }
          if (!Array.isArray(podKeys)) return;

          let restoredCount = 0;
          const restorationPromises = [];
          for (const podKey of podKeys) {
            restorationPromises.push(
              (async () => {
                try {
                  const podDataJson = SessionStore.getCustomWindowValue(window, `zen-stuff-pod-${podKey}`);
                  if (!podDataJson) return;
                  let podData;
                  try {
                    podData = JSON.parse(podDataJson);
                  } catch (_error) {
                    return;
                  }
                  if (!podData || typeof podData !== "object") return;
                  const requiredFields = ["key", "filename", "targetPath"];
                  if (requiredFields.some((field) => !podData[field])) return;
                  try {
                    validateFilePathOrThrow(podData.targetPath);
                  } catch (_error) {
                    return;
                  }

                  let actualPath = podData.targetPath;
                  let exists = await FileSystem.fileExists(actualPath);
                  if (!exists && podData.filename) {
                    try {
                      const parentDir = await FileSystem.getParentDirectory(podData.targetPath);
                      if (parentDir && parentDir.exists()) {
                        const newFile = parentDir.clone();
                        newFile.append(podData.filename);
                        if (newFile.exists()) {
                          actualPath = newFile.path;
                          exists = true;
                          podData.targetPath = actualPath;
                          saveDismissedPodToSession(podData);
                        }
                      }
                    } catch (_error) {}
                  }

                  if (!exists) {
                    removeDismissedPodFromSession(podKey);
                    return;
                  }

                  const hasImageContentType =
                    podData.contentType &&
                    podData.contentType !== "null" &&
                    podData.contentType.startsWith("image/");
                  const hasImageExtension =
                    podData.filename && /\.(jpg|jpeg|png|gif|bmp|webp|svg|ico)$/i.test(podData.filename);
                  if (hasImageContentType || hasImageExtension) {
                    try {
                      const file = await FileSystem.createFileInstance(actualPath);
                      let fileUrl = "";
                      if (Services.io && Services.io.newFileURI) {
                        fileUrl = Services.io.newFileURI(file).spec;
                      }
                      if (!fileUrl) {
                        const path = actualPath.replace(/\\/g, "/");
                        fileUrl = `file:///${path.startsWith("/") ? path.substring(1) : path}`;
                      }
                      podData.previewData = { type: "image", src: fileUrl };
                    } catch (_error) {
                      podData.previewData = null;
                    }
                  }

                  state.dismissedPods.set(podData.key, podData);
                  const podElement = createPodElement(podData);
                  state.podElements.set(podData.key, podElement);
                  state.pileContainer.appendChild(podElement);
                  generateGridPosition(podData.key);
                  applyGridPosition(podData.key, 0);
                  restoredCount++;
                } catch (_error) {}
              })()
            );
          }

          await Promise.all(restorationPromises);
          if (restoredCount > 0) {
            updatePodKeysInSession();
            updatePileVisibility();
            updateDownloadsButtonVisibility();
            if (getAlwaysShowPile() && shouldPileBeVisible()) {
              setTimeout(() => showPile(), 100);
            }
          }
          debugLog(`[SessionStore] Restored ${restoredCount} pods from session`);
        } catch (error) {
          console.error("[Dismissed Pile] Error restoring pods from SessionStore:", error);
        }
      }

      return {
        initSessionStore,
        saveDismissedPodToSession,
        removeDismissedPodFromSession,
        restoreDismissedPodsFromSession,
        updatePodKeysInSession
      };
    }
  };
})();
