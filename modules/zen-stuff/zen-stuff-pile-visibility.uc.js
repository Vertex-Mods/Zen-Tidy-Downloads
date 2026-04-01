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
        isContextMenuVisible
      } = ctx;

      function isHoveringPileArea() {
        return (
          state.pileContainer?.matches(":hover") ||
          state.dynamicSizer?.matches(":hover") ||
          state.hoverBridge?.matches(":hover")
        );
      }

      function shouldDisableHover() {
        try {
          const podsRowContainer = document.getElementById("userchrome-pods-row-container");
          if (podsRowContainer) {
            const activePods = podsRowContainer.querySelectorAll(".download-pod:not(.zen-tidy-sticky-pod)");
            if (activePods.length > 0) {
              debugLog(`[HoverCheck] Found ${activePods.length} active (non-sticky) pods - disabling pile hover`);
              return true;
            }
          }
          return false;
        } catch (error) {
          debugLog(`[HoverCheck] Error checking main script state:`, error);
          return false;
        }
      }

      function addPodToPile(podData, animate = true) {
        if (!podData || !podData.key) {
          debugLog("Invalid pod data for pile addition");
          return;
        }

        if (state.dismissedPods.size >= 4) {
          const oldestKey = Array.from(state.dismissedPods.keys())[0];
          removePodFromPile(oldestKey);
        }

        state.dismissedPods.set(podData.key, podData);
        saveDismissedPodToSession(podData);
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
        }

        schedulePileLayoutRepair("add-pod", 120);
        debugLog(`Added pod to pile: ${podData.filename}`);
      }

      function removePodFromPile(podKey) {
        const podElement = state.podElements.get(podKey);
        const wasVisible = state.dynamicSizer && state.dynamicSizer.style.height !== "0px";

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
          shouldDisableHover: shouldDisableHover(),
          alwaysShowMode: getAlwaysShowPile()
        });

        if (state.dismissedPods.size === 0) return;
        if (getAlwaysShowPile()) return;
        if (shouldDisableHover()) return;

        clearTimeout(state.hoverTimeout);
        state.hoverTimeout = setTimeout(() => {
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
        if (getAlwaysShowPile()) return;
        clearTimeout(state.hoverTimeout);
        if (state.dismissedPods.size > 0) {
          showPile();
          showPileBackground();
          schedulePileLayoutRepair("sizer-hover", 40);
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
        if (state.dismissedPods.size === 0 || !state.dynamicSizer) return;
        const wasVisible = state.dynamicSizer.style.height !== "0px";

        const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
        const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
        if (isCompactMode && !isSidebarExpanded) {
          state.dynamicSizer.style.display = "none";
          return;
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

        const mediaControlsToolbar = document.getElementById("zen-media-controls-toolbar");
        const mediaToolbarHeight = mediaControlsToolbar?.getBoundingClientRect().height ?? 0;
        const pileMaskHeight = Math.max(0, gridHeight - (mediaToolbarHeight > 0 ? mediaToolbarHeight : 0));
        document.documentElement.style.setProperty("--zen-pile-height", `${pileMaskHeight}px`);
        if (mediaControlsToolbar) mediaControlsToolbar.classList.add("zen-pile-expanded");

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

        setTimeout(() => {
          setupPileBackgroundHoverEvents();
        }, 50);

        document.dispatchEvent(new CustomEvent("pile-shown", { bubbles: true }));
        schedulePileLayoutRepair("show-pile", 30);
      }

      function hidePile() {
        if (state.isEditing) return;
        if (state.recentlyRemoved) return;
        if (isContextMenuVisible()) {
          state.pendingPileClose = true;
          return;
        }
        if (!state.dynamicSizer) return;

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
          setTimeout(() => {
            mediaControlsToolbar.classList.remove("zen-pile-expanded");
          }, CONFIG.containerAnimationDuration);
        }
        showWorkspaceScrollboxAfter();
        document.dispatchEvent(
          new CustomEvent("pile-hidden", { bubbles: true, detail: { reason: "collapsed" } })
        );
      }

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
        isHoveringPileArea
      };
    }
  };
})();
