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
// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-pile-visibility.uc.js
// Pile hover, show/hide, layout repair, and pod add/remove visibility.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffPileVisibility = {
    /**
     * @param {object} ctx
     * @returns {object}
     */
    createPileVisibilityApi(ctx) {
      const {
        state,
        CONFIG,
        debugLog,
        saveDismissedPodToSession,
        updatePodKeysInSession,
        createPodElement,
        generateGridPosition,
        applyGridPosition,
        updatePointerEvents,
        updatePileContainerWidth,
        getAlwaysShowPile,
        isContextMenuVisible,
      } = ctx;

        // Add a pod to the pile
        function addPodToPile(podData, animate = true) {
          if (!podData || !podData.key) {
            debugLog("Invalid pod data for pile addition");
            return;
          }
      
          // Limit to 4 most recent pods
          if (state.dismissedPods.size >= 4) {
            const oldestKey = Array.from(state.dismissedPods.keys())[0];
            removePodFromPile(oldestKey);
          }
      
          // Store pod data
          state.dismissedPods.set(podData.key, podData);
      
          // Save to SessionStore for persistence
          saveDismissedPodToSession(podData);
      
          // Update the list of pod keys in SessionStore
          updatePodKeysInSession();
      
          // Create DOM element
          const podElement = createPodElement(podData);
          state.podElements.set(podData.key, podElement);
          state.pileContainer.appendChild(podElement);
      
          // Generate position for single column layout
          generateGridPosition(podData.key);
      
          // Update downloads button visibility
          updateDownloadsButtonVisibility();
      
          // Single owner for first-pod layout/animation: showPile().
          // Avoid pre-applying final transforms before showPile runs, or the initial entry
          // transition can be consumed on cold start.
          if (shouldPileBeVisible()) {
            showPile();
            // Update text colors after showing pile
            setTimeout(() => {
              updatePodTextColors();
            }, 50);
          } else {
            // Keep internal layout state in sync when pile should remain hidden.
            updatePileVisibility(animate);
          }
      
          schedulePileLayoutRepair("add-pod", 120);
      
          debugLog(`Added pod to pile: ${podData.filename}`);
        }
      
        // Remove a pod from the pile
        function removePodFromPile(podKey) {
          const podElement = state.podElements.get(podKey);
          const wasVisible = state.dynamicSizer && state.dynamicSizer.style.height !== '0px';
          
          if (podElement) {
            // Set lower z-index and disable pointer events to prevent overlap during animation
            podElement.style.zIndex = '0';
            podElement.style.pointerEvents = 'none';
            
            // Animate out using transform and opacity only
            requestAnimationFrame(() => {
              podElement.style.transition = `opacity ${CONFIG.animationDuration}ms ease, transform ${CONFIG.animationDuration}ms ease`;
              
              // Preserve current position but scale down
              const position = state.gridPositions.get(podKey);
              if (position) {
                   const rowHeight = 48;
                   const rowSpacing = 6;
                   const baseBottomOffset = 8;
                   const bottomOffset = baseBottomOffset + (position.row * (rowHeight + rowSpacing));
                   podElement.style.transform = `translate3d(0, -${bottomOffset}px, 0) scale(0.8)`;
              } else {
                   podElement.style.transform = 'scale(0.8)';
              }
              
              podElement.style.opacity = '0';
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
      
          // Remove from SessionStore
          removeDismissedPodFromSession(podKey);
      
          // Update the list of pod keys in SessionStore
          updatePodKeysInSession();
      
          // Clear any pending hide timeout to prevent pile from hiding too quickly after removal
          if (state.hoverTimeout) {
            clearTimeout(state.hoverTimeout);
            state.hoverTimeout = null;
          }
      
          // Set flag to prevent pile from hiding immediately after removal
          state.recentlyRemoved = true;
      
          // Recalculate grid positions for remaining pods
          state.dismissedPods.forEach((_, key) => generateGridPosition(key));
      
          // If pile was visible, animate remaining pods to new positions
          // Wait for removal animation to fully complete before repositioning to avoid overlap
          if (wasVisible && state.dismissedPods.size > 0) {
            // Ensure pile stays visible during and after removal animation
            showPile();
            
            const removalDelay = CONFIG.animationDuration + 50;
            setTimeout(() => {
              updatePileVisibility(true); // Pass true to indicate we should animate
              // Update downloads button visibility
              updateDownloadsButtonVisibility();
              
              // Clear the flag after repositioning animation completes + grace period
              setTimeout(() => {
                state.recentlyRemoved = false;
                debugLog("[RemovePod] Cleared recentlyRemoved flag - pile can now hide normally");
                
                // After clearing the flag, check if we should hide the pile
                // (if user is not hovering and not in always-show mode)
                if (!getAlwaysShowPile() && !shouldDisableHover()) {
                  const isHoveringDownloadArea = state.downloadButton?.matches(':hover');
                  const isHoveringPile = isHoveringPileArea();
      
                  if (!isHoveringDownloadArea && !isHoveringPile) {
                    // Start the hide timeout
                    clearTimeout(state.hoverTimeout);
                    state.hoverTimeout = setTimeout(() => {
                      hidePile();
                    }, CONFIG.hoverDebounceMs);
                  }
                }
              }, removalDelay); // Wait for repositioning animation
            }, removalDelay); // Wait for full fade-out
          } else {
            // updatePileVisibility will handle sizer height if needed
            updatePileVisibility(); // This will now call showPile/hidePile which adjust sizer
            // Update downloads button visibility
            updateDownloadsButtonVisibility();
            // Clear the flag since pile is now empty
            state.recentlyRemoved = false;
          }
        }
      
        // Update pile visibility based on pod count
        function updatePileVisibility(shouldAnimate = false) {
          if (state.dismissedPods.size === 0) {
            // If pile becomes empty, hide it (will set sizer height to 0)
            if (state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
              hidePile();
            }
          } else {
            // Show only the 4 most recent pods
            const allPods = Array.from(state.dismissedPods.keys());
            const recentPods = allPods.slice(-4); // Get last 4 pods (most recent)
      
            // Regenerate positions for all pods
            allPods.forEach(podKey => {
              generateGridPosition(podKey);
              // If animating (e.g., after removal), animate remaining pods to new positions
              applyGridPosition(podKey, 0, shouldAnimate);
            });
      
            // If pile is currently visible, recalculate height dynamically
            if (state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
              updatePileHeight();
            }
          }
        }
      
        // Update pile height dynamically based on current pod count (max 4)
        function updatePileHeight() {
          if (!state.dynamicSizer || state.dismissedPods.size === 0) return;
      
          const rowHeight = 48; // Height of each row (pod + text)
          const rowSpacing = 6; // Spacing between rows
      
          // Always show max 4 pods
          const podsToShow = Math.min(state.dismissedPods.size, 4);
      
          // Calculate height: (rows * row height) + spacing between rows + space below first pod
          // The baseBottomOffset in positioning creates the space, so we add it to height to accommodate it
          const baseBottomOffset = 8; // Space under first pod row (matches applyGridPosition)
          const totalRowHeight = (podsToShow * rowHeight) + ((podsToShow - 1) * rowSpacing);
          const gridHeight = totalRowHeight + baseBottomOffset;
      
          debugLog("Updating pile height dynamically", {
            totalPods: state.dismissedPods.size,
            podsToShow,
            oldHeight: state.dynamicSizer.style.height,
            newHeight: `${gridHeight}px`
          });
      
          state.dynamicSizer.style.height = `${gridHeight}px`;
      
          // Update the mask height variable on document root for #zen-tabs-wrapper mask
          // Subtract media toolbar height when visible so the mask accounts for its space
          const mediaToolbar = document.getElementById('zen-media-controls-toolbar');
          const mediaToolbarHeight = mediaToolbar?.getBoundingClientRect().height ?? 0;
          const pileMaskHeight = Math.max(0, gridHeight - (mediaToolbarHeight > 0 ? mediaToolbarHeight : 0));
          document.documentElement.style.setProperty('--zen-pile-height', `${pileMaskHeight}px`);
        }
      
        // Update pile position relative to download button
        function updatePilePosition() {
          // This function is largely obsolete as the pile is now in-flow within dynamicSizer.
          // Width will be handled by updatePileContainerWidth.
          // Height will be handled by showPile/hidePile.
          debugLog("updatePilePosition called, but largely obsolete now.");
          // If dynamicSizer exists and we need to ensure its width is up-to-date:
          if (typeof updatePileContainerWidth === 'function') {
            // updatePileContainerWidth(); // Call this if needed, but it's called on showPile
          }
        }
      
        // Download button hover handler
        function handleDownloadButtonHover() {
          debugLog("[DownloadHover] handleDownloadButtonHover called", {
            dismissedPodsSize: state.dismissedPods.size,
            shouldDisableHover: shouldDisableHover(),
            alwaysShowMode: getAlwaysShowPile()
          });
      
          if (state.dismissedPods.size === 0) return;
      
          // In always-show mode, don't handle hover events
          if (getAlwaysShowPile()) {
            debugLog("[DownloadHover] Always-show mode enabled - ignoring hover");
            return;
          }
      
          // Check if main download script has active pods and disable hover if so
          if (shouldDisableHover()) {
            debugLog("[HoverDisabled] Pile hover disabled - main download script has active pods");
            return;
          }
      
          clearTimeout(state.hoverTimeout);
          state.hoverTimeout = setTimeout(() => {
            debugLog("[DownloadHover] Timeout triggered - calling showPile()");
            showPile();
            schedulePileLayoutRepair("download-hover", 50);
          }, CONFIG.hoverDebounceMs);
        }
      
        // Download button leave handler
        function handleDownloadButtonLeave() {
          debugLog("[DownloadHover] handleDownloadButtonLeave called");
      
          // In always-show mode, don't handle hover events
          if (getAlwaysShowPile()) {
            debugLog("[DownloadHover] Always-show mode enabled - ignoring leave");
            return;
          }
      
          if (shouldDisableHover()) {
            return; // Don't process leave events if hover is disabled
          }
      
          if (isContextMenuVisible()) {
            debugLog("[DownloadHover] Context menu visible - deferring pile close");
            state.pendingPileClose = true;
            return;
          }
      
          clearTimeout(state.hoverTimeout);
          state.hoverTimeout = setTimeout(() => {
            const isHoveringDownloadArea = state.downloadButton?.matches(':hover');
      
            debugLog("[DownloadHover] Leave timeout - checking hover states", {
              isHoveringDownloadArea,
              pileContainerHover: state.pileContainer?.matches(':hover'),
              dynamicSizerHover: state.dynamicSizer?.matches(':hover')
            });
      
            // Only hide if cursor is not over download button AND not over pile/bridge
            if (!isHoveringDownloadArea && !isHoveringPileArea()) {
              if (isContextMenuVisible()) {
                debugLog("[DownloadHover] Context menu visible at timeout - deferring pile close");
                state.pendingPileClose = true;
              } else {
                debugLog("[DownloadHover] Calling hidePile()");
                hidePile();
              }
            }
          }, CONFIG.hoverDebounceMs);
        }
      
        // Dynamic sizer hover handler  
        function handleDynamicSizerHover() {
          debugLog("[SizerHover] handleDynamicSizerHover called");
      
          if (getAlwaysShowPile()) return;
          
          clearTimeout(state.hoverTimeout);
          
          // Keep pile visible while hovering over sizer and maintain mask
          if (state.dismissedPods.size > 0) {
            showPile();
            showPileBackground();
            schedulePileLayoutRepair("sizer-hover", 40);
            debugLog("[SizerHover] Maintaining pile visibility and mask during sizer hover");
          }
        }
      
        // Dynamic sizer leave handler
        function handleDynamicSizerLeave(event) {
          debugLog("[SizerHover] handleDynamicSizerLeave called");
      
          clearTimeout(state.hoverTimeout);
      
          // If moving into pile content (e.g. from sizer edge to a row), don't schedule hide
          if (event?.relatedTarget && state.pileContainer?.contains(event.relatedTarget)) {
            debugLog("[SizerHover] Moving into pile - not scheduling hide");
            return;
          }
      
          // Don't do anything if context menu is visible
          if (isContextMenuVisible()) {
            debugLog("[SizerHover] Context menu visible - deferring pile close");
            state.pendingPileClose = true;
            return;
          }
      
          // In always-show mode, don't handle pile visibility
          if (getAlwaysShowPile()) {
            debugLog("[SizerHover] Always-show mode - only handling grid transition");
            return;
          }
      
          // Normal mode: handle pile hiding
          state.hoverTimeout = setTimeout(() => {
            const isHoveringDownloadArea = state.downloadButton?.matches(':hover');
            const isHoveringPile = isHoveringPileArea();
      
            debugLog("[SizerHover] Leave timeout - checking hover states", {
              isHoveringDownloadArea,
              pileAreaHover: isHoveringPile,
              contextMenuVisible: isContextMenuVisible()
            });
      
            // Only hide if not hovering download button AND not hovering pile/bridge AND context menu not visible
            if (!isHoveringDownloadArea && !isHoveringPile) {
              if (isContextMenuVisible()) {
                debugLog("[SizerHover] Context menu visible at timeout - deferring pile close");
                state.pendingPileClose = true;
              } else {
                debugLog("[SizerHover] Calling hidePile()");
                hidePile();
              }
            }
          }, CONFIG.hoverDebounceMs);
        }
      
        // Pile hover handler (simplified - no mode transitions)
        function handlePileHover() {
          debugLog("[PileHover] handlePileHover called");
      
          clearTimeout(state.hoverTimeout);
          
          // Ensure pile background and mask remain active during hover
          showPileBackground();
          
          // If pile is visible, ensure it stays visible during hover
          if (state.dismissedPods.size > 0 && state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
            schedulePileLayoutRepair("pile-hover", 40);
            debugLog("[PileHover] Maintaining pile visibility and mask during hover");
          }
        }
      
        // Pile leave handler (simplified)
        function handlePileLeave(event) {
          debugLog("[PileHover] handlePileLeave called");
      
          clearTimeout(state.hoverTimeout);
      
          // If moving within pile area (e.g. between rows), don't schedule hide
          if (event?.relatedTarget && state.dynamicSizer?.contains(event.relatedTarget)) {
            debugLog("[PileHover] Moving within pile area - not scheduling hide");
            return;
          }
      
          // Don't do anything if context menu is visible
          if (isContextMenuVisible()) {
            debugLog("[PileHover] Context menu visible - deferring pile close");
            state.pendingPileClose = true;
            return;
          }
      
          // In always-show mode, don't hide the pile
          if (getAlwaysShowPile()) {
            return;
          }
      
          // Normal mode: handle pile hiding
          state.hoverTimeout = setTimeout(() => {
            const isHoveringDownloadArea = state.downloadButton?.matches(':hover');
      
            if (!isHoveringDownloadArea && !isHoveringPileArea()) {
              if (isContextMenuVisible()) {
                state.pendingPileClose = true;
              } else {
                debugLog("[PileHover] Calling hidePile()");
                hidePile();
              }
            }
          }, CONFIG.hoverDebounceMs);
        }
      
        // Show the pile
        function showPile() {
          debugLog("[ShowPile] showPile called", {
            dismissedPodsSize: state.dismissedPods.size,
            currentHeight: state.dynamicSizer?.style.height,
            // Removed isGridMode
            alwaysShowMode: getAlwaysShowPile()
          });
      
          if (state.dismissedPods.size === 0 || !state.dynamicSizer) return;
      
          // Check if pile is currently visible to prevent double animation
          const wasVisible = state.dynamicSizer.style.height !== '0px';
      
          // Check compact mode state - hide pile if sidebar is collapsed (similar to media controls)
          const isCompactMode = document.documentElement.getAttribute('zen-compact-mode') === 'true';
          const isSidebarExpanded = document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';
      
          if (isCompactMode && !isSidebarExpanded) {
            // In compact mode with collapsed sidebar, hide the pile (like media controls)
            debugLog("[ShowPile] Compact mode with collapsed sidebar - hiding pile");
            state.dynamicSizer.style.display = 'none';
            return;
          }
      
          // Show the pile
          state.dynamicSizer.style.display = 'flex';
      
          // Ensure width is set before calculating positions
          if (typeof updatePileContainerWidth === 'function') {
            updatePileContainerWidth();
          }
      
          // Parent container spans full toolbar width
          state.dynamicSizer.style.left = '0px';
          state.dynamicSizer.style.right = '0px';
          // Remove width when using left/right - it's automatically calculated
      
          debugLog("Positioned pile for full-width container", {
            position: state.dynamicSizer.style.position,
            left: state.dynamicSizer.style.left,
            right: state.dynamicSizer.style.right
          });
      
          // Set pointer-events based on mode and state
          updatePointerEvents();
      
          state.dynamicSizer.style.paddingBottom = '0px'; // No padding - space comes from baseBottomOffset
          state.dynamicSizer.style.paddingLeft = `0px`; // No left padding for full-width rows
      
          // Calculate dynamic height for 4 most recent pods
          const totalPods = state.dismissedPods.size;
          const podsToShow = Math.min(totalPods, 4); // Always max 4 pods
      
          const rowHeight = 48; // Height of each row (pod + text)
          const rowSpacing = 6; // Spacing between rows
      
          // Calculate height: (rows * row height) + spacing between rows + space below first pod
          // The baseBottomOffset in positioning creates the space, so we add it to height to accommodate it
          const baseBottomOffset = 8; // Space under first pod row (matches applyGridPosition)
          const totalRowHeight = (podsToShow * rowHeight) + ((podsToShow - 1) * rowSpacing);
          const gridHeight = totalRowHeight + baseBottomOffset;
      
          debugLog("Dynamic height calculation (4 most recent)", {
            totalPods,
            podsToShow,
            calculatedHeight: gridHeight
          });
      
          state.dynamicSizer.style.height = `${gridHeight}px`;
      
          // Show hover bridge to cover gap between download button and pile
          if (state.hoverBridge) {
            state.hoverBridge.style.display = 'block';
          }
      
          // Update mask height variable for #zen-tabs-wrapper mask
          // Subtract media toolbar height when visible so the mask accounts for its space
          const mediaControlsToolbar = document.getElementById('zen-media-controls-toolbar');
          const mediaToolbarHeight = mediaControlsToolbar?.getBoundingClientRect().height ?? 0;
          const pileMaskHeight = Math.max(0, gridHeight - (mediaToolbarHeight > 0 ? mediaToolbarHeight : 0));
          document.documentElement.style.setProperty('--zen-pile-height', `${pileMaskHeight}px`);
      
          // Apply mask on media controls toolbar for seamless blend when pile expands
          if (mediaControlsToolbar) {
            mediaControlsToolbar.classList.add('zen-pile-expanded');
          }
      
          // Set background to ensure backdrop-filter is properly rendered
          showPileBackground();
      
          // Mask is applied in hover handlers, not here
      
          // Hide workspace-arrowscrollbox::after when pile is showing
          hideWorkspaceScrollboxAfter();
      
          // Update positions for all pods (show only 4 most recent)
          const recentPods = Array.from(state.dismissedPods.keys()).slice(-4);
      
          if (!wasVisible) {
            // Reset pods to hidden state
            recentPods.forEach(podKey => {
              const el = state.podElements.get(podKey);
              if (el) {
                el.style.transition = 'none';
                el.style.opacity = '0';
                el.style.transform = 'translateY(20px)';
              }
            });
      
            // Force reflow so reset state is applied before we set transitions
            if (state.dynamicSizer) state.dynamicSizer.offsetHeight;
      
            // Use CSS transition-delay for stagger (all transitions start same frame, predictable order)
            // Order: oldest (index 0) first, newest (index 3) last
            recentPods.forEach((podKey, index) => {
              const el = state.podElements.get(podKey);
              if (el) {
                const delayMs = index * CONFIG.gridAnimationDelay;
                el.style.transition = `opacity ${CONFIG.animationDuration}ms ease ${delayMs}ms, transform ${CONFIG.animationDuration}ms ease ${delayMs}ms`;
              }
            });
      
            // Batch all position updates in single frame for consistent animation start
            recentPods.forEach(podKey => generateGridPosition(podKey));
            requestAnimationFrame(() => {
              recentPods.forEach(podKey => applyGridPosition(podKey, 0, false, true));
            });
          } else {
            // Already visible: update positions without stagger
            recentPods.forEach((podKey) => {
              generateGridPosition(podKey);
              applyGridPosition(podKey, 0);
            });
          }
      
          // Ensure hover events are properly set up for the current mode
          // This is important after the pile was hidden and is being shown again
          setTimeout(() => {
            setupPileBackgroundHoverEvents();
            debugLog("[ShowPile] Hover events re-setup after pile shown");
          }, 50); // Small delay to ensure DOM is updated
      
          // Notify tidy-downloads that the pile is showing so it can remove sticky pods from the pods row
          document.dispatchEvent(new CustomEvent('pile-shown', { bubbles: true }));
      
          debugLog("Showing pile with single column layout", {
            totalPods,
            podsToShow,
            dynamicHeight: gridHeight
          });
      
          schedulePileLayoutRepair("show-pile", 30);
        }
      
        // Hide the pile
        function hidePile() {
          debugLog("[HidePile] hidePile called", {
            currentHeight: state.dynamicSizer?.style.height,
            isEditing: state.isEditing,
            recentlyRemoved: state.recentlyRemoved
          });
      
          // Don't hide pile if user is editing a filename
          if (state.isEditing) {
            debugLog("[HidePile] Pile kept visible - editing in progress");
            return;
          }
      
          // Don't hide pile if a pod was recently removed (give user time to see the result)
          if (state.recentlyRemoved) {
            debugLog("[HidePile] Pile kept visible - recent removal in progress");
            return;
          }
      
          // Don't hide while pile row context menu is open (or opening); matches sizer/pile leave behavior
          if (isContextMenuVisible()) {
            debugLog("[HidePile] Pile kept visible - context menu active");
            state.pendingPileClose = true;
            return;
          }
      
          if (!state.dynamicSizer) return;
      
          state.dynamicSizer.style.pointerEvents = 'none';
          state.dynamicSizer.style.height = '0px';
      
          if (state.hoverBridge) {
            state.hoverBridge.style.display = 'none';
          }
          state.dynamicSizer.style.paddingBottom = '0px'; // Remove padding when hiding
          state.dynamicSizer.style.paddingLeft = '0px'; // Remove left padding when hiding
      
          // Don't hide display in compact mode - let the observer handle it
          // Only hide display if not in compact mode with collapsed sidebar
          const isCompactMode = document.documentElement.getAttribute('zen-compact-mode') === 'true';
          const isSidebarExpanded = document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';
          if (!(isCompactMode && !isSidebarExpanded)) {
            state.dynamicSizer.style.display = 'flex'; // Keep flex but collapsed
          }
      
          // Hide background and buttons when hiding pile
          hidePileBackground();
      
          // Fade out pods when hiding
          state.dismissedPods.forEach((_, podKey) => {
            const el = state.podElements.get(podKey);
            if (el) {
              el.style.opacity = '0';
              el.style.transform = 'translateY(20px)';
            }
          });
      
          // Reset mask height variable to -50px (completely hide mask)
          document.documentElement.style.setProperty('--zen-pile-height', '-50px');
      
          // Remove mask from media controls toolbar when pile collapses
          const mediaControlsToolbar = document.getElementById('zen-media-controls-toolbar');
          if (mediaControlsToolbar) {
            setTimeout(() => {
              mediaControlsToolbar.classList.remove('zen-pile-expanded');
            }, CONFIG.containerAnimationDuration);
          }
      
          // Restore workspace-arrowscrollbox::after when pile is hidden
          showWorkspaceScrollboxAfter();
      
          debugLog("Hiding dismissed downloads pile by collapsing sizer");
      
          document.dispatchEvent(
            new CustomEvent("pile-hidden", { bubbles: true, detail: { reason: "collapsed" } })
          );
        }
      
        /*
         * Pile visibility state machine (informal invariants):
         * - collapsed: dynamicSizer height 0, --zen-pile-height typically -50px, bridge hidden
         * - expanded:  sizer has row height, mask >= 0 (or 0 when geometry is tiny), pointer-events per always-show
         * - always_visible: getAlwaysShowPile() && dismissedPods.size > 0 ⇒ should not stay collapsed (except compact+sidebar collapsed)
         * - pending_close: pendingPileClose until popuphidden / leave timeout resolves
         * Repair re-syncs mask to sizer and re-applies pointer-events when these drift (e.g. after sticky + pile-shown).
         */
      
        /**
         * @returns {number}
         */
        function getPileMaskHeightPx() {
          const raw = getComputedStyle(document.documentElement).getPropertyValue("--zen-pile-height").trim();
          const n = parseFloat(raw);
          return Number.isFinite(n) ? n : NaN;
        }
      
        /**
         * @returns {number}
         */
        function readSizerContentHeightPx() {
          const h = state.dynamicSizer?.style?.height;
          if (!h || h === "0px") {
            return 0;
          }
          const n = parseFloat(h);
          return Number.isFinite(n) ? n : 0;
        }
      
        /**
         * Fix desynced mask / sizer / pointer-events. Idempotent; logs when it changes something.
         * @param {string} source
         */
        function enforcePileLayoutInvariants(source = "") {
          if (!state.dynamicSizer) {
            return;
          }
      
          const podCount = state.dismissedPods.size;
          const sizerOpen = state.dynamicSizer.style.height !== "0px";
          const maskH = getPileMaskHeightPx();
          const sizerH = readSizerContentHeightPx();
      
          if (podCount === 0) {
            if (
              sizerOpen &&
              !state.recentlyRemoved &&
              !state.isEditing &&
              !isContextMenuVisible()
            ) {
              debugLog("[PileRepair] empty pile but sizer open → hidePile", { source });
              hidePile();
            }
            return;
          }
      
          const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
          const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
          const compactBlocksPile = isCompactMode && !isSidebarExpanded;
      
          if (getAlwaysShowPile() && !sizerOpen && !compactBlocksPile) {
            debugLog("[PileRepair] always-show + pods but sizer collapsed → showPile", { source });
            showPile();
            updatePointerEvents();
            return;
          }
      
          if (sizerOpen && !compactBlocksPile) {
            const maskBadNegative = Number.isFinite(maskH) && maskH < 0;
            const maskZeroButSizerTall = maskH === 0 && sizerH > 16;
            if (maskBadNegative || maskZeroButSizerTall) {
              debugLog("[PileRepair] sizer open but mask out of sync → updatePileHeight", {
                source,
                maskH,
                sizerH
              });
              updatePileHeight();
              updatePointerEvents();
            }
          }
        }
      
        /**
         * Coalesce rapid calls; throttle how often we run a full enforce pass.
         * @param {string} source
         * @param {number} delayMs
         */
        function schedulePileLayoutRepair(source, delayMs = 80) {
          clearTimeout(state.pileRepairDebounceId);
          state.pileRepairDebounceId = setTimeout(() => {
            state.pileRepairDebounceId = null;
            const now = Date.now();
            if (now - state.lastPileRepairAt < 350) {
              return;
            }
            state.lastPileRepairAt = now;
            try {
              enforcePileLayoutInvariants(source);
            } catch (e) {
              debugLog("[PileRepair] enforce error:", e);
            }
          }, delayMs);
        }
      
        // Recalculate layout on window resize
        function recalculateLayout() {
          if (state.dismissedPods.size === 0) return;
      
          // Regenerate grid positions
          state.dismissedPods.forEach((_, podKey) => {
            generateGridPosition(podKey);
          });
      
          // Recalculate position if pile is currently shown - parent container spans full width
          if (state.dynamicSizer && state.dynamicSizer.style.height !== '0px') {
            // Parent container spans full toolbar width
            state.dynamicSizer.style.left = '0px';
            state.dynamicSizer.style.right = '0px';
            // Remove width when using left/right - it's automatically calculated
      
            debugLog("Recalculated pile position on resize - full width container");
          }
      
          // Apply positions for all pods (always single column mode now)
          state.dismissedPods.forEach((_, podKey) => {
            generateGridPosition(podKey);
            applyGridPosition(podKey, 0);
          });
      
          schedulePileLayoutRepair("resize", 0);
        }
      
        function initPileSidebarWidthSync() {
          // This function is now unused - width is only read on-demand in showPile()
          debugLog('[PileWidthSync] initPileSidebarWidthSync called but automatic sync is disabled to prevent feedback loops.');
        }
        // --- End Pile Container Width Synchronization Logic ---
      
        // Update downloads button visibility - now handled by hover events
        function updateDownloadsButtonVisibility() {
          // Buttons are now controlled by hover events in showPileBackground/hidePileBackground
          // This function is kept for compatibility but doesn't change visibility
          debugLog(`[DownloadsButton] Button visibility managed by hover - ${state.dismissedPods.size} dismissed pods`);
        }
      
        // Check if main download script has active pods to disable hover
        function shouldDisableHover() {
          try {
            // Check for visible download pods within the dedicated container.
            // Sticky pods (.zen-tidy-sticky-pod) are already in the pile and should NOT disable hover -
            // we want the pile to open so the sticky pod can animate out.
            const podsRowContainer = document.getElementById('userchrome-pods-row-container');
            if (podsRowContainer) {
              const activePods = podsRowContainer.querySelectorAll('.download-pod:not(.zen-tidy-sticky-pod)');
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
      
        // Parse RGB/RGBA from CSS color string - returns { r, g, b, a } or null
        function parseRGB(colorStr) {
          if (!colorStr || typeof colorStr !== 'string') return null;
          if (colorStr.startsWith('rgba(')) {
            const match = colorStr.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
            if (match) {
              return {
                r: parseInt(match[1]),
                g: parseInt(match[2]),
                b: parseInt(match[3]),
                a: parseFloat(match[4])
              };
            }
          } else if (colorStr.startsWith('rgb(')) {
            const match = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (match) {
              return {
                r: parseInt(match[1]),
                g: parseInt(match[2]),
                b: parseInt(match[3]),
                a: 1
              };
            }
          }
          return null;
        }
      
        // Compute the blended background color that matches Zen's lightening effect
        function computeBlendedBackgroundColor() {
          // Check if we're in compact mode - use toolbar background color directly
          const isCompactMode = document.documentElement.getAttribute('zen-compact-mode') === 'true';
          const isSidebarExpanded = document.documentElement.getAttribute('zen-sidebar-expanded') === 'true';
      
          if (isCompactMode && isSidebarExpanded) {
            // In compact mode with expanded sidebar, use toolbar background color (includes light tint)
            const navigatorToolbox = document.getElementById('navigator-toolbox');
            if (navigatorToolbox) {
              const toolbarBg = window.getComputedStyle(navigatorToolbox).getPropertyValue('--zen-main-browser-background-toolbar').trim();
              if (toolbarBg) {
                // Try to get the computed color value
                const testEl = document.createElement('div');
                testEl.style.backgroundColor = toolbarBg || 'var(--zen-main-browser-background-toolbar)';
                testEl.style.position = 'absolute';
                testEl.style.visibility = 'hidden';
                document.body.appendChild(testEl);
                const computedColor = window.getComputedStyle(testEl).backgroundColor;
                document.body.removeChild(testEl);
      
                if (computedColor && computedColor !== 'transparent' && computedColor !== 'rgba(0, 0, 0, 0)') {
                  debugLog('[BackgroundColor] Using toolbar background color for compact mode:', computedColor);
                  // Ensure fully opaque - convert rgba to rgb if needed
                  if (computedColor.startsWith('rgba(')) {
                    const match = computedColor.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/);
                    if (match) {
                      return `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
                    }
                  }
                  return computedColor;
                }
      
                // If computed color isn't available, return the CSS variable
                return toolbarBg || 'var(--zen-main-browser-background-toolbar)';
              }
            }
          }
      
          // For non-compact mode or collapsed sidebar, use the blended color calculation
          // Get base background color
          const navigatorToolbox = document.getElementById('navigator-toolbox');
          let baseColor = null;
          if (navigatorToolbox) {
            const baseComputed = window.getComputedStyle(navigatorToolbox);
            const baseResolved = baseComputed.getPropertyValue('--zen-main-browser-background').trim();
      
            // If it's a gradient, we can't easily blend, so return the variable
            if (baseResolved.includes('gradient') || baseResolved.includes('linear') || baseResolved.includes('radial')) {
              return 'var(--zen-main-browser-background)';
            }
      
            // Try to get the actual computed color
            const testEl = document.createElement('div');
            testEl.style.backgroundColor = 'var(--zen-main-browser-background)';
            testEl.style.position = 'absolute';
            testEl.style.visibility = 'hidden';
            document.body.appendChild(testEl);
            const computedBase = window.getComputedStyle(testEl).backgroundColor;
            document.body.removeChild(testEl);
      
            if (computedBase && computedBase !== 'transparent' && computedBase !== 'rgba(0, 0, 0, 0)') {
              baseColor = computedBase;
            }
          }
      
          // Get wrapper background color
          const appWrapper = document.getElementById('zen-main-app-wrapper');
          let wrapperColor = null;
          if (appWrapper) {
            const wrapperComputed = window.getComputedStyle(appWrapper);
            wrapperColor = wrapperComputed.backgroundColor;
          }
      
          // If we don't have both colors, fallback to base
          if (!baseColor || !wrapperColor || baseColor === 'transparent' || wrapperColor === 'transparent') {
            return 'var(--zen-main-browser-background)';
          }
      
          const baseRGB = parseRGB(baseColor);
          const wrapperRGB = parseRGB(wrapperColor);
      
          if (!baseRGB || !wrapperRGB) {
            return 'var(--zen-main-browser-background)';
          }
      
          // Blend the colors to achieve the target: rgb(49, 32, 42)
          // Formula: blended = base * (1 - ratio) + wrapper * ratio
          // Solving for ratio to match target rgb(49, 32, 42):
          // If base is rgb(34, 17, 31) and wrapper is rgb(255, 233, 198):
          // - R: 34 + (255-34) * ratio = 49 => ratio ≈ 0.068
          // - G: 17 + (233-17) * ratio = 32 => ratio ≈ 0.069  
          // - B: 31 + (198-31) * ratio = 42 => ratio ≈ 0.066
          // Average ratio ≈ 0.067 (about 6.7%)
          const wrapperRatio = 0.067; // Adjusted to match target rgb(49, 32, 42)
      
          const blendedR = Math.round(baseRGB.r * (1 - wrapperRatio) + wrapperRGB.r * wrapperRatio);
          const blendedG = Math.round(baseRGB.g * (1 - wrapperRatio) + wrapperRGB.g * wrapperRatio);
          const blendedB = Math.round(baseRGB.b * (1 - wrapperRatio) + wrapperRGB.b * wrapperRatio);
      
          // Always return fully opaque color (no transparency)
          return `rgb(${blendedR}, ${blendedG}, ${blendedB})`;
        }
      
        // Calculate text color based on background color (using Zen's luminance/contrast logic)
        function calculateTextColorForBackground(backgroundColor) {
          const parsed = parseRGB(backgroundColor);
          const bgRGB = parsed ? [parsed.r, parsed.g, parsed.b] : null;
          if (!bgRGB) {
            // Fallback to CSS variable if we can't parse
            return 'var(--zen-text-color, #e0e0e0)';
          }
      
          // Calculate relative luminance (from Zen's luminance function)
          function luminance([r, g, b]) {
            const a = [r, g, b].map((v) => {
              v /= 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
            return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
          }
      
          // Calculate contrast ratio (from Zen's contrastRatio function)
          function contrastRatio(rgb1, rgb2) {
            const lum1 = luminance(rgb1);
            const lum2 = luminance(rgb2);
            const brightest = Math.max(lum1, lum2);
            const darkest = Math.min(lum1, lum2);
            return (brightest + 0.05) / (darkest + 0.05);
          }
      
          // Test dark text (black) and light text (white)
          const darkText = [0, 0, 0];
          const lightText = [255, 255, 255];
      
          const darkContrast = contrastRatio(bgRGB, darkText);
          const lightContrast = contrastRatio(bgRGB, lightText);
      
          // Use whichever has better contrast
          // Also consider: if background is very light, use dark text; if very dark, use light text
          const bgLuminance = luminance(bgRGB);
          const useDarkText = darkContrast > lightContrast || bgLuminance > 0.5;
      
          if (useDarkText) {
            return 'rgba(0, 0, 0, 0.8)'; // Dark text with some transparency
          } else {
            return 'rgba(255, 255, 255, 0.8)'; // Light text with some transparency
          }
        }
      
        // Update text colors for all pod rows based on current background
        function updatePodTextColors() {
          if (!state.dynamicSizer) {
            return;
          }
      
          const blendedColor = computeBlendedBackgroundColor();
          const textColor = calculateTextColorForBackground(blendedColor);
      
          // Update all pod text elements
          const textElements = state.pileContainer.querySelectorAll('.dismissed-pod-filename, .dismissed-pod-filesize');
          textElements.forEach(el => {
            el.style.color = textColor;
          });
      
          console.log('[ShowPile] Updated text colors to:', textColor, 'for background:', blendedColor);
        }
      
        // applyTabsWrapperMask and removeTabsWrapperMask function removed - logic replaced by CSS mask-image with --zen-pile-height variable
      
        // Show pile background on hover
        // dynamicSizer stays transparent in all modes so the mask on #zen-tabs-wrapper reveals the titlebar underneath
        function showPileBackground() {
          if (!state.dynamicSizer) return;
      
          state.dynamicSizer.style.backgroundColor = 'transparent';
          state.dynamicSizer.style.background = 'transparent';
          state.dynamicSizer.style.backdropFilter = 'none';
          state.dynamicSizer.style.webkitBackdropFilter = 'none';
          updatePodTextColors();
        }
      
        // Hide pile background when not hovering
        function hidePileBackground() {
          if (!state.dynamicSizer) {
            return;
          }
          if (state.isTransitioning) {
            return;
          }
          
          // Don't hide background if pile is currently visible - keep mask persistent
          const isPileVisible = state.dynamicSizer.style.height !== '0px' && state.dismissedPods.size > 0;
          if (isPileVisible) {
            // Keep the background and mask active while pile is visible
            debugLog("[HidePileBackground] Pile is visible - keeping mask persistent");
            return;
          }
          
          // Don't hide background if user is currently hovering over pile area
          if (state.downloadButton?.matches(':hover') || isHoveringPileArea()) {
            debugLog("[HidePileBackground] User hovering over pile area - keeping mask active");
            return;
          }
          
          // Only hide background when pile is actually hidden and no hover
          state.dynamicSizer.style.background = 'transparent';
          state.dynamicSizer.style.backgroundColor = 'transparent';
          debugLog("[HidePileBackground] Background hidden - pile not visible and no hover");
        }
      
        // Hide arrowscrollbox.workspace-arrowscrollbox::after when pile is showing
        function hideWorkspaceScrollboxAfter() {
          if (state.workspaceScrollboxStyle) {
            document.documentElement.style.setProperty('--zen-stuff-scrollbox-after-opacity', '0');
            debugLog("Hidden arrowscrollbox.workspace-arrowscrollbox::after");
          }
        }
      
        // Show arrowscrollbox.workspace-arrowscrollbox::after when pile is hidden
        function showWorkspaceScrollboxAfter() {
          if (state.workspaceScrollboxStyle) {
            document.documentElement.style.setProperty('--zen-stuff-scrollbox-after-opacity', '1');
            debugLog("Shown arrowscrollbox.workspace-arrowscrollbox::after");
          }
        }
      
        // Helper: is cursor over pile area (including bridge between button and pile)
        function isHoveringPileArea() {
          return state.pileContainer?.matches(':hover') ||
                 state.dynamicSizer?.matches(':hover') ||
                 state.hoverBridge?.matches(':hover');
        }
      
        // Hover bridge enter - keeps pile visible when moving from download button to pile
        function handleHoverBridgeEnter() {
          debugLog("[HoverBridge] Entered - keeping pile visible");
          clearTimeout(state.hoverTimeout);
          if (state.dismissedPods.size > 0) {
            showPile();
            showPileBackground();
          }
        }
      
        // Hover bridge leave - same logic as dynamicSizer leave
        // Use a short delay so pile's mouseenter can fire first when moving bridge→pile (avoids premature hide)
        function handleHoverBridgeLeave(event) {
          debugLog("[HoverBridge] Left");
          if (event?.relatedTarget && (state.pileContainer?.contains(event.relatedTarget) || state.dynamicSizer?.contains(event.relatedTarget))) {
            debugLog("[HoverBridge] Moving into pile - not scheduling hide");
            return;
          }
          // Delay before delegating so pile's mouseenter has time to fire when moving upward
          const bridgeLeaveGraceMs = 120;
          setTimeout(() => {
            if (isHoveringPileArea() || state.downloadButton?.matches(':hover')) return;
            handleDynamicSizerLeave(event);
          }, bridgeLeaveGraceMs);
        }
      
        // Setup hover events for background/buttons (simplified - always single column mode)
        function setupPileBackgroundHoverEvents() {
          if (!state.dynamicSizer || !state.pileContainer) {
            return;
          }
      
          // Remove existing hover events first
          if (state.containerHoverEventsAttached) {
            state.dynamicSizer.removeEventListener('mouseenter', handleDynamicSizerHover);
            state.dynamicSizer.removeEventListener('mouseleave', handleDynamicSizerLeave);
            state.containerHoverEventsAttached = false;
          }
      
          if (state.pileHoverEventsAttached) {
            state.pileContainer.removeEventListener('mouseenter', handlePileHover);
            state.pileContainer.removeEventListener('mouseleave', handlePileLeave);
            state.pileHoverEventsAttached = false;
          }
      
          if (state.hoverBridge) {
            state.hoverBridge.removeEventListener('mouseenter', handleHoverBridgeEnter);
            state.hoverBridge.removeEventListener('mouseleave', handleHoverBridgeLeave);
            state.hoverBridge.addEventListener('mouseenter', handleHoverBridgeEnter);
            state.hoverBridge.addEventListener('mouseleave', handleHoverBridgeLeave);
          }
      
          // Attach both: dynamicSizer (overall area) and pileContainer (pile rows) so mask stays when hovering rows
          state.dynamicSizer.addEventListener('mouseenter', handleDynamicSizerHover);
          state.dynamicSizer.addEventListener('mouseleave', handleDynamicSizerLeave);
          state.containerHoverEventsAttached = true;
      
          state.pileContainer.addEventListener('mouseenter', handlePileHover);
          state.pileContainer.addEventListener('mouseleave', handlePileLeave);
          state.pileHoverEventsAttached = true;
        }
      
        function shouldPileBeVisible() {
          if (state.dismissedPods.size === 0) return false;
      
          if (getAlwaysShowPile()) {
            // In always-show mode: visible unless Alt is pressed
            return !state.isAltPressed;
          } else {
            // Normal hover mode: only visible when hovering
            return false; // This will be overridden by hover handlers
          }
        }

      return {
        addPodToPile,
        removePodFromPile,
        updatePileVisibility,
        updatePileHeight,
        updatePilePosition,
        handleDownloadButtonHover,
        handleDownloadButtonLeave,
        handleDynamicSizerHover,
        handleDynamicSizerLeave,
        handlePileHover,
        handlePileLeave,
        handleHoverBridgeEnter,
        handleHoverBridgeLeave,
        setupPileBackgroundHoverEvents,
        showPile,
        hidePile,
        showPileBackground,
        hidePileBackground,
        updatePodTextColors,
        getPileMaskHeightPx,
        readSizerContentHeightPx,
        enforcePileLayoutInvariants,
        schedulePileLayoutRepair,
        recalculateLayout,
        shouldDisableHover,
        isHoveringPileArea,
        shouldPileBeVisible,
        updateDownloadsButtonVisibility,
        hideWorkspaceScrollboxAfter,
        showWorkspaceScrollboxAfter,
      };
    },
  };
})();
