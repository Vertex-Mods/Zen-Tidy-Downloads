// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-pile-layout.uc.js
// Grid/pile position math, debounce, sidebar width read for pile container.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffPileLayout = {
    /**
     * @param {Object} ctx
     * @param {Object} ctx.state
     * @param {Object} ctx.CONFIG
     * @param {function} ctx.debugLog
     * @returns {{ generatePilePosition: function, generateGridPosition: function, applyPilePosition: function, applyGridPosition: function, debounce: function, updatePileContainerWidth: function }}
     */
    createPileLayoutApi(ctx) {
      const { state, CONFIG, debugLog } = ctx;

      function generatePilePosition(podKey) {
        const angle = (Math.random() - 0.5) * CONFIG.pileRotationRange * 2;
        const offsetX = (Math.random() - 0.5) * CONFIG.pileOffsetRange * 2;
        const offsetY = (Math.random() - 0.5) * CONFIG.pileOffsetRange * 2;
        const pods = Array.from(state.dismissedPods.keys());
        const podIndex = pods.indexOf(podKey);
        const zIndex = podIndex + 1;

        state.pilePositions.set(podKey, {
          x: offsetX,
          y: offsetY,
          rotation: angle,
          zIndex
        });

        debugLog(`Generated pile position for ${podKey}:`, {
          index: podIndex,
          zIndex,
          angle,
          offsetX,
          offsetY
        });
      }

      function generateGridPosition(podKey) {
        const allPods = Array.from(state.dismissedPods.keys());
        const recentPods = allPods.slice(-4);
        const index = recentPods.indexOf(podKey);

        if (index === -1) {
          return;
        }

        const x = 0;
        const rowIndex = recentPods.length - 1 - index;

        state.gridPositions.set(podKey, { x, y: 0, row: rowIndex, col: 0 });

        debugLog(`Single column position (bottom-up) for ${podKey}:`, {
          index,
          rowIndex,
          x,
          totalRecent: recentPods.length
        });
      }

      function applyPilePosition(podKey, animate = true) {
        const podElement = state.podElements.get(podKey);
        const position = state.pilePositions.get(podKey);
        if (!podElement || !position) return;

        const transform = `translate3d(${position.x}px, ${position.y}px, 0) rotate(${position.rotation}deg)`;

        if (!animate) {
          podElement.style.transition = "none";
        }

        podElement.style.transform = transform;
        podElement.style.zIndex = position.zIndex;

        if (!animate) {
          requestAnimationFrame(() => {
            podElement.style.transition = `transform ${CONFIG.animationDuration}ms cubic-bezier(0.4, 0, 0.2, 1)`;
          });
        }
      }

      function applyGridPosition(podKey, delay = 0, shouldAnimate = false, preserveTransition = false) {
        const podElement = state.podElements.get(podKey);
        const position = state.gridPositions.get(podKey);
        if (!podElement || !position) {
          if (podElement) {
            podElement.style.display = "none";
          }
          return;
        }

        const update = () => {
          if (shouldAnimate && !preserveTransition) {
            podElement.style.transition = `opacity ${CONFIG.animationDuration}ms ease, transform ${CONFIG.animationDuration}ms ease`;
          }
          const rowHeight = 48;
          const rowSpacing = 6;
          const baseBottomOffset = 8;
          const bottomOffset = baseBottomOffset + position.row * (rowHeight + rowSpacing);

          podElement.style.bottom = "0px";
          podElement.style.left = "0";
          podElement.style.right = "0";
          podElement.style.top = "auto";
          podElement.style.transform = `translate3d(0, -${bottomOffset}px, 0)`;
          podElement.style.display = "flex";
          podElement.style.zIndex = "1";
          podElement.style.opacity = "1";
        };

        if (preserveTransition) {
          update();
        } else if (delay > 0) {
          setTimeout(() => requestAnimationFrame(update), delay);
        } else {
          requestAnimationFrame(update);
        }
      }

      function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
          const later = () => {
            clearTimeout(timeout);
            func(...args);
          };
          clearTimeout(timeout);
          timeout = setTimeout(later, wait);
        };
      }

      function updatePileContainerWidth() {
        if (!state.dynamicSizer) {
          debugLog("[PileWidthSync] dynamicSizer not found. Cannot set width.");
          return;
        }

        const navigatorToolbox = document.getElementById("navigator-toolbox");
        let newWidth = "";

        if (navigatorToolbox) {
          const value = getComputedStyle(navigatorToolbox).getPropertyValue("--zen-sidebar-width").trim();
          if (value && value !== "0px" && value !== "") {
            newWidth = value;
            debugLog("[PileWidthSync] Using --zen-sidebar-width from #navigator-toolbox:", newWidth);
          }
        }

        if (!newWidth) {
          const sidebarBox = document.getElementById("sidebar-box");
          if (sidebarBox && sidebarBox.clientWidth > 0) {
            newWidth = `${sidebarBox.clientWidth}px`;
            debugLog("[PileWidthSync] Using #sidebar-box.clientWidth as fallback:", newWidth);
          } else {
            newWidth = "300px";
            debugLog("[PileWidthSync] Using default width (300px) as final fallback.");
          }
        }

        state.currentZenSidebarWidthForPile = newWidth;
        debugLog("[PileWidthSync] Stored sidebar width:", newWidth);
      }

      return {
        generatePilePosition,
        generateGridPosition,
        applyPilePosition,
        applyGridPosition,
        debounce,
        updatePileContainerWidth
      };
    }
  };
})();
