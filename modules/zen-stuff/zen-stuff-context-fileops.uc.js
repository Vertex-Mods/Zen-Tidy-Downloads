// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-context-fileops.uc.js
// Dismissed-pile context menu (XUL) + open/rename/delete/clipboard + Firefox list helpers.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffContextFileOps = {
    /**
     * @param {Object} ctx
     * @param {Object} ctx.state
     * @param {Object} ctx.CONFIG
     * @param {function} ctx.debugLog
     * @param {typeof FileSystem} ctx.FileSystem
     * @param {typeof ErrorHandler} ctx.ErrorHandler
     * @param {function} ctx.validatePodData
     * @param {function} ctx.removePodFromPile
     * @param {function} ctx.generateGridPosition
     * @param {function} ctx.applyGridPosition
     * @param {function} ctx.hidePile
     * @param {function} ctx.showPile
     * @param {function} ctx.getAlwaysShowPile
     * @param {function} ctx.shouldDisableHover
     * @param {function} ctx.isHoveringPileArea
     * @param {function} ctx.saveDismissedPodToSession
     * @param {function} ctx.schedulePileLayoutRepair
     * @param {function} ctx.updatePileVisibility
     * @param {function} ctx.updateDownloadsButtonVisibility
     * @returns {{ ensurePodContextMenu: function, hideContextMenu: function, getPodContextMenu: function, setPodContextMenuPodData: function, isContextMenuVisible: function, openPodFile: function, showPodFileInExplorer: function, startInlineRename: function, renamePodFile: function, copyPodFileToClipboard: function, deletePodFile: function, removeDownloadFromFirefoxList: function, clearAllDownloads: function, showUserNotification: function, isValidFilename: function, clearGlobalMenuRef: function }}
     */
    createContextFileOpsApi(ctx) {
      const {
        state,
        CONFIG,
        debugLog,
        FileSystem,
        ErrorHandler,
        validatePodData,
        removePodFromPile,
        generateGridPosition,
        applyGridPosition,
        hidePile,
        showPile,
        getAlwaysShowPile,
        shouldDisableHover,
        isHoveringPileArea,
        saveDismissedPodToSession,
        schedulePileLayoutRepair,
        updatePileVisibility,
        updateDownloadsButtonVisibility
      } = ctx;

      const podContextMenuFragment = window.MozXULElement.parseXULToFragment(`
    <menupopup id="zen-pile-pod-context-menu">
      <menuitem id="zenPilePodOpen" label="Open"/>
      <menuitem id="zenPilePodRename" label="Rename"/>
      <menuitem id="zenPilePodCopy" label="Copy to Clipboard"/>
      <menuseparator/>
      <menuitem id="zenPilePodRemove" label="Remove from Stuff"/>
      <menuitem id="zenPilePodDelete" label="Delete"/>
    </menupopup>
  `);
      let podContextMenu = null;
      let podContextMenuPodData = null;

      function showUserNotification(message, _type = "error") {
        alert(message);
      }

      function isValidFilename(name) {
        return (
          typeof name === "string" &&
          name.trim().length > 0 &&
          !/[\\/:*?"<>|]/.test(name)
        );
      }

      async function removeDownloadFromFirefoxList(podData, resolvedDownload = null) {
        try {
          debugLog(`[DeleteDownload] Attempting to remove download from Firefox list: ${podData.filename}`);

          if (
            window.zenTidyDownloads &&
            typeof window.zenTidyDownloads.removeDownloadFromListForPodData === "function"
          ) {
            const ok = await window.zenTidyDownloads.removeDownloadFromListForPodData(
              podData,
              resolvedDownload
            );
            if (ok) {
              return true;
            }
            debugLog(`[DeleteDownload] API matcher did not remove; falling back to legacy path/URL scan`);
          }

          const list = await window.Downloads.getList(window.Downloads.ALL);
          const downloads = await list.getAll();

          let targetDownload = null;

          for (const download of downloads) {
            if (podData.targetPath && download.target?.path === podData.targetPath) {
              targetDownload = download;
              debugLog(`[DeleteDownload] Found download by target path: ${download.target.path}`);
              break;
            }

            if (podData.sourceUrl && download.source?.url === podData.sourceUrl) {
              const downloadFilename = download.target?.path
                ? download.target.path.split(/[/\\]/).pop()
                : null;

              if (
                !downloadFilename ||
                downloadFilename === podData.filename ||
                downloadFilename === podData.originalFilename
              ) {
                targetDownload = download;
                debugLog(`[DeleteDownload] Found download by source URL: ${download.source.url}`);
                break;
              }
            }
          }

          if (targetDownload) {
            await list.remove(targetDownload);
            debugLog(`[DeleteDownload] Successfully removed download from Firefox list: ${podData.filename}`);
            return true;
          }
          debugLog(`[DeleteDownload] Download not found in Firefox list: ${podData.filename}`);
          return false;
        } catch (error) {
          debugLog(`[DeleteDownload] Error removing download from Firefox list:`, error);
          throw error;
        }
      }

      async function clearAllDownloads() {
        try {
          debugLog("[ClearAll] Starting to clear all downloads from Firefox");

          const list = await window.Downloads.getList(window.Downloads.ALL);
          const downloads = await list.getAll();

          debugLog(`[ClearAll] Found ${downloads.length} downloads to clear`);

          for (const download of downloads) {
            try {
              await list.remove(download);
              debugLog(`[ClearAll] Removed download: ${download.target?.path || download.source?.url}`);
            } catch (error) {
              debugLog(`[ClearAll] Error removing individual download:`, error);
            }
          }

          state.dismissedPods.clear();
          updatePileVisibility();
          updateDownloadsButtonVisibility();

          debugLog("[ClearAll] Successfully cleared all downloads and pile");
        } catch (error) {
          debugLog("[ClearAll] Error clearing downloads:", error);
          throw error;
        }
      }

      async function openPodFile(podData) {
        debugLog(`Attempting to open file: ${podData.key}`);

        try {
          validatePodData(podData);

          if (!podData.targetPath) {
            throw new Error("No file path available");
          }

          const fileExists = await FileSystem.fileExists(podData.targetPath);
          if (fileExists) {
            const file = await FileSystem.createFileInstance(podData.targetPath);
            file.launch();
            debugLog(`Successfully opened file: ${podData.filename}`);
          } else {
            const parentDir = await FileSystem.getParentDirectory(podData.targetPath);
            if (parentDir && parentDir.exists()) {
              parentDir.launch();
              debugLog(`File not found, opened containing folder: ${podData.filename}`);
            } else {
              throw new Error("File and folder not found");
            }
          }
        } catch (error) {
          ErrorHandler.handleError(error, "openPodFile");
          debugLog(`Error opening file: ${podData.filename}`, error);
        }
      }

      async function showPodFileInExplorer(podData) {
        debugLog(`Attempting to show file in file explorer: ${podData.key}`);

        try {
          validatePodData(podData);

          if (!podData.targetPath) {
            throw new Error("No file path available");
          }

          const fileExists = await FileSystem.fileExists(podData.targetPath);
          if (fileExists) {
            const file = await FileSystem.createFileInstance(podData.targetPath);

            try {
              file.reveal();
              debugLog(`Successfully showed file in explorer: ${podData.filename}`);
            } catch (revealError) {
              debugLog(`Reveal failed, trying to open containing folder: ${revealError}`);
              const parentDir = await FileSystem.getParentDirectory(podData.targetPath);
              if (parentDir && parentDir.exists()) {
                parentDir.launch();
                debugLog(`Opened containing folder: ${podData.filename}`);
              } else {
                throw new Error("Containing folder not found");
              }
            }
          } else {
            const parentDir = await FileSystem.getParentDirectory(podData.targetPath);
            if (parentDir && parentDir.exists()) {
              parentDir.launch();
              debugLog(`File not found, opened containing folder: ${podData.filename}`);
            } else {
              throw new Error("File and folder not found");
            }
          }
        } catch (error) {
          ErrorHandler.handleError(error, "showPodFileInExplorer");
          debugLog(`Error showing file in explorer: ${podData.filename}`, error);
        }
      }

      async function renamePodFile(podData, newFilename) {
        try {
          validatePodData(podData);
          if (!newFilename || typeof newFilename !== "string") {
            throw new Error("Invalid new filename");
          }
          if (!podData.targetPath) {
            throw new Error("No file path available for renaming");
          }
          const newPath = await FileSystem.renameFile(podData.targetPath, newFilename);
          const oldFilename = podData.filename;
          const newName = newPath.split(/[/\\]/).pop();
          podData.filename = newName;
          podData.targetPath = newPath;
          state.setPodData(podData.key, podData);
          saveDismissedPodToSession(podData);
          const podElement = state.getPodElement(podData.key);
          if (podElement) {
            podElement.title = `${newName}\nClick: Open file\nMiddle-click: Show in file explorer\nRight-click: Context menu`;

            const filenameElement = podElement.querySelector(".dismissed-pod-filename");
            if (filenameElement) {
              filenameElement.textContent = newName;
              debugLog(`[Rename] Updated displayed filename in DOM: ${newName}`);
            }
          }
          if (window.zenTidyDownloads && window.zenTidyDownloads.dismissedPods) {
            try {
              const mainScriptPod = window.zenTidyDownloads.dismissedPods.get(podData.key);
              if (mainScriptPod) {
                mainScriptPod.filename = newName;
                mainScriptPod.targetPath = newPath;
                window.zenTidyDownloads.dismissedPods.set(podData.key, mainScriptPod);
                debugLog(`[Rename] Updated main script pod data`);
              }
            } catch (error) {
              debugLog(`[Rename] Could not update main script pod data:`, error);
            }
          }
          try {
            const list = await window.Downloads.getList(window.Downloads.ALL);
            const downloads = await list.getAll();
            const targetDownload = downloads.find(
              (download) =>
                download.target?.path === podData.targetPath.replace(newName, oldFilename) ||
                (download.source?.url === podData.sourceUrl &&
                  download.target?.path?.endsWith(oldFilename))
            );
            if (targetDownload && targetDownload.target) {
              targetDownload.target.path = newPath;
              debugLog(`[Rename] Updated Firefox download record`);
            }
          } catch (error) {
            debugLog(`[Rename] Could not update Firefox download record:`, error);
          }
          debugLog(`[Rename] Successfully renamed file: ${oldFilename} -> ${newName}`);
        } catch (error) {
          showUserNotification(`Error renaming file: ${error.message}`);
          throw error;
        }
      }

      function startInlineRename(podData) {
        const podElement = state.getPodElement(podData.key);
        if (!podElement) {
          debugLog(`[Rename] Cannot start inline rename - pod element not found: ${podData.key}`);
          return;
        }

        const filenameElement = podElement.querySelector(".dismissed-pod-filename");
        if (!filenameElement) {
          debugLog(`[Rename] Cannot start inline rename - filename element not found`);
          return;
        }

        if (state.isEditing) {
          debugLog(`[Rename] Already editing a filename`);
          return;
        }

        state.isEditing = true;

        if (state.dynamicSizer && state.dismissedPods.size > 0) {
          showPile();
        }

        const originalText = filenameElement.textContent;
        const input = document.createElement("input");
        input.type = "text";
        input.value = originalText;
        input.style.cssText = `
      width: 100%;
      padding: 0;
      border: none;
      border-radius: 0;
      background: transparent;
      color: var(--zen-text-color, #e0e0e0);
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      margin-bottom: 2px;
      box-sizing: border-box;
      outline: none;
    `;

        const lastDotIndex = originalText.lastIndexOf(".");
        if (lastDotIndex > 0) {
          input.setSelectionRange(0, lastDotIndex);
        } else {
          input.select();
        }

        const parent = filenameElement.parentNode;
        parent.replaceChild(input, filenameElement);
        input.focus();

        const finishEditing = async (save = false) => {
          if (!state.isEditing) return;
          state.isEditing = false;

          const newName = input.value.trim();
          if (save && newName && newName !== originalText) {
            try {
              debugLog(`[Rename] Inline rename: ${originalText} -> ${newName}`);
              await renamePodFile(podData, newName);
            } catch (error) {
              debugLog(`[Rename] Error renaming file:`, error);
              showUserNotification(`Error renaming file: ${error.message}`);
              input.value = originalText;
            }
          }

          filenameElement.textContent = podData.filename || originalText;
          parent.replaceChild(filenameElement, input);

          if (!getAlwaysShowPile() && !shouldDisableHover()) {
            setTimeout(() => {
              const isHoveringDownloadArea = state.downloadButton?.matches(":hover");
              const isHoveringPile = isHoveringPileArea();

              if (!isHoveringDownloadArea && !isHoveringPile) {
                debugLog("[Rename] Editing finished, hiding pile (not hovering)");
                clearTimeout(state.hoverTimeout);
                state.hoverTimeout = setTimeout(() => {
                  hidePile();
                }, CONFIG.hoverDebounceMs);
              }
            }, 50);
          }
        };

        input.addEventListener("blur", () => finishEditing(true));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            finishEditing(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finishEditing(false);
          }
        });
      }

      async function copyPodFileToClipboard(podData) {
        debugLog(`[Clipboard] Attempting to copy file to clipboard: ${podData.filename}`);
        try {
          validatePodData(podData);
          if (!podData.targetPath) {
            throw new Error("No file path available");
          }
          const fileExists = await FileSystem.fileExists(podData.targetPath);
          if (!fileExists) {
            throw new Error("File does not exist");
          }
          const file = await FileSystem.createFileInstance(podData.targetPath);
          const transferable = Components.classes["@mozilla.org/widget/transferable;1"].createInstance(
            Components.interfaces.nsITransferable
          );
          transferable.init(null);
          transferable.addDataFlavor("application/x-moz-file");
          transferable.setTransferData("application/x-moz-file", file);
          const clipboard = Components.classes["@mozilla.org/widget/clipboard;1"].getService(
            Components.interfaces.nsIClipboard
          );
          clipboard.setData(transferable, null, Components.interfaces.nsIClipboard.kGlobalClipboard);
          debugLog(`[Clipboard] File copied to clipboard: ${podData.filename}`);
        } catch (error) {
          ErrorHandler.handleError(error, "copyPodFileToClipboard");
          throw error;
        }
      }

      async function deletePodFile(podData) {
        debugLog(`[DeleteFile] Attempting to delete file from system: ${podData.filename}`);
        try {
          validatePodData(podData);

          const confirmed = Services.prompt.confirm(
            window,
            "Delete File",
            `Are you sure you want to permanently delete "${podData.filename}"?\n\nThis action cannot be undone.`
          );

          if (!confirmed) {
            debugLog(`[DeleteFile] User cancelled deletion`);
            return;
          }

          let resolvedDownload = null;
          if (
            window.zenTidyDownloads &&
            typeof window.zenTidyDownloads.resolveDownloadFromPodData === "function"
          ) {
            try {
              resolvedDownload = await window.zenTidyDownloads.resolveDownloadFromPodData(podData);
            } catch (resolveErr) {
              debugLog(`[DeleteFile] resolveDownloadFromPodData failed:`, resolveErr);
            }
          }

          const pathCandidates = [];
          if (resolvedDownload?.target?.path) {
            pathCandidates.push(resolvedDownload.target.path);
          }
          if (podData.targetPath) {
            pathCandidates.push(podData.targetPath);
          }
          const uniquePaths = [...new Set(pathCandidates.filter(Boolean))];

          let pathToDelete = null;
          for (const p of uniquePaths) {
            if (await FileSystem.fileExists(p)) {
              pathToDelete = p;
              break;
            }
          }

          if (!pathToDelete) {
            debugLog(
              `[DeleteFile] No file at Firefox-reported or saved path; clearing pile and downloads entry only: ${podData.filename}`
            );
            try {
              await removeDownloadFromFirefoxList(podData, resolvedDownload);
            } catch (error) {
              debugLog(`[DeleteFile] Could not remove from Firefox downloads list:`, error);
            }
            removePodFromPile(podData.key);
            if (window.zenTidyDownloads && window.zenTidyDownloads.dismissedPods) {
              try {
                window.zenTidyDownloads.dismissedPods.delete(podData.key);
              } catch (error) {
                debugLog(`[DeleteFile] Could not remove from main script dismissed pods:`, error);
              }
            }
            return;
          }

          const deleted = await FileSystem.deleteFile(pathToDelete);
          if (!deleted) {
            throw new Error("File deletion failed");
          }

          debugLog(`[DeleteFile] Successfully deleted file at ${pathToDelete}: ${podData.filename}`);

          try {
            await removeDownloadFromFirefoxList(podData, resolvedDownload);
          } catch (error) {
            debugLog(`[DeleteFile] Could not remove from Firefox downloads list:`, error);
          }

          removePodFromPile(podData.key);

          if (window.zenTidyDownloads && window.zenTidyDownloads.dismissedPods) {
            try {
              window.zenTidyDownloads.dismissedPods.delete(podData.key);
              debugLog(`[DeleteFile] Removed from main script dismissed pods`);
            } catch (error) {
              debugLog(`[DeleteFile] Could not remove from main script dismissed pods:`, error);
            }
          }
        } catch (error) {
          ErrorHandler.handleError(error, "deletePodFile");
          throw error;
        }
      }

      function ensurePodContextMenu() {
        if (!podContextMenu) {
          const frag = podContextMenuFragment.cloneNode(true);
          podContextMenu = frag.firstElementChild;
          document.getElementById("mainPopupSet")?.appendChild(podContextMenu) ||
            document.body.appendChild(podContextMenu);

          window.zenPileContextMenu = { contextMenu: podContextMenu };

          podContextMenu.querySelector("#zenPilePodOpen").addEventListener("command", () => {
            if (podContextMenuPodData) openPodFile(podContextMenuPodData);
          });
          podContextMenu.querySelector("#zenPilePodRename").addEventListener("command", () => {
            if (podContextMenuPodData) {
              startInlineRename(podContextMenuPodData);
            }
          });
          podContextMenu.querySelector("#zenPilePodRemove").addEventListener("command", async () => {
            if (podContextMenuPodData) {
              const confirmed = Services.prompt.confirm(
                window,
                "Remove from Stuff",
                `Are you sure you want to remove "${podContextMenuPodData.filename}" from Stuff?\n\nThis will remove it from the pile but won't delete the file.`
              );
              if (!confirmed) {
                return;
              }

              try {
                if (window.zenTidyDownloads?.permanentDelete) {
                  window.zenTidyDownloads.permanentDelete(podContextMenuPodData.key);
                }
                removePodFromPile(podContextMenuPodData.key);
                const allPods = Array.from(state.dismissedPods.keys()).reverse();
                const MAX_PODS_TO_SHOW = 10;
                if (allPods.length < MAX_PODS_TO_SHOW) {
                  state.carouselStartIndex = 0;
                  state.visibleGridOrder = allPods.slice();
                } else {
                  if (state.carouselStartIndex >= allPods.length) {
                    state.carouselStartIndex = 0;
                  }
                  state.visibleGridOrder = [];
                  for (let i = 0; i < MAX_PODS_TO_SHOW; i++) {
                    const podIndex = state.carouselStartIndex + i;
                    if (podIndex < allPods.length) {
                      state.visibleGridOrder.push(allPods[podIndex]);
                    }
                  }
                }
                state.dismissedPods.forEach((_, podKey) => {
                  generateGridPosition(podKey);
                  applyGridPosition(podKey, 0);
                });
                state.dismissedPods.forEach((_, podKey) => {
                  if (!state.visibleGridOrder.includes(podKey)) {
                    const el = state.podElements.get(podKey);
                    if (el) el.style.display = "none";
                  }
                });
              } catch (err) {
                showUserNotification(`Error removing pod: ${err.message}`);
              }
            }
          });

          podContextMenu.addEventListener("popuphidden", () => {
            state.pileContextMenuActive = false;
            setTimeout(() => {
              const isHoveringPile = isHoveringPileArea();
              const isHoveringDownloadArea = state.downloadButton?.matches(":hover");

              if (!isHoveringPile && !isHoveringDownloadArea) {
                if (!getAlwaysShowPile()) {
                  if (state.pendingPileClose) {
                    debugLog("[ContextMenu] popuphidden: pendingPileClose was set, closing pile now");
                    hidePile();
                    state.pendingPileClose = false;
                  } else {
                    hidePile();
                  }
                }
              } else {
                state.pendingPileClose = false;
              }
              schedulePileLayoutRepair("contextmenu-popuphidden", 150);
            }, 100);
          });

          podContextMenu.querySelector("#zenPilePodCopy").addEventListener("command", async () => {
            if (podContextMenuPodData) {
              try {
                await copyPodFileToClipboard(podContextMenuPodData);
              } catch (err) {
                showUserNotification(`Error copying file to clipboard: ${err.message}`);
              }
            }
          });

          podContextMenu.querySelector("#zenPilePodDelete").addEventListener("command", async () => {
            if (podContextMenuPodData) {
              try {
                await deletePodFile(podContextMenuPodData);
              } catch (err) {
                showUserNotification(`Error deleting file: ${err.message}`);
              }
            }
          });
        }
      }

      function hideContextMenu() {
        try {
          if (podContextMenu && typeof podContextMenu.hidePopup === "function") {
            podContextMenu.hidePopup();
          }
        } catch (_e) {}
      }

      function getPodContextMenu() {
        return podContextMenu;
      }

      function setPodContextMenuPodData(d) {
        podContextMenuPodData = d;
      }

      function isContextMenuVisible() {
        if (state.pileContextMenuActive) return true;
        const menu = document.getElementById("zen-pile-pod-context-menu");
        return Boolean(menu && typeof menu.state === "string" && menu.state === "open");
      }

      function clearGlobalMenuRef() {
        window.zenPileContextMenu = null;
      }

      return {
        ensurePodContextMenu,
        hideContextMenu,
        getPodContextMenu,
        setPodContextMenuPodData,
        isContextMenuVisible,
        openPodFile,
        showPodFileInExplorer,
        startInlineRename,
        renamePodFile,
        copyPodFileToClipboard,
        deletePodFile,
        removeDownloadFromFirefoxList,
        clearAllDownloads,
        showUserNotification,
        isValidFilename,
        clearGlobalMenuRef
      };
    }
  };
})();
