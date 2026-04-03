// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-pods.uc.js
// Pod DOM lifecycle: throttled create/update, preview, drag, focus, AI queue hooks
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsPods = {
    /**
     * @param {Object} ctx
     * @param {Object} ctx.store - zenTidyDownloadsStore.createStore()
     * @param {function} ctx.getPref
     * @param {function} ctx.debugLog
     * @param {function} ctx.getDownloadKey
     * @param {function} ctx.getSafeFilename
     * @param {Object} ctx.previewApi
     * @param {function} ctx.openDownloadedFile
     * @param {function} ctx.getContentTypeFromFilename
     * @param {Object} ctx.SecurityUtils
     * @param {typeof Components.classes} ctx.Cc
     * @param {typeof Components.interfaces} ctx.Ci
     * @param {function} ctx.getAddToAIRenameQueue - () => addToAIRenameQueue impl
     * @param {function} ctx.getAiRenamingPossible - () => aiRenamingPossible flag
     * @param {function} ctx.scheduleCardRemoval
     * @param {function} ctx.clearStickyPodsOnly
     * @param {function} ctx.updateDownloadCardsVisibility
     * @param {function} ctx.updateUIForFocusedDownload
     * @param {function} ctx.getPodsRowContainer - () => pods row element or null
     * @param {function} ctx.migrateAIRenameKeys - (oldKey, newKey) => void — keep AI queue aligned when card key changes
     * @returns {{ throttledCreateOrUpdateCard: function, createOrUpdatePodElement: function }}
     */
    init(ctx) {
      const {
        store,
        getPref,
        debugLog,
        getDownloadKey,
        getSafeFilename,
        previewApi,
        openDownloadedFile,
        getContentTypeFromFilename,
        SecurityUtils,
        Cc,
        Ci,
        getAddToAIRenameQueue,
        getAiRenamingPossible,
        scheduleCardRemoval,
        clearStickyPodsOnly,
        updateDownloadCardsVisibility,
        updateUIForFocusedDownload,
        getPodsRowContainer,
        migrateAIRenameKeys
      } = ctx;

      const {
        activeDownloadCards,
        cardUpdateThrottle,
        focusedKeyRef,
        orderedPodKeys,
        stickyPods,
        dismissedDownloads,
        dismissedPodsData,
        permanentlyDeletedPaths,
        permanentlyDeletedMeta,
        renamedFiles
      } = store;

      /**
       * Move an existing card to newKey when Firefox updates path/id so getDownloadKey(download) changes.
       * @param {string} oldKey
       * @param {string} newKey
       * @param {Object} cardData
       * @returns {boolean}
       */
      function rekeyActiveDownloadCardIfNeeded(oldKey, newKey, cardData) {
        if (!oldKey || !newKey || oldKey === newKey || !cardData) return false;
        const occupant = activeDownloadCards.get(newKey);
        if (occupant && occupant !== cardData) {
          debugLog("[Rekey] Skipped: target key already used by another card", { oldKey, newKey });
          return false;
        }

        activeDownloadCards.delete(oldKey);
        activeDownloadCards.set(newKey, cardData);
        cardData.key = newKey;

        if (cardData.podElement) {
          cardData.podElement.dataset.downloadKey = newKey;
          cardData.podElement.id = `download-pod-${newKey.replace(/[^a-zA-Z0-9_]/g, "-")}`;
        }

        const oldKeyIndex = orderedPodKeys.indexOf(oldKey);
        if (oldKeyIndex > -1) {
          orderedPodKeys.splice(oldKeyIndex, 1, newKey);
        } else {
          debugLog(`[Rekey] Old key not in orderedPodKeys: ${oldKey}`);
        }

        if (stickyPods.has(oldKey)) {
          stickyPods.delete(oldKey);
          stickyPods.add(newKey);
        }

        const throttledAt = cardUpdateThrottle.get(oldKey);
        if (throttledAt != null) {
          cardUpdateThrottle.delete(oldKey);
          cardUpdateThrottle.set(newKey, throttledAt);
        }

        if (focusedKeyRef.current === oldKey) {
          focusedKeyRef.current = newKey;
        }

        if (typeof migrateAIRenameKeys === "function") {
          migrateAIRenameKeys(oldKey, newKey);
        }

        debugLog(`[Rekey] Card key updated: ${oldKey} → ${newKey}`);
        return true;
      }

      function createOrUpdatePodElement(download, isNewCardOnInit = false) {
        let key = getDownloadKey(download);
        if (!key) {
          debugLog("Skipping download object without usable key", download);
          return null;
        }

        const normPath = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "");
        const pathNorm = download.target?.path ? normPath(download.target.path) : "";
        if (pathNorm && permanentlyDeletedPaths.has(pathNorm)) {
          const meta = permanentlyDeletedMeta.get(pathNorm);
          const deletedTimeMs = meta?.startTime || 0;
          const currentTimeMs = download.startTime ? new Date(download.startTime).getTime() : 0;

          if (!download.startTime || !meta || currentTimeMs <= deletedTimeMs) {
            debugLog("[CreatePod] Skipping permanently-deleted history entry", {
              key,
              pathNorm,
              deletedTimeMs,
              currentTimeMs,
              hasError: !!download.error
            });
            return null;
          }

          permanentlyDeletedPaths.delete(pathNorm);
          permanentlyDeletedMeta.delete(pathNorm);
          dismissedDownloads.delete(key);
          debugLog("[CreatePod] Allowing re-download for permanently deleted path", {
            key,
            pathNorm,
            deletedTimeMs,
            currentTimeMs
          });
        } else if (dismissedDownloads.has(key) && !activeDownloadCards.has(key)) {
          const dismissedData = dismissedPodsData.get(key);
          const dismissedTime = dismissedData?.startTime ? new Date(dismissedData.startTime).getTime() : 0;
          const currentTime = download.startTime ? new Date(download.startTime).getTime() : 0;
          const isNewerDownload =
            !dismissedData ||
            !dismissedData.startTime ||
            !download.startTime ||
            currentTime > dismissedTime;
          if (isNewerDownload) {
            dismissedDownloads.delete(key);
            debugLog(
              `[CreatePod] Allowing newer re-download to bypass dismissed check (dismissed: ${dismissedTime}, current: ${currentTime}): ${key}`
            );
          } else {
            debugLog(`[CreatePod] Skipping dismissed download that's not currently active: ${key}`);
            return null;
          }
        }

        debugLog("[PodFUNC] createOrUpdatePodElement called", {
          key,
          state: download.state,
          currentBytes: download.currentBytes,
          succeeded: download.succeeded,
          error: !!download.error,
          errorMessage: download.error?.message,
          canceled: download.canceled,
          hasTargetPath: !!download?.target?.path,
          hasId: !!download?.id,
          isNewCardOnInit
        });

        let cardData = activeDownloadCards.get(key);

        if (!cardData) {
          for (const [storedKey, cd] of activeDownloadCards) {
            const sameRef = cd.download === download;
            const sameId = download?.id != null && cd.download?.id === download.id;
            if (!sameRef && !sameId) {
              continue;
            }
            if (storedKey !== key) {
              const targetOccupied = activeDownloadCards.get(key);
              if (targetOccupied && targetOccupied !== cd) {
                debugLog("[Rekey] Keeping prior key; canonical path key held by another entry", {
                  storedKey,
                  key
                });
                key = storedKey;
              } else {
                rekeyActiveDownloadCardIfNeeded(storedKey, key, cd);
              }
            }
            cardData = cd;
            break;
          }
        }

        const safeFilename = getSafeFilename(download);

        let podElement;

        if (!cardData) {
          podElement = document.createElement("div");
          podElement.className = "download-pod";
          podElement.id = `download-pod-${key.replace(/[^a-zA-Z0-9_]/g, "-")}`;
          podElement.dataset.downloadKey = key;

          podElement.innerHTML = `
        <div class="card-preview-container">
          <!-- Preview content (image, text snippet, or icon) will go here -->
          </div>
        `;

          const previewContainer = podElement.querySelector(".card-preview-container");
          if (previewContainer) {
            previewApi.setGenericIcon(previewContainer, download.contentType || "application/octet-stream");
            previewContainer.title = "Click to open file";

            previewContainer.addEventListener("click", (e) => {
              e.stopPropagation();
              const currentCardData = activeDownloadCards.get(podElement.dataset.downloadKey);
              if (currentCardData && currentCardData.download) {
                openDownloadedFile(currentCardData.download);
              } else {
                debugLog("openDownloadedFile: Card data not found for pod, attempting with initial download object", {
                  key: podElement.dataset.downloadKey
                });
                openDownloadedFile(download);
              }
            });
          }

          podElement.setAttribute("draggable", "true");
          podElement.addEventListener("dragstart", async (e) => {
            if (!download.target?.path) {
              e.preventDefault();
              return;
            }

            try {
              const pathValidation = SecurityUtils.validateFilePath(download.target.path, { strict: false });
              if (!pathValidation.valid) {
                debugLog("[DragDrop] Path validation failed:", pathValidation.error);
                e.preventDefault();
                return;
              }

              const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
              file.initWithPath(download.target.path);

              if (!file.exists()) {
                e.preventDefault();
                return;
              }

              try {
                if (e.dataTransfer && typeof e.dataTransfer.mozSetDataAt === "function") {
                  e.dataTransfer.mozSetDataAt("application/x-moz-file", file, 0);
                }
              } catch (mozError) {
                debugLog("[DragDrop] mozSetDataAt failed, continuing with other formats:", mozError);
              }

              const fileUrl = file.path.startsWith("\\")
                ? "file:" + file.path.replace(/\\/g, "/")
                : "file:///" + file.path.replace(/\\/g, "/");

              if (fileUrl) {
                e.dataTransfer.setData("text/uri-list", fileUrl);
                e.dataTransfer.setData("text/plain", fileUrl);
              }

              if (download.source?.url) {
                const contentType = download.contentType || getContentTypeFromFilename(safeFilename);
                e.dataTransfer.setData("DownloadURL", `${contentType}:${safeFilename}:${download.source.url}`);
              }

              e.dataTransfer.setDragImage(podElement, 28, 28);
              debugLog("[DragDrop] Started drag for:", safeFilename);
            } catch (err) {
              debugLog("[DragDrop] Error during dragstart:", err);
              e.preventDefault();
            }
          });

          cardData = {
            podElement,
            download,
            complete: false,
            key,
            originalFilename: safeFilename,
            trueOriginalPathBeforeAIRename: null,
            trueOriginalSimpleNameBeforeAIRename: null,
            lastInteractionTime: Date.now(),
            isVisible: false,
            isWaitingForZenAnimation: false,
            domAppended: false,
            intendedTargetTransform: null,
            intendedTargetOpacity: null,
            isBeingRemoved: false,
            /** True until layout runs a one-shot entrance when download reaches succeeded (in-progress layout skips re-animation otherwise). */
            needsStickyEntranceReveal: false
          };
          activeDownloadCards.set(key, cardData);

          if (!orderedPodKeys.includes(key)) {
            if (stickyPods.size > 0) clearStickyPodsOnly();
            orderedPodKeys.push(key);

            if (orderedPodKeys.length === 1) {
              updateDownloadCardsVisibility();
            }

            const stableFocusMode = getPref("extensions.downloads.stable_focus_mode", true);
            const currentFocusedData = focusedKeyRef.current
              ? activeDownloadCards.get(focusedKeyRef.current)
              : null;
            const currentFocusedDownload = currentFocusedData?.download;

            if (!focusedKeyRef.current) {
              focusedKeyRef.current = key;
              debugLog(
                `[PodFUNC] New pod created, setting as focused (no current focus): ${key}. Total pods: ${orderedPodKeys.length}`
              );
            } else if (!stableFocusMode) {
              focusedKeyRef.current = key;
              debugLog(
                `[PodFUNC] New pod created, setting as focused (non-stable mode): ${key}. Total pods: ${orderedPodKeys.length}`
              );
            } else if (download.succeeded) {
              focusedKeyRef.current = key;
              debugLog(
                `[PodFUNC] New pod created, setting as focused (completed download): ${key}. Total pods: ${orderedPodKeys.length}`
              );
            } else if (currentFocusedDownload && (currentFocusedDownload.succeeded || currentFocusedDownload.error)) {
              focusedKeyRef.current = key;
              debugLog(
                `[PodFUNC] New pod created, setting as focused (current focus was finished): ${key}. Previous: ${focusedKeyRef.current}`
              );
            } else {
              debugLog(
                `[PodFUNC] New pod created but keeping current focus on: ${focusedKeyRef.current}. New pod: ${key} (stable focus mode - both in progress)`
              );
            }
          } else {
            debugLog(`[PodFUNC] Pod ${key} already exists in orderedPodKeys. Current focus: ${focusedKeyRef.current}`);
          }

          const podsRow = getPodsRowContainer();
          if (podsRow && !podElement.parentNode) {
            podsRow.appendChild(podElement);
            cardData.domAppended = true;
            debugLog(`[PodFUNC] New pod ${key} appended to DOM (completed download).`);
          }
        } else {
          podElement = cardData.podElement;
          cardData.download = download;
          cardData.lastInteractionTime = Date.now();
          if (safeFilename !== cardData.originalFilename && !download.aiName) {
            cardData.originalFilename = safeFilename;
          }
        }

        const previewElement = podElement.querySelector(".card-preview-container");
        if (previewElement) {
          if (download.succeeded) {
            debugLog(`[Preview] Setting completed file preview for: ${key}`);
            previewApi
              .setCompletedFilePreview(previewElement, download)
              .catch((e) => debugLog("Error setting completed file preview (async) for pod", { error: e, download }));
          } else if (download.error) {
            previewApi.setGenericIcon(previewElement, "application/octet-stream");
          }
        }

        if (download.succeeded && !cardData.complete) {
          cardData.needsStickyEntranceReveal = true;
          cardData.complete = true;
          cardData.userCanceled = false;
          podElement.classList.add("completed");
          debugLog(`[PodFUNC] Download marked as complete: ${key}`);

          const aiRenamingEnabled = getPref("extensions.downloads.enable_ai_renaming", true);
          const aiPossible = getAiRenamingPossible();
          debugLog(`[PodFUNC] Checking AI rename eligibility for ${key} (new pod):`, {
            aiRenamingEnabled,
            aiRenamingPossible: aiPossible,
            hasPath: !!download.target?.path,
            path: download.target?.path,
            alreadyRenamed: renamedFiles.has(download.target?.path)
          });

          if (
            aiRenamingEnabled &&
            aiPossible &&
            download.target?.path &&
            !renamedFiles.has(download.target.path)
          ) {
            setTimeout(() => {
              const currentCardData = activeDownloadCards.get(key);
              if (currentCardData && currentCardData.download) {
                debugLog(`[PodFUNC] Adding ${key} to AI rename queue after delay (new pod)`);
                getAddToAIRenameQueue()(key, currentCardData.download, currentCardData.originalFilename);
              } else {
                debugLog(`[PodFUNC] Cannot add ${key} to queue - cardData missing after delay (new pod)`);
              }
            }, 1000);
          } else {
            debugLog(`[PodFUNC] Not adding ${key} to AI rename queue - conditions not met (new pod)`);
          }

          scheduleCardRemoval(key);
        }
        if (download.error) {
          podElement.classList.add("error");
          scheduleCardRemoval(key);
        }

        return podElement;
      }

      function throttledCreateOrUpdateCard(download, isNewCardOnInit = false) {
        const key = getDownloadKey(download);
        const now = Date.now();
        const lastUpdate = cardUpdateThrottle.get(key) || 0;
        const throttleDelay = 200;
        /** Never drop the final transition (pie → sticky pod + tooltip); completion often fires <200ms after progress. */
        const isTerminalState =
          !!download &&
          (download.succeeded === true || !!download.error || !!download.canceled);

        if (now - lastUpdate < throttleDelay && !isNewCardOnInit && !isTerminalState) {
          debugLog(`[Throttle] Skipping throttled update for download: ${key} (delay: ${throttleDelay}ms)`);
          return;
        }

        cardUpdateThrottle.set(key, now);
        debugLog(
          `[Throttle] Calling createOrUpdatePodElement for key: ${key}, isNewOnInit: ${isNewCardOnInit}, error: ${!!download.error}, succeeded: ${!!download.succeeded}, canceled: ${!!download.canceled}`
        );
        const podElement = createOrUpdatePodElement(download, isNewCardOnInit);
        if (podElement) {
          debugLog(`[Throttle] Pod element created/updated for ${key}.`);
          const shouldRequestUIUpdate = isNewCardOnInit || key === focusedKeyRef.current;
          if (shouldRequestUIUpdate) {
            updateUIForFocusedDownload(focusedKeyRef.current || key, isNewCardOnInit || true);
          }
        } else {
          debugLog(`[Throttle] No pod element returned for ${key}. Download state:`, {
            succeeded: download.succeeded,
            error: !!download.error,
            canceled: download.canceled,
            hasKey: !!key
          });
        }
      }

      return {
        createOrUpdatePodElement,
        throttledCreateOrUpdateCard
      };
    }
  };
})();
