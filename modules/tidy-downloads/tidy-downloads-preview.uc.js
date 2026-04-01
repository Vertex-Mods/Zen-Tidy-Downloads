// ==UserScript==
// @include   main
// @ignorecache
// ==/UserScript==

// tidy-downloads-preview.uc.js
// File preview, icons, and color extraction - receives context from tidy-downloads.uc.js
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsPreview = {
    /**
     * Initialize preview module. Called by tidy-downloads.uc.js with context.
     * @param {Object} ctx - Context from main script
     * @param {Set} ctx.IMAGE_EXTENSIONS - Image file extensions
     * @param {function} ctx.debugLog - debugLog
     * @param {function} ctx.getPref - getPref
     * @param {{ current: string|null }} ctx.focusedKeyRef - focused download key ref
     * @returns {{ setGenericIcon, setCompletedFilePreview, updatePodGlowColor, renderSystemIcon, renderSystemIconByExtension }}
     */
    init(ctx) {
      const { IMAGE_EXTENSIONS, debugLog, getPref, focusedKeyRef } = ctx;

      const UtilsRef = window.zenTidyDownloadsUtils;
      const TEXT_EXTS = UtilsRef?.TEXT_EXTENSIONS ?? new Set();
      const SYSTEM_ICON_EXTS = UtilsRef?.SYSTEM_ICON_EXTENSIONS ?? new Set();
      const readTextFilePreviewFromUtils = (path) =>
        (UtilsRef?.readTextFilePreview ? UtilsRef.readTextFilePreview(path, UtilsRef.DEFAULT_TEXT_PREVIEW_MAX_BYTES) : Promise.resolve(null));

      const filePreviewEnabled = typeof getPref === "function"
        ? getPref("extensions.downloads.enable_file_preview", false)
        : false;

      function setGenericIcon(previewElement, contentType) {
        if (!previewElement) return;
        try {
          let icon = "📄";
          if (typeof contentType === "string") {
            if (contentType.includes("image/")) icon = "🖼️";
            else if (contentType.includes("video/")) icon = "🎬";
            else if (contentType.includes("audio/")) icon = "🎵";
            else if (contentType.includes("text/")) icon = "📝";
            else if (contentType.includes("application/pdf")) icon = "📕";
            else if (contentType.includes("application/zip") || contentType.includes("application/x-rar")) icon = "🗜️";
            else if (contentType.includes("application/")) icon = "📦";
          }
          previewElement.innerHTML = `<span style="font-size: 24px;">${icon}</span>`;
          previewElement.style.display = "flex";
          previewElement.style.alignItems = "center";
          previewElement.style.justifyContent = "center";
        } catch (e) {
          debugLog("Error setting generic icon:", e);
          previewElement.innerHTML = `<span style="font-size: 24px;">📄</span>`;
        }
      }

      function rgbToHsl(r, g, b) {
        r /= 255;
        g /= 255;
        b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max === min) {
          h = s = 0;
        } else {
          const d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
          }
          h /= 6;
        }
        return [h, s, l];
      }

      function hslToRgb(h, s, l) {
        let r, g, b;
        if (s === 0) {
          r = g = b = l;
        } else {
          const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
          };
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p = 2 * l - q;
          r = hue2rgb(p, q, h + 1 / 3);
          g = hue2rgb(p, q, h);
          b = hue2rgb(p, q, h - 1 / 3);
        }
        return [r * 255, g * 255, b * 255];
      }

      function enhanceColorForGlow(r, g, b) {
        const [h, s, l] = rgbToHsl(r, g, b);
        const newS = Math.min(1, s + 0.3);
        const newL = Math.max(0.4, Math.min(0.7, l + 0.2));
        const [newR, newG, newB] = hslToRgb(h, newS, newL);
        return `rgb(${Math.round(newR)}, ${Math.round(newG)}, ${Math.round(newB)})`;
      }

      function extractDominantColor(imgElement) {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = 50;
          canvas.height = 50;
          ctx.drawImage(imgElement, 0, 0, 50, 50);
          const imageData = ctx.getImageData(0, 0, 50, 50);
          const data = imageData.data;
          const colorMap = {};
          for (let i = 0; i < data.length; i += 16) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            if (a < 128 || (r + g + b) < 50 || (r + g + b) > 650) continue;
            const rGroup = Math.floor(r / 32) * 32;
            const gGroup = Math.floor(g / 32) * 32;
            const bGroup = Math.floor(b / 32) * 32;
            const colorKey = `${rGroup},${gGroup},${bGroup}`;
            colorMap[colorKey] = (colorMap[colorKey] || 0) + 1;
          }
          let dominantColor = null;
          let maxCount = 0;
          for (const [color, count] of Object.entries(colorMap)) {
            if (count > maxCount) {
              maxCount = count;
              dominantColor = color;
            }
          }
          if (dominantColor) {
            const [r, g, b] = dominantColor.split(',').map(Number);
            const enhancedColor = enhanceColorForGlow(r, g, b);
            debugLog("[ColorExtraction] Extracted dominant color", {
              original: `rgb(${r}, ${g}, ${b})`,
              enhanced: enhancedColor,
              frequency: maxCount
            });
            return enhancedColor;
          }
          return null;
        } catch (e) {
          debugLog("[ColorExtraction] Error extracting color:", e);
          return null;
        }
      }

      function renderIconImg(container, iconUrl, onError) {
        const img = document.createElement("img");
        img.src = iconUrl;
        img.style.width = "25px";
        img.style.height = "25px";
        img.style.objectFit = "contain";
        img.onerror = () => {
          debugLog("[renderIconImg] Failed to load icon, falling back to generic", { url: iconUrl });
          onError();
        };
        img.onload = () => {
          if (img.naturalWidth === 0 || img.naturalHeight === 0) onError();
        };
        container.innerHTML = "";
        container.style.display = "flex";
        container.style.alignItems = "center";
        container.style.justifyContent = "center";
        container.style.background = "transparent";
        container.appendChild(img);
      }

      function renderSystemIcon(container, filePath) {
        const fileUrl = "file:///" + filePath.replace(/\\/g, "/");
        const iconUrl = `moz-icon://${fileUrl}?size=25`;
        const onPathFail = () => {
          const ext = filePath && filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")) : "";
          renderSystemIconByExtension(container, ext || "");
        };
        renderIconImg(container, iconUrl, onPathFail);
      }

      function renderSystemIconByExtension(container, ext) {
        const extSafe = ext && ext.startsWith(".") ? ext : "." + (ext || "txt");
        const iconUrl = `moz-icon://${extSafe}?size=25`;
        renderIconImg(container, iconUrl, () => setGenericIcon(container, null));
      }

      function updatePodGlowColor(podElement, color) {
        if (!podElement) return;
        try {
          const subtleGreyShadow = '0 2px 8px rgba(60,60,60,0.18), 0 3px 10px rgba(0,0,0,0.10)';
          podElement.style.boxShadow = subtleGreyShadow;
          debugLog('[GlowUpdate] Applied subtle grey shadow under pod', {
            podKey: podElement.dataset.downloadKey,
            shadow: subtleGreyShadow
          });
        } catch (e) {
          debugLog('[GlowUpdate] Error updating pod shadow:', e);
          podElement.style.boxShadow = '0 2px 8px rgba(60,60,60,0.18)';
        }
      }

      async function setCompletedFilePreview(previewElement, download) {
        if (!previewElement) {
          debugLog("[setCompletedFilePreview] No preview element provided");
          return;
        }

        debugLog("[setCompletedFilePreview] Called", {
          contentType: download?.contentType,
          targetPath: download?.target?.path,
          filename: download?.filename
        });

        try {
          if (!download.target?.path) {
            setGenericIcon(previewElement, null);
            return;
          }

          const filePath = download.target.path;
          const lowerPath = filePath.toLowerCase();
          const isImageContentType = download?.contentType?.startsWith("image/");
          let isImageExtension = false;
          for (const ext of IMAGE_EXTENSIONS) {
            if (lowerPath.endsWith(ext)) {
              isImageExtension = true;
              break;
            }
          }

          if (isImageContentType || isImageExtension) {
            debugLog("[setCompletedFilePreview] Rendering Image Preview");
            const podElement = previewElement.closest('.download-pod');
            if (podElement) podElement.classList.add("is-image-pod");

            const img = document.createElement("img");
            img.src = `file:///${filePath.replace(/\\/g, '/')}`;
            img.style.cssText = "width:100%;height:100%;object-fit:cover;transition:all 0.3s ease;opacity:0";

            img.onload = () => {
              img.style.opacity = "1";
              setTimeout(() => {
                const dominantColor = extractDominantColor(img);
                if (dominantColor) {
                  const pod = previewElement.closest('.download-pod');
                  if (pod) {
                    pod.dataset.dominantColor = dominantColor;
                    const downloadKey = pod.dataset.downloadKey;
                    if (downloadKey === focusedKeyRef.current) {
                      updatePodGlowColor(pod, dominantColor);
                    }
                  }
                }
              }, 100);
            };
            img.onerror = () => renderSystemIcon(previewElement, filePath);

            previewElement.innerHTML = "";
            previewElement.appendChild(img);
            return;
          }

          const nonImagePodElement = previewElement.closest('.download-pod');
          if (nonImagePodElement) nonImagePodElement.classList.remove("is-image-pod");

          let isTextExtension = false;
          for (const ext of TEXT_EXTS) {
            if (lowerPath.endsWith(ext)) {
              isTextExtension = true;
              break;
            }
          }

          if (isTextExtension || download?.contentType?.startsWith("text/")) {
            if (filePreviewEnabled) {
              debugLog("[setCompletedFilePreview] Rendering Text Preview");
              const textContent = await readTextFilePreviewFromUtils(filePath);
              if (textContent) {
                previewElement.innerHTML = "";
                const textDiv = document.createElement("div");
                textDiv.style.cssText = "width:100%;height:100%;padding:6px;box-sizing:border-box;font-family:monospace;font-size:6px;line-height:1.2;overflow:hidden;white-space:pre-wrap;color:rgba(255,255,255,0.8);background:transparent;text-align:left;word-break:break-all";
                textDiv.textContent = textContent;
                previewElement.appendChild(textDiv);
                return;
              }
            }
            debugLog("[setCompletedFilePreview] Text file, no preview - using System Icon (extension-based)");
            const ext = lowerPath.includes(".") ? lowerPath.slice(lowerPath.lastIndexOf(".")) : ".txt";
            renderSystemIconByExtension(previewElement, ext);
            return;
          }

          let isSystemIconType = false;
          for (const ext of SYSTEM_ICON_EXTS) {
            if (lowerPath.endsWith(ext)) {
              isSystemIconType = true;
              break;
            }
          }

          if (isSystemIconType || download?.contentType?.startsWith("video/") || download?.contentType?.startsWith("application/pdf")) {
            debugLog("[setCompletedFilePreview] Rendering System Icon");
            renderSystemIcon(previewElement, filePath);
            return;
          }

          debugLog("[setCompletedFilePreview] Using Generic Icon");
          setGenericIcon(previewElement, download?.contentType);
        } catch (e) {
          debugLog("Error setting file preview:", e);
          if (download?.target?.path) {
            renderSystemIcon(previewElement, download.target.path);
          } else {
            setGenericIcon(previewElement, download?.contentType);
          }
        }
      }

      return {
        setGenericIcon,
        setCompletedFilePreview,
        updatePodGlowColor,
        renderSystemIcon,
        renderSystemIconByExtension
      };
    }
  };

  console.log("[Zen Tidy Downloads] Preview module loaded");
})();
