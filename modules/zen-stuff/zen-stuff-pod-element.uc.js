// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-pod-element.uc.js
// Dismissed-pod row DOM (preview, filename, drag, context menu hookup).
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffPodElement = {
    /**
     * @param {Object} d
     * @returns {{ createPodElement: function }}
     */
    createPodElementFactory(d) {
      const {
        formatBytes,
        readTextFilePreview,
        filenameEndsWithExtensionFromSet,
        TEXT_EXTENSIONS,
        SYSTEM_ICON_EXTENSIONS,
        getZenStuffFilePreviewEnabled,
        debugLog,
        FileSystem,
        setPileContextMenuActive,
        openPodFile,
        showPodFileInExplorer,
        ensurePodContextMenu,
        getPodContextMenu,
        setPodContextMenuPodData
      } = d;

      function getFileIcon(contentType) {
        if (!contentType) return "📄";
        if (contentType.includes("image/")) return "🖼️";
        if (contentType.includes("video/")) return "🎬";
        if (contentType.includes("audio/")) return "🎵";
        if (contentType.includes("text/")) return "📝";
        if (contentType.includes("application/pdf")) return "📕";
        if (contentType.includes("application/zip") || contentType.includes("application/x-rar")) return "🗜️";
        if (contentType.includes("application/")) return "📦";
        return "📄";
      }

      function createPodElement(podData) {
        const row = document.createElement("div");
        row.className = "dismissed-pod-row";
        row.dataset.podKey = podData.key;
        row.title = `${podData.filename}\nClick: Open file\nMiddle-click: Show in file explorer\nRight-click: Context menu`;

        row.style.cssText = `
      position: absolute;
      width: 100%;
      height: 48px;
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 10px;
      padding: 0 8px;
      box-sizing: border-box;
      cursor: pointer;
      transition: opacity 0.1s ease, background-color 0.1s ease, transform 0.1s ease;
      will-change: transform, opacity;
      left: 0;
      right: 0;
      border-radius: 6px;
    `;

        row.addEventListener("mouseenter", () => {
          row.style.backgroundColor = "rgba(255, 255, 255, 0.08)";
        });

        row.addEventListener("mouseleave", () => {
          row.style.backgroundColor = "transparent";
        });

        const pod = document.createElement("div");
        pod.className = "dismissed-pod";
        pod.style.cssText = `
      width: 36px;
      height: 36px;
      min-width: 36px;
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
    `;

        const preview = document.createElement("div");
        preview.className = "dismissed-pod-preview";
        preview.style.cssText = `
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: white;
      font-size: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    `;

        const isTextFile = (filename, contentType) =>
          !!(contentType && contentType.startsWith("text/")) ||
          filenameEndsWithExtensionFromSet(filename, TEXT_EXTENSIONS);

        const isSystemIconFile = (filename, contentType) => {
          if (
            contentType &&
            (contentType.startsWith("video/") ||
              contentType.startsWith("audio/") ||
              contentType.includes("pdf"))
          ) {
            return true;
          }
          return filenameEndsWithExtensionFromSet(filename, SYSTEM_ICON_EXTENSIONS);
        };

        const renderPreview = async () => {
          if (podData.previewData && podData.previewData.type === "image" && podData.previewData.src) {
            const img = document.createElement("img");
            img.src = podData.previewData.src;
            img.style.cssText = `
              width: 100%;
              height: 100%;
              object-fit: cover;
            `;
            img.onerror = () => {
              const icon = getFileIcon(podData.contentType);
              renderIcon(icon);
            };
            preview.appendChild(img);
            return;
          }

          if (podData.targetPath && isTextFile(podData.filename, podData.contentType)) {
            if (getZenStuffFilePreviewEnabled()) {
              const textContent = await readTextFilePreview(podData.targetPath);
              if (textContent) {
                preview.innerHTML = "";
                const textDiv = document.createElement("div");
                textDiv.style.cssText = `
                          width: 100%;
                          height: 100%;
                          padding: 4px;
                          box-sizing: border-box;
                          font-family: monospace;
                          font-size: 5px; 
                          line-height: 1.1;
                          overflow: hidden;
                          white-space: pre-wrap;
                          color: rgba(255,255,255,0.8);
                          background: rgba(0,0,0,0.2);
                          text-align: left;
                          word-break: break-all;
                      `;
                textDiv.textContent = textContent;
                preview.appendChild(textDiv);
                return;
              }
            }
            const fileUrl = "file:///" + podData.targetPath.replace(/\\/g, "/");
            const iconUrl = `moz-icon://${fileUrl}?size=32`;
            const img = document.createElement("img");
            img.src = iconUrl;
            img.style.cssText = `width: 100%; height: 100%; object-fit: cover;`;
            img.onerror = () => {
              const icon = getFileIcon(podData.contentType);
              renderIcon(icon);
            };
            preview.innerHTML = "";
            preview.appendChild(img);
            return;
          }

          if (podData.targetPath && isSystemIconFile(podData.filename, podData.contentType)) {
            const fileUrl = "file:///" + podData.targetPath.replace(/\\/g, "/");
            const iconUrl = `moz-icon://${fileUrl}?size=32`;

            const img = document.createElement("img");
            img.src = iconUrl;
            img.style.cssText = `
              width: 100%;
              height: 100%;
              object-fit: cover;
            `;

            img.onerror = () => {
              const icon = getFileIcon(podData.contentType);
              renderIcon(icon);
            };

            preview.innerHTML = "";
            preview.appendChild(img);
            return;
          }

          const icon = getFileIcon(podData.contentType);
          renderIcon(icon);
        };

        const renderIcon = (iconChar) => {
          const iconSpan = document.createElement("span");
          iconSpan.style.fontSize = "24px";
          iconSpan.textContent = iconChar;
          preview.innerHTML = "";
          preview.appendChild(iconSpan);
        };

        renderPreview();

        pod.appendChild(preview);
        row.appendChild(pod);

        const textContainer = document.createElement("div");
        textContainer.className = "dismissed-pod-text";
        textContainer.style.cssText = `
      display: flex;
      flex-direction: column;
      justify-content: center;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      height: 100%;
    `;

        const filename = document.createElement("div");
        filename.className = "dismissed-pod-filename";

        let displayFilename = podData.filename || "Untitled";
        if (podData.targetPath) {
          try {
            const pathSeparator = podData.targetPath.includes("\\") ? "\\" : "/";
            const actualFilename = podData.targetPath.split(pathSeparator).pop();
            if (actualFilename && actualFilename !== displayFilename) {
              displayFilename = actualFilename;
            }
          } catch (_e) {}
        }

        filename.textContent = displayFilename;
        filename.style.cssText = `
      font-size: 12px;
      font-weight: 500;
      color: var(--zen-text-color, #e0e0e0);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
      cursor: pointer;
      user-select: text;
    `;

        const fileSize = document.createElement("div");
        fileSize.className = "dismissed-pod-filesize";
        const sizeBytes = podData.fileSize || 0;
        fileSize.textContent = formatBytes(sizeBytes);
        fileSize.style.cssText = `
      font-size: 10px;
      color: var(--zen-text-color-deemphasized, #a0a0a0);
      white-space: nowrap;
    `;

        textContainer.appendChild(filename);
        textContainer.appendChild(fileSize);
        row.appendChild(textContainer);

        row.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          debugLog(`Attempting to open file: ${podData.key}`);
          openPodFile(podData);
        });

        row.addEventListener("mousedown", (e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            debugLog(`Attempting to show file in explorer: ${podData.key}`);
            showPodFileInExplorer(podData);
          }
        });

        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          setPileContextMenuActive(true);
          ensurePodContextMenu();
          setPodContextMenuPodData(podData);
          const podContextMenu = getPodContextMenu();
          if (!podContextMenu) return;
          if (typeof podContextMenu.openPopupAtScreen === "function") {
            podContextMenu.openPopupAtScreen(e.screenX, e.screenY, true);
          } else {
            podContextMenu.openPopup(row, "after_start", 0, 0, true, false, e);
          }
        });

        row.setAttribute("draggable", "true");
        row.addEventListener("dragstart", async (e) => {
          if (!podData.targetPath) {
            e.preventDefault();
            return;
          }

          const img = pod.querySelector("img");
          if (img && !img.complete) {
            e.preventDefault();
            debugLog("[DragDrop] Image not loaded, preventing drag for:", podData.filename);
            return;
          }

          try {
            const file = await FileSystem.createFileInstance(podData.targetPath);
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

            const fileUrl =
              file && file.path
                ? file.path.startsWith("\\")
                  ? "file:" + file.path.replace(/\\/g, "/")
                  : "file:///" + file.path.replace(/\\/g, "/")
                : "";
            if (fileUrl) {
              e.dataTransfer.setData("text/uri-list", fileUrl);
              e.dataTransfer.setData("text/plain", fileUrl);
            }

            if (podData.sourceUrl) {
              e.dataTransfer.setData(
                "DownloadURL",
                `${podData.contentType || "application/octet-stream"}:${podData.filename}:${podData.sourceUrl}`
              );
            }

            pod.offsetWidth;
            e.dataTransfer.setDragImage(pod, 22, 22);
          } catch (err) {
            debugLog("[DragDrop] Error during dragstart:", err);
            e.preventDefault();
          }
        });

        return row;
      }

      return { createPodElement };
    }
  };
})();
