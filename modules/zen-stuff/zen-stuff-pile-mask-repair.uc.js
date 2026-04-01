// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-pile-mask-repair.uc.js
// Pile mask/sizer sync (repair), resize recalculation, background + scrollbox chrome, hover-bridge wiring.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffPileMaskRepair = {
    /**
     * @param {Object} ctx
     * @param {Object} ctx.state
     * @param {function(...unknown): void} ctx.debugLog
     * @param {function(): Object} ctx.getVisibilityApi pile visibility API (show/hide/hover)
     * @param {function(): void} ctx.updatePointerEvents
     * @param {function(): void} ctx.updatePileHeight
     * @param {function(): boolean} ctx.isContextMenuVisible
     * @param {function(): boolean} ctx.getAlwaysShowPile
     * @param {function(string): void} ctx.generateGridPosition
     * @param {function(string, number): void} ctx.applyGridPosition
     * @param {function(): void} ctx.updatePodTextColors
     * @returns {{
     *  getPileMaskHeightPx: function(): number,
     *  readSizerContentHeightPx: function(): number,
     *  enforcePileLayoutInvariants: function(string=): void,
     *  schedulePileLayoutRepair: function(string, number=): void,
     *  recalculateLayout: function(): void,
     *  showPileBackground: function(): void,
     *  hidePileBackground: function(): void,
     *  hideWorkspaceScrollboxAfter: function(): void,
     *  showWorkspaceScrollboxAfter: function(): void,
     *  handleHoverBridgeEnter: function(): void,
     *  handleHoverBridgeLeave: function(Event): void,
     *  setupPileBackgroundHoverEvents: function(): void
     * }}
     */
    createMaskRepairApi(ctx) {
      const {
        state,
        debugLog,
        getVisibilityApi,
        updatePointerEvents,
        updatePileHeight,
        isContextMenuVisible,
        getAlwaysShowPile,
        generateGridPosition,
        applyGridPosition,
        updatePodTextColors
      } = ctx;

      function vis() {
        return getVisibilityApi();
      }

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
            vis().hidePile();
          }
          return;
        }

        const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
        const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
        const compactBlocksPile = isCompactMode && !isSidebarExpanded;

        if (getAlwaysShowPile() && !sizerOpen && !compactBlocksPile) {
          debugLog("[PileRepair] always-show + pods but sizer collapsed → showPile", { source });
          vis().showPile();
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

      function recalculateLayout() {
        if (state.dismissedPods.size === 0) return;

        state.dismissedPods.forEach((_, podKey) => {
          generateGridPosition(podKey);
        });

        if (state.dynamicSizer && state.dynamicSizer.style.height !== "0px") {
          state.dynamicSizer.style.left = "0px";
          state.dynamicSizer.style.right = "0px";
          debugLog("Recalculated pile position on resize - full width container");
        }

        state.dismissedPods.forEach((_, podKey) => {
          generateGridPosition(podKey);
          applyGridPosition(podKey, 0);
        });

        schedulePileLayoutRepair("resize", 0);
      }

      function showPileBackground() {
        if (!state.dynamicSizer) return;

        state.dynamicSizer.style.backgroundColor = "transparent";
        state.dynamicSizer.style.background = "transparent";
        state.dynamicSizer.style.backdropFilter = "none";
        state.dynamicSizer.style.webkitBackdropFilter = "none";
        updatePodTextColors();
      }

      function hidePileBackground() {
        if (!state.dynamicSizer) {
          return;
        }
        if (state.isTransitioning) {
          return;
        }

        const isPileVisible = state.dynamicSizer.style.height !== "0px" && state.dismissedPods.size > 0;
        if (isPileVisible) {
          debugLog("[HidePileBackground] Pile is visible - keeping mask persistent");
          return;
        }

        if (state.downloadButton?.matches(":hover") || vis().isHoveringPileArea()) {
          debugLog("[HidePileBackground] User hovering over pile area - keeping mask active");
          return;
        }

        state.dynamicSizer.style.background = "transparent";
        state.dynamicSizer.style.backgroundColor = "transparent";
        debugLog("[HidePileBackground] Background hidden - pile not visible and no hover");
      }

      function hideWorkspaceScrollboxAfter() {
        if (state.workspaceScrollboxStyle) {
          document.documentElement.style.setProperty("--zen-stuff-scrollbox-after-opacity", "0");
          debugLog("Hidden arrowscrollbox.workspace-arrowscrollbox::after");
        }
      }

      function showWorkspaceScrollboxAfter() {
        if (state.workspaceScrollboxStyle) {
          document.documentElement.style.setProperty("--zen-stuff-scrollbox-after-opacity", "1");
          debugLog("Shown arrowscrollbox.workspace-arrowscrollbox::after");
        }
      }

      function handleHoverBridgeEnter() {
        debugLog("[HoverBridge] Entered - keeping pile visible");
        clearTimeout(state.hoverTimeout);
        if (state.dismissedPods.size > 0) {
          vis().showPile();
          showPileBackground();
        }
      }

      function handleHoverBridgeLeave(event) {
        debugLog("[HoverBridge] Left");
        if (
          event?.relatedTarget &&
          (state.pileContainer?.contains(event.relatedTarget) || state.dynamicSizer?.contains(event.relatedTarget))
        ) {
          debugLog("[HoverBridge] Moving into pile - not scheduling hide");
          return;
        }
        const bridgeLeaveGraceMs = 120;
        setTimeout(() => {
          if (vis().isHoveringPileArea() || state.downloadButton?.matches(":hover")) return;
          vis().handleDynamicSizerLeave(event);
        }, bridgeLeaveGraceMs);
      }

      function setupPileBackgroundHoverEvents() {
        if (!state.dynamicSizer || !state.pileContainer) {
          return;
        }

        const v = vis();

        if (state.containerHoverEventsAttached) {
          state.dynamicSizer.removeEventListener("mouseenter", v.handleDynamicSizerHover);
          state.dynamicSizer.removeEventListener("mouseleave", v.handleDynamicSizerLeave);
          state.containerHoverEventsAttached = false;
        }

        if (state.pileHoverEventsAttached) {
          state.pileContainer.removeEventListener("mouseenter", v.handlePileHover);
          state.pileContainer.removeEventListener("mouseleave", v.handlePileLeave);
          state.pileHoverEventsAttached = false;
        }

        if (state.hoverBridge) {
          state.hoverBridge.removeEventListener("mouseenter", handleHoverBridgeEnter);
          state.hoverBridge.removeEventListener("mouseleave", handleHoverBridgeLeave);
          state.hoverBridge.addEventListener("mouseenter", handleHoverBridgeEnter);
          state.hoverBridge.addEventListener("mouseleave", handleHoverBridgeLeave);
        }

        state.dynamicSizer.addEventListener("mouseenter", v.handleDynamicSizerHover);
        state.dynamicSizer.addEventListener("mouseleave", v.handleDynamicSizerLeave);
        state.containerHoverEventsAttached = true;

        state.pileContainer.addEventListener("mouseenter", v.handlePileHover);
        state.pileContainer.addEventListener("mouseleave", v.handlePileLeave);
        state.pileHoverEventsAttached = true;
      }

      return {
        getPileMaskHeightPx,
        readSizerContentHeightPx,
        enforcePileLayoutInvariants,
        schedulePileLayoutRepair,
        recalculateLayout,
        showPileBackground,
        hidePileBackground,
        hideWorkspaceScrollboxAfter,
        showWorkspaceScrollboxAfter,
        handleHoverBridgeEnter,
        handleHoverBridgeLeave,
        setupPileBackgroundHoverEvents
      };
    }
  };
})();
