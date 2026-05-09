// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-pile-visibility.uc.js
// Hover/show-hide lifecycle, pile visibility, and pod add/remove transitions.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffPileVisibility = {
    /**
     * @param {Object} ctx
     * @returns {{
     *  addPodToPile: function,
     *  removePodFromPile: function,
     *  updatePileVisibility: function,
     *  updatePileHeight: function,
     *  handleDownloadButtonHover: function,
     *  handleDownloadButtonLeave: function,
     *  handleDynamicSizerHover: function,
     *  handleDynamicSizerLeave: function,
     *  handlePileHover: function,
     *  handlePileLeave: function,
     *  showPile: function,
     *  hidePile: function,
     *  shouldDisableHover: function,
     *  isHoveringPileArea: function
     * }}
     */
    createPileVisibilityApi(ctx) {
      const {
        state,
        CONFIG,
        debugLog,
        createPodElement,
        saveDismissedPodToSession,
        removeDismissedPodFromSession,
        updatePodKeysInSession,
        generateGridPosition,
        applyGridPosition,
        updateDownloadsButtonVisibility,
        updatePodTextColors,
        showPileBackground,
        hidePileBackground,
        hideWorkspaceScrollboxAfter,
        showWorkspaceScrollboxAfter,
        schedulePileLayoutRepair,
        setupPileBackgroundHoverEvents,
        updatePointerEvents,
        updatePileContainerWidth,
        getAlwaysShowPile,
        shouldPileBeVisible,
        isContextMenuVisible,
        pileHoverDebug: pileHoverDebugFromCtx
      } = ctx;

      const pileHoverDebug =
        typeof pileHoverDebugFromCtx === "function"
          ? pileHoverDebugFromCtx
          : function (msg, data) {
              if (typeof window === "undefined" || window.__zenPileHoverDebug !== true) return;
              try {
                console.info("[PileHoverDebug]", msg, data !== undefined ? data : "");
              } catch (_e) {
                /* ignore */
              }
            };

      function isHoveringPileArea() {
        return (
          state.pileContainer?.matches(":hover") ||
          state.dynamicSizer?.matches(":hover") ||
          state.hoverBridge?.matches(":hover")
        );
      }

      /**
       * Recompute `--zen-pile-height` and `zen-pile-expanded` from grid geometry +
       * live media toolbar height. Idempotent; safe after expand or on a verify tick.
       */
      function syncPileMaskToCurrentLayout() {
        if (!state.dynamicSizer || state.dynamicSizer.style.height === "0px") return;
        if (state.dismissedPods.size === 0) return;

        const totalPods = state.dismissedPods.size;
        const podsToShow = Math.min(totalPods, 4);
        const rowHeight = 48;
        const rowSpacing = 6;
        const baseBottomOffset = 8;
        const totalRowHeight = podsToShow * rowHeight + (podsToShow - 1) * rowSpacing;
        const gridHeight = totalRowHeight + baseBottomOffset;

        const mediaControlsToolbar = document.getElementById("zen-media-controls-toolbar");
        const mediaToolbarHeight = mediaControlsToolbar?.getBoundingClientRect().height ?? 0;
        const pileMaskHeight = Math.max(0, gridHeight - (mediaToolbarHeight > 0 ? mediaToolbarHeight : 0));
        document.documentElement.style.setProperty("--zen-pile-height", `${pileMaskHeight}px`);
        if (mediaControlsToolbar) mediaControlsToolbar.classList.add("zen-pile-expanded");
      }

      /**
       * True when Tidy Downloads is showing an in-flight download on the library
       * slot (progress pod = pie). Then hovering the library / downloads button
       * should not expand the dismissed pile.
       * @returns {boolean}
       */
      function isTidyDownloadsLibraryPieVisible() {
        try {
          const pieHost = document.querySelector("#zen-tidy-download-pie-host.zen-tidy-pie-host");
          if (!pieHost || !pieHost.isConnected) return false;
          const podsRow = document.querySelector("#userchrome-pods-row-container");
          if (!podsRow || !podsRow.contains(pieHost)) return false;
          const cs = window.getComputedStyle(pieHost);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          const op = parseFloat(cs.opacity);
          return !Number.isFinite(op) || op > 0;
        } catch (_e) {
          return false;
        }
      }

      function restoreLibraryPieToPodsRowIfNeededFromRow(rowEl) {
        try {
          if (!rowEl?.querySelector?.("#zen-tidy-download-pie-host")) return;
          window.zenTidyDownloads?.getLibraryPieController?.()?.restorePieToPodsRow?.();
        } catch (_e) {
          /* ignore */
        }
      }

      function syncLibraryPieDockForPile() {
        try {
          const pie = window.zenTidyDownloads?.getLibraryPieController?.();
          if (!pie || typeof pie.dockIntoPilePreviewSlot !== "function") return;
          const row = state.pileContainer?.querySelector('.dismissed-pod-row[data-pile-phase="progress"]');
          const slot = row?.querySelector(".dismissed-pod-preview");
          if (slot) pie.dockIntoPilePreviewSlot(slot);
        } catch (_e) {
          /* ignore */
        }
      }

      function maybeRedockLibraryPieAfterPileDomChange() {
        if (!state.dynamicSizer || state.dynamicSizer.style.height === "0px") return;
        syncLibraryPieDockForPile();
      }

      /**
       * Inspect master rename tooltip gate (for debugging + `isTidyDownloadsMasterRenameTooltipVisible`).
       * @returns {{ blocks: boolean, parts: Record<string, unknown> }}
       */
      function getMasterRenameTooltipGateDetail() {
        const parts = {
          tidyApi: !!window.zenTidyDownloads,
          flagBlocks:
            window.zenTidyDownloads?.isRenameTooltipBlockingPileHover?.() === true
        };
        try {
          if (!parts.flagBlocks) {
            parts.reason = "pileHoverBlockedByRenameTooltip flag is not true";
            return { blocks: false, parts };
          }
          const dc = document.getElementById("userchrome-download-cards-container");
          parts.dcFound = !!(dc && dc.isConnected);
          if (!dc || !dc.isConnected) {
            parts.reason = "no #userchrome-download-cards-container";
            return { blocks: false, parts };
          }
          const dcCs = window.getComputedStyle(dc);
          parts.dcDisplay = dcCs.display;
          parts.dcVisibility = dcCs.visibility;
          if (dcCs.display === "none" || dcCs.visibility === "hidden") {
            parts.reason = "cards container hidden in layout";
            return { blocks: false, parts };
          }
          const tip = dc.querySelector(".details-tooltip.master-tooltip");
          parts.tipFound = !!(tip && tip.isConnected);
          if (!tip || !tip.isConnected) {
            parts.reason = "no .master-tooltip in cards container";
            return { blocks: false, parts };
          }
          const tipCs = window.getComputedStyle(tip);
          parts.tipDisplay = tipCs.display;
          parts.tipVisibility = tipCs.visibility;
          parts.tipOpacity = tipCs.opacity;
          if (tipCs.display === "none" || tipCs.visibility === "hidden") {
            parts.reason = "master tooltip hidden in layout";
            return { blocks: false, parts };
          }
          parts.reason = "flag + DOM visible → blocks pile hover";
          return { blocks: true, parts };
        } catch (err) {
          parts.reason = "exception";
          parts.error = String(err);
          return { blocks: false, parts };
        }
      }

      /**
       * True when tidy-downloads has the rename-success tooltip open intentionally.
       * Uses `store.pileHoverBlockedByRenameTooltip` (authoritative) plus a quick DOM
       * check so a stale flag cannot block the pile after chrome is torn down.
       * @returns {boolean}
       */
      function isTidyDownloadsMasterRenameTooltipVisible() {
        return getMasterRenameTooltipGateDetail().blocks;
      }

      /**
       * In-progress downloads now add a pile row immediately; the library pie
       * docks into that row while the pile is expanded, so hover must never be
       * suppressed for "progress chrome" alone.
       * @returns {boolean}
       */
      function shouldDisableHover() {
        return false;
      }

      function addPodToPile(podData, animate = true) {
        if (!podData || !podData.key) {
          debugLog("Invalid pod data for pile addition");
          return;
        }

        if (state.dismissedPods.has(podData.key)) {
          if (podData.inProgress) {
            const el = state.podElements.get(podData.key);
            if (el && el.dataset.pilePhase === "progress") {
              state.dismissedPods.set(podData.key, podData);
              const sub = el.querySelector(".dismissed-pod-filesize");
              if (sub) sub.textContent = podData.progressSubLabel || "…";
              const filenameEl = el.querySelector(".dismissed-pod-filename");
              if (filenameEl && podData.filename) {
                let displayFilename = podData.filename;
                if (podData.targetPath) {
                  try {
                    const pathSeparator = podData.targetPath.includes("\\") ? "\\" : "/";
                    const base = podData.targetPath.split(pathSeparator).pop();
                    if (base && base !== displayFilename) displayFilename = base;
                  } catch (_e) {}
                }
                filenameEl.textContent = displayFilename;
              }
              if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
                setTimeout(() => updatePodTextColors(), 50);
              }
              return;
            }
          }
          state.dismissedPods.set(podData.key, podData);
          if (!podData.inProgress) {
            saveDismissedPodToSession(podData);
          }
          updatePodKeysInSession();
          const oldEl = state.podElements.get(podData.key);
          restoreLibraryPieToPodsRowIfNeededFromRow(oldEl);
          const podElement = createPodElement(podData);
          state.podElements.set(podData.key, podElement);
          if (oldEl && oldEl.parentNode) {
            oldEl.parentNode.replaceChild(podElement, oldEl);
          } else if (state.pileContainer) {
            state.pileContainer.appendChild(podElement);
          }
          generateGridPosition(podData.key);
          // Apply position immediately so the freshly-created element actually
          // shows up while the pile is currently expanded (otherwise it sits at
          // its CSS default coordinates until the next pile-shown / collapse).
          if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
            applyGridPosition(podData.key, 0, false, false);
          }
          updateDownloadsButtonVisibility();
          if (shouldPileBeVisible()) {
            showPile();
            setTimeout(() => {
              updatePodTextColors();
            }, 50);
          } else {
            updatePileVisibility(animate);
            if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
              setTimeout(() => updatePodTextColors(), 50);
            }
          }
          schedulePileLayoutRepair("refresh-pod", 120);
          maybeRedockLibraryPieAfterPileDomChange();
          debugLog(`Refreshed pile pod: ${podData.filename}`);
          return;
        }

        if (state.dismissedPods.size >= 4) {
          const oldestKey = Array.from(state.dismissedPods.keys())[0];
          removePodFromPile(oldestKey);
        }

        state.dismissedPods.set(podData.key, podData);
        if (!podData.inProgress) {
          saveDismissedPodToSession(podData);
        }
        updatePodKeysInSession();

        const podElement = createPodElement(podData);
        state.podElements.set(podData.key, podElement);
        state.pileContainer.appendChild(podElement);

        generateGridPosition(podData.key);
        updateDownloadsButtonVisibility();

        if (shouldPileBeVisible()) {
          showPile();
          setTimeout(() => {
            updatePodTextColors();
          }, 50);
        } else {
          updatePileVisibility(animate);
          if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
            setTimeout(() => updatePodTextColors(), 50);
          }
        }

        schedulePileLayoutRepair("add-pod", 120);
        maybeRedockLibraryPieAfterPileDomChange();
        debugLog(`Added pod to pile: ${podData.filename}`);
      }

      function removePodFromPile(podKey) {
        const podElement = state.podElements.get(podKey);
        const wasVisible = state.dynamicSizer && state.dynamicSizer.style.height !== "0px";

        restoreLibraryPieToPodsRowIfNeededFromRow(podElement);

        if (podElement) {
          podElement.style.zIndex = "0";
          podElement.style.pointerEvents = "none";
          requestAnimationFrame(() => {
            podElement.style.transition = `opacity ${CONFIG.animationDuration}ms ease, transform ${CONFIG.animationDuration}ms ease`;
            const position = state.gridPositions.get(podKey);
            if (position) {
              const rowHeight = 48;
              const rowSpacing = 6;
              const baseBottomOffset = 8;
              const bottomOffset = baseBottomOffset + position.row * (rowHeight + rowSpacing);
              podElement.style.transform = `translate3d(0, -${bottomOffset}px, 0) scale(0.8)`;
            } else {
              podElement.style.transform = "scale(0.8)";
            }
            podElement.style.opacity = "0";
          });

          setTimeout(() => {
            if (podElement.parentNode) {
              podElement.parentNode.removeChild(podElement);
            }
          }, CONFIG.animationDuration);
        }

        state.dismissedPods.delete(podKey);
        state.podElements.delete(podKey);
        state.pilePositions.delete(podKey);
        state.gridPositions.delete(podKey);

        removeDismissedPodFromSession(podKey);
        updatePodKeysInSession();

        if (state.hoverTimeout) {
          clearTimeout(state.hoverTimeout);
          state.hoverTimeout = null;
        }

        state.recentlyRemoved = true;
        state.dismissedPods.forEach((_, key) => generateGridPosition(key));

        if (wasVisible && state.dismissedPods.size > 0) {
          showPile();

          const removalDelay = CONFIG.animationDuration + 50;
          setTimeout(() => {
            updatePileVisibility(true);
            updateDownloadsButtonVisibility();

            setTimeout(() => {
              state.recentlyRemoved = false;
              debugLog("[RemovePod] Cleared recentlyRemoved flag - pile can now hide normally");

              if (!getAlwaysShowPile() && !shouldDisableHover()) {
                const isHoveringDownloadArea = state.downloadButton?.matches(":hover");
                const isHoveringPile = isHoveringPileArea();

                if (!isHoveringDownloadArea && !isHoveringPile) {
                  clearTimeout(state.hoverTimeout);
                  state.hoverTimeout = setTimeout(() => {
                    hidePile();
                  }, CONFIG.hoverDebounceMs);
                }
              }
            }, removalDelay);
          }, removalDelay);
        } else {
          updatePileVisibility();
          updateDownloadsButtonVisibility();
          state.recentlyRemoved = false;
        }
      }

      function updatePileVisibility(shouldAnimate = false) {
        if (state.dismissedPods.size === 0) {
          if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
            hidePile();
          }
        } else {
          const allPods = Array.from(state.dismissedPods.keys());
          allPods.forEach((podKey) => {
            generateGridPosition(podKey);
            applyGridPosition(podKey, 0, shouldAnimate);
          });

          if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
            updatePileHeight();
          }
        }
      }

      function updatePileHeight() {
        if (!state.dynamicSizer || state.dismissedPods.size === 0) return;

        const rowHeight = 48;
        const rowSpacing = 6;
        const podsToShow = Math.min(state.dismissedPods.size, 4);
        const baseBottomOffset = 8;
        const totalRowHeight = podsToShow * rowHeight + (podsToShow - 1) * rowSpacing;
        const gridHeight = totalRowHeight + baseBottomOffset;

        debugLog("Updating pile height dynamically", {
          totalPods: state.dismissedPods.size,
          podsToShow,
          oldHeight: state.dynamicSizer.style.height,
          newHeight: `${gridHeight}px`
        });

        state.dynamicSizer.style.height = `${gridHeight}px`;
        const mediaToolbar = document.getElementById("zen-media-controls-toolbar");
        const mediaToolbarHeight = mediaToolbar?.getBoundingClientRect().height ?? 0;
        const pileMaskHeight = Math.max(0, gridHeight - (mediaToolbarHeight > 0 ? mediaToolbarHeight : 0));
        document.documentElement.style.setProperty("--zen-pile-height", `${pileMaskHeight}px`);
      }

      function handleDownloadButtonHover() {
        debugLog("[DownloadHover] handleDownloadButtonHover called", {
          dismissedPodsSize: state.dismissedPods.size,
          alwaysShowMode: getAlwaysShowPile()
        });

        pileHoverDebug("downloadButtonHover enter", {
          dismissedPods: state.dismissedPods.size,
          alwaysShowPile: getAlwaysShowPile(),
          compactMode: document.documentElement.getAttribute("zen-compact-mode"),
          sidebarExpanded: document.documentElement.getAttribute("zen-sidebar-expanded")
        });

        if (state.dismissedPods.size === 0) {
          pileHoverDebug("downloadButtonHover ABORT: no dismissed pods");
          return;
        }
        if (getAlwaysShowPile()) {
          pileHoverDebug("downloadButtonHover ABORT: always-show-pile pref (hover does not open pile)");
          return;
        }

        pileHoverDebug("downloadButtonHover → schedule showPile", { debounceMs: CONFIG.hoverDebounceMs });
        clearTimeout(state.hoverTimeout);
        state.hoverTimeout = setTimeout(() => {
          pileHoverDebug("downloadButtonHover debounce → showPile()");
          showPile();
          schedulePileLayoutRepair("download-hover", 50);
        }, CONFIG.hoverDebounceMs);
      }

      function handleDownloadButtonLeave() {
        if (getAlwaysShowPile()) return;
        if (shouldDisableHover()) return;
        if (isContextMenuVisible()) {
          state.pendingPileClose = true;
          return;
        }

        clearTimeout(state.hoverTimeout);
        state.hoverTimeout = setTimeout(() => {
          const isHoveringDownloadArea = state.downloadButton?.matches(":hover");
          if (!isHoveringDownloadArea && !isHoveringPileArea()) {
            if (isContextMenuVisible()) {
              state.pendingPileClose = true;
            } else {
              hidePile();
            }
          }
        }, CONFIG.hoverDebounceMs);
      }

      function handleDynamicSizerHover() {
        pileHoverDebug("dynamicSizerHover enter", {
          alwaysShowPile: getAlwaysShowPile(),
          dismissedPods: state.dismissedPods.size
        });
        if (getAlwaysShowPile()) {
          pileHoverDebug("dynamicSizerHover ABORT: always-show");
          return;
        }
        clearTimeout(state.hoverTimeout);
        if (state.dismissedPods.size > 0) {
          pileHoverDebug("dynamicSizerHover → showPile");
          showPile();
          showPileBackground();
          schedulePileLayoutRepair("sizer-hover", 40);
        } else {
          pileHoverDebug("dynamicSizerHover no-op: no dismissed pods");
        }
      }

      function handleDynamicSizerLeave(event) {
        clearTimeout(state.hoverTimeout);
        if (event?.relatedTarget && state.pileContainer?.contains(event.relatedTarget)) return;
        if (isContextMenuVisible()) {
          state.pendingPileClose = true;
          return;
        }
        if (getAlwaysShowPile()) return;

        state.hoverTimeout = setTimeout(() => {
          const isHoveringDownloadArea = state.downloadButton?.matches(":hover");
          const isHoveringPile = isHoveringPileArea();
          if (!isHoveringDownloadArea && !isHoveringPile) {
            if (isContextMenuVisible()) {
              state.pendingPileClose = true;
            } else {
              hidePile();
            }
          }
        }, CONFIG.hoverDebounceMs);
      }

      function handlePileHover() {
        clearTimeout(state.hoverTimeout);
        try {
          window.zenTidyDownloads?.dismissMasterRenameTooltip?.();
        } catch (_e) {
          /* ignore */
        }
        showPileBackground();
        if (state.dismissedPods.size > 0 && state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
          schedulePileLayoutRepair("pile-hover", 40);
        }
      }

      function handlePileLeave(event) {
        clearTimeout(state.hoverTimeout);
        if (event?.relatedTarget && state.dynamicSizer?.contains(event.relatedTarget)) return;
        if (isContextMenuVisible()) {
          state.pendingPileClose = true;
          return;
        }
        if (getAlwaysShowPile()) return;

        state.hoverTimeout = setTimeout(() => {
          const isHoveringDownloadArea = state.downloadButton?.matches(":hover");
          if (!isHoveringDownloadArea && !isHoveringPileArea()) {
            if (isContextMenuVisible()) {
              state.pendingPileClose = true;
            } else {
              hidePile();
            }
          }
        }, CONFIG.hoverDebounceMs);
      }

      function showPile() {
        if (state.dismissedPods.size === 0 || !state.dynamicSizer) {
          pileHoverDebug("showPile no-op", {
            dismissedPods: state.dismissedPods.size,
            hasSizer: !!state.dynamicSizer
          });
          return;
        }

        try {
          window.zenTidyDownloads?.dismissMasterRenameTooltip?.();
        } catch (_e) {
          /* ignore */
        }

        const wasVisible = state.dynamicSizer.style.height !== "0px";

        const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
        const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
        if (isCompactMode && !isSidebarExpanded) {
          pileHoverDebug("showPile ABORT: compact mode + sidebar collapsed (see showPile in zen-stuff-pile-visibility)", {
            isCompactMode,
            isSidebarExpanded
          });
          state.dynamicSizer.style.display = "none";
          return;
        }

        pileHoverDebug("showPile proceeding", {
          dismissedPods: state.dismissedPods.size,
          wasVisible
        });

        state.pileUiGeneration += 1;
        const gen = state.pileUiGeneration;
        if (state.mediaToolbarMaskRemovalTimeout) {
          clearTimeout(state.mediaToolbarMaskRemovalTimeout);
          state.mediaToolbarMaskRemovalTimeout = null;
        }
        if (state.pileHoverEventsSetupTimeout) {
          clearTimeout(state.pileHoverEventsSetupTimeout);
          state.pileHoverEventsSetupTimeout = null;
        }

        state.dynamicSizer.style.display = "flex";
        if (typeof updatePileContainerWidth === "function") updatePileContainerWidth();
        state.dynamicSizer.style.left = "0px";
        state.dynamicSizer.style.right = "0px";
        updatePointerEvents();
        state.dynamicSizer.style.paddingBottom = "0px";
        state.dynamicSizer.style.paddingLeft = "0px";

        const totalPods = state.dismissedPods.size;
        const podsToShow = Math.min(totalPods, 4);
        const rowHeight = 48;
        const rowSpacing = 6;
        const baseBottomOffset = 8;
        const totalRowHeight = podsToShow * rowHeight + (podsToShow - 1) * rowSpacing;
        const gridHeight = totalRowHeight + baseBottomOffset;
        state.dynamicSizer.style.height = `${gridHeight}px`;

        if (state.hoverBridge) state.hoverBridge.style.display = "block";

        syncPileMaskToCurrentLayout();

        showPileBackground();
        hideWorkspaceScrollboxAfter();

        const recentPods = Array.from(state.dismissedPods.keys()).slice(-4);
        if (!wasVisible) {
          recentPods.forEach((podKey) => {
            const el = state.podElements.get(podKey);
            if (el) {
              el.style.transition = "none";
              el.style.opacity = "0";
              el.style.transform = "translateY(20px)";
            }
          });
          if (state.dynamicSizer) state.dynamicSizer.offsetHeight;
          recentPods.forEach((podKey, index) => {
            const el = state.podElements.get(podKey);
            if (el) {
              const delayMs = index * CONFIG.gridAnimationDelay;
              el.style.transition = `opacity ${CONFIG.animationDuration}ms ease ${delayMs}ms, transform ${CONFIG.animationDuration}ms ease ${delayMs}ms`;
            }
          });
          recentPods.forEach((podKey) => generateGridPosition(podKey));
          requestAnimationFrame(() => {
            recentPods.forEach((podKey) => applyGridPosition(podKey, 0, false, true));
          });
        } else {
          recentPods.forEach((podKey) => {
            generateGridPosition(podKey);
            applyGridPosition(podKey, 0);
          });
        }

        state.pileHoverEventsSetupTimeout = setTimeout(() => {
          state.pileHoverEventsSetupTimeout = null;
          if (gen !== state.pileUiGeneration) return;
          setupPileBackgroundHoverEvents();
        }, 50);

        document.dispatchEvent(new CustomEvent("pile-shown", { bubbles: true }));
        schedulePileLayoutRepair("show-pile", 30);

        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (gen !== state.pileUiGeneration) return;
            if (!state.dynamicSizer || state.dynamicSizer.style.height === "0px") return;
            syncPileMaskToCurrentLayout();
            updatePointerEvents();
            syncLibraryPieDockForPile();
            schedulePileLayoutRepair("show-pile-verify", 0);
            debugLog("[PileMask] verification tick after expand", { gen });
          });
        });
      }

      function hidePile() {
        if (state.isEditing) return;
        if (state.recentlyRemoved) return;
        if (isContextMenuVisible()) {
          state.pendingPileClose = true;
          return;
        }
        if (!state.dynamicSizer) return;

        try {
          window.zenTidyDownloads?.getLibraryPieController?.()?.restorePieToPodsRow?.();
        } catch (_e) {
          /* ignore */
        }

        state.pileUiGeneration += 1;
        const gen = state.pileUiGeneration;
        if (state.mediaToolbarMaskRemovalTimeout) {
          clearTimeout(state.mediaToolbarMaskRemovalTimeout);
          state.mediaToolbarMaskRemovalTimeout = null;
        }
        if (state.pileHoverEventsSetupTimeout) {
          clearTimeout(state.pileHoverEventsSetupTimeout);
          state.pileHoverEventsSetupTimeout = null;
        }

        state.dynamicSizer.style.pointerEvents = "none";
        state.dynamicSizer.style.height = "0px";
        if (state.hoverBridge) state.hoverBridge.style.display = "none";
        state.dynamicSizer.style.paddingBottom = "0px";
        state.dynamicSizer.style.paddingLeft = "0px";

        const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
        const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
        if (!(isCompactMode && !isSidebarExpanded)) {
          state.dynamicSizer.style.display = "flex";
        }

        hidePileBackground();
        state.dismissedPods.forEach((_, podKey) => {
          const el = state.podElements.get(podKey);
          if (el) {
            el.style.opacity = "0";
            el.style.transform = "translateY(20px)";
          }
        });

        document.documentElement.style.setProperty("--zen-pile-height", "-50px");
        const mediaControlsToolbar = document.getElementById("zen-media-controls-toolbar");
        if (mediaControlsToolbar) {
          state.mediaToolbarMaskRemovalTimeout = setTimeout(() => {
            state.mediaToolbarMaskRemovalTimeout = null;
            if (gen !== state.pileUiGeneration) return;
            mediaControlsToolbar.classList.remove("zen-pile-expanded");
          }, CONFIG.containerAnimationDuration);
        }
        showWorkspaceScrollboxAfter();
        document.dispatchEvent(
          new CustomEvent("pile-hidden", { bubbles: true, detail: { reason: "collapsed" } })
        );
      }

      pileHoverDebug("pile-visibility API initialized");

      return {
        addPodToPile,
        removePodFromPile,
        updatePileVisibility,
        updatePileHeight,
        handleDownloadButtonHover,
        handleDownloadButtonLeave,
        handleDynamicSizerHover,
        handleDynamicSizerLeave,
        handlePileHover,
        handlePileLeave,
        showPile,
        hidePile,
        shouldDisableHover,
        isHoveringPileArea,
        isTidyDownloadsMasterRenameTooltipVisible,
        getMasterRenameTooltipGateDetail,
        syncLibraryPieDockForPile
      };
    }
  };
})();
