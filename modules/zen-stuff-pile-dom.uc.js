// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-pile-dom.uc.js
// Pile container / bridge / dynamic sizer creation.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffPileDom = {
    /**
     * @param {Object} deps
     * @returns {{ createPileContainer: function }}
     */
    createPileDomApi(deps) {
      const {
        state,
        CONFIG,
        debugLog,
        setupPileBackgroundHoverEvents,
        setupCompactModeObserver
      } = deps;

      async function createPileContainer() {
        if (!state.downloadButton) throw new Error("Download button not available");

        let existingSizer = document.getElementById("zen-dismissed-pile-dynamic-sizer");
        if (existingSizer) existingSizer.remove();
        let existingBridge = document.getElementById("zen-dismissed-pile-hover-bridge");
        while (existingBridge) {
          existingBridge.remove();
          existingBridge = document.getElementById("zen-dismissed-pile-hover-bridge");
        }
        state.hoverBridge = null;

        state.dynamicSizer = document.createElement("div");
        state.dynamicSizer.id = "zen-dismissed-pile-dynamic-sizer";
        state.dynamicSizer.style.cssText = `
          position: absolute;
          overflow: hidden;
          height: 0px;
          bottom: 35px;
          left: 0px;
          right: 0px;
          background: transparent;
          box-sizing: border-box;
          transition: height ${CONFIG.containerAnimationDuration}ms ease, padding-bottom ${CONFIG.containerAnimationDuration}ms ease, padding-left ${CONFIG.containerAnimationDuration}ms ease, background 0.2s ease;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: flex-end;
          padding-bottom: 0px;
          padding-left: 0px;
          z-index: 4;
        `;

        state.pileContainer = document.createElement("div");
        state.pileContainer.id = "zen-dismissed-pile-container";
        state.pileContainer.className = "zen-dismissed-pile";
        state.pileContainer.style.cssText = `
          position: relative;
          z-index: 1;
          width: 100%;
          height: 100%;
          box-sizing: border-box;
          padding-left: 5px;
          padding-right: 5px;
        `;
        state.dynamicSizer.appendChild(state.pileContainer);

        state.hoverBridge = document.createElement("div");
        state.hoverBridge.id = "zen-dismissed-pile-hover-bridge";
        state.hoverBridge.style.cssText = `
          position: absolute;
          bottom: 20px;
          left: 0;
          right: 0;
          height: 28px;
          z-index: 3;
          pointer-events: auto;
          display: none;
          -moz-window-dragging: no-drag;
        `;

        setupPileBackgroundHoverEvents();

        const mediaControlsToolbar = document.getElementById("zen-media-controls-toolbar");
        const zenMainAppWrapper = document.getElementById("zen-main-app-wrapper");
        if (mediaControlsToolbar && mediaControlsToolbar.parentNode) {
          const parent = mediaControlsToolbar.parentNode;
          parent.insertBefore(state.hoverBridge, mediaControlsToolbar.nextSibling);
          parent.insertBefore(state.dynamicSizer, state.hoverBridge.nextSibling);
          const parentStyle = window.getComputedStyle(parent);
          if (parentStyle.position === "static") parent.style.position = "relative";
          debugLog("Inserted dismissed pile container after zen-media-controls-toolbar");
        } else if (zenMainAppWrapper) {
          zenMainAppWrapper.appendChild(state.hoverBridge);
          zenMainAppWrapper.appendChild(state.dynamicSizer);
        } else {
          document.body.appendChild(state.hoverBridge);
          document.body.appendChild(state.dynamicSizer);
        }

        setupCompactModeObserver();

        if (!state.workspaceScrollboxStyle) {
          state.workspaceScrollboxStyle = document.createElement("style");
          state.workspaceScrollboxStyle.id = "zen-stuff-workspace-scrollbox-style";
          state.workspaceScrollboxStyle.textContent = `
            arrowscrollbox.workspace-arrowscrollbox::after {
              opacity: var(--zen-stuff-scrollbox-after-opacity, 1) !important;
            }
            @property --zen-pile-height {
              syntax: "<length>";
              inherits: true;
              initial-value: -50px;
            }
            #zen-tabs-wrapper {
              mask-image: linear-gradient(to top, transparent var(--zen-pile-height), black calc(var(--zen-pile-height) + 50px)) !important;
              transition: --zen-pile-height 100ms ease !important;
            }
            #zen-media-controls-toolbar.zen-pile-expanded {
              mask-image: linear-gradient(to top, transparent 50px, black 150px) !important;
              -webkit-mask-image: linear-gradient(to top, transparent 50px, black 150px) !important;
              mask-size: 100% 100%;
              -webkit-mask-size: 100% 100%;
              transition: mask-image 80ms ease, -webkit-mask-image 80ms ease;
            }
          `;
          document.head.appendChild(state.workspaceScrollboxStyle);
        }
      }

      return { createPileContainer };
    }
  };
})();
