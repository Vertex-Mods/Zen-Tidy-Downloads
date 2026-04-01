// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-sync.uc.js
// Sidebar width sync and Zen animation - receives context from tidy-downloads.uc.js
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsSync = {
    /**
     * Initialize sync module. Called by tidy-downloads.uc.js with context.
     * @param {Object} ctx - Context from main script
     * @param {function} ctx.getMasterTooltip - () => masterTooltipDOMElement
     * @param {function} ctx.getPodsContainer - () => podsRowContainerElement
     * @param {function} ctx.getActiveCards - () => activeDownloadCards
     * @param {{ current: string|null }} ctx.focusedKeyRef - focused download key ref
     * @param {function} ctx.updateUI - updateUIForFocusedDownload
     * @param {Object} ctx.sidebarWidthRef - { value } mutable ref for currentZenSidebarWidth
     * @param {function} ctx.debugLog - debugLog
     * @returns {{ initZenAnimationObserver, initSidebarWidthSync, triggerCardEntrance }}
     */
    init(ctx) {
      const { getMasterTooltip, getPodsContainer, getActiveCards, focusedKeyRef, updateUI, sidebarWidthRef, debugLog } = ctx;

      function updateCurrentZenSidebarWidth() {
        const mainWindow = document.getElementById("main-window");
        const toolbox = document.getElementById("navigator-toolbox");

        if (!toolbox) {
          debugLog("[SidebarWidthSync] #navigator-toolbox not found.");
          return;
        }

        if (mainWindow) {
          const isCompact = mainWindow.getAttribute("zen-compact-mode") === "true";
          debugLog(`[SidebarWidthSync] zen-compact-mode: ${isCompact}. Reading from #navigator-toolbox.`);
        }

        const value = getComputedStyle(toolbox).getPropertyValue("--zen-sidebar-width").trim();

        if (value && value !== "0px" && value !== "") {
          if (sidebarWidthRef.value !== value) {
            sidebarWidthRef.value = value;
            debugLog("[SidebarWidthSync] Updated currentZenSidebarWidth:", value);
            applyGlobalWidthToAllTooltips();
          }
        } else {
          if (sidebarWidthRef.value !== "") {
            sidebarWidthRef.value = "";
            debugLog(`[SidebarWidthSync] Cleared currentZenSidebarWidth ('${value}').`);
            applyGlobalWidthToAllTooltips();
          }
        }
      }

      function applyGlobalWidthToAllTooltips() {
        const masterTooltip = getMasterTooltip();
        if (!masterTooltip) {
          debugLog("[TooltipWidth] Master tooltip not found.");
          return;
        }
        masterTooltip.style.width = "100%";
        debugLog("[TooltipWidth] Applied 100% width to master tooltip");
      }

      function initSidebarWidthSync() {
        const mainWindow = document.getElementById("main-window");
        const navigatorToolbox = document.getElementById("navigator-toolbox");
        let resizeTimeoutId = null;

        if (mainWindow) {
          const mutationObserver = new MutationObserver(() => {
            debugLog("[SidebarWidthSync] zen-compact-mode changed.");
            updateCurrentZenSidebarWidth();
          });
          mutationObserver.observe(mainWindow, { attributes: true, attributeFilter: ["zen-compact-mode"] });
        }

        if (navigatorToolbox) {
          const resizeObserver = new ResizeObserver(() => {
            clearTimeout(resizeTimeoutId);
            resizeTimeoutId = setTimeout(() => {
              debugLog("[SidebarWidthSync] #navigator-toolbox resized.");
              updateCurrentZenSidebarWidth();
            }, 25);
          });
          resizeObserver.observe(navigatorToolbox);
        }

        debugLog("[SidebarWidthSync] Initial call.");
        updateCurrentZenSidebarWidth();
      }

      function triggerCardEntrance(downloadKeyToTrigger) {
        const activeCards = getActiveCards();
        const cardData = activeCards.get(downloadKeyToTrigger);
        if (!cardData) {
          debugLog(`[ZenSync] triggerCardEntrance: No cardData for key ${downloadKeyToTrigger}`);
          return;
        }

        if (cardData.isWaitingForZenAnimation) {
          debugLog(`[ZenSync] triggerCardEntrance: Zen animation completed for ${downloadKeyToTrigger}.`);
          cardData.isWaitingForZenAnimation = false;

          const podsContainer = getPodsContainer();
          if (!cardData.domAppended && podsContainer && cardData.podElement) {
            podsContainer.appendChild(cardData.podElement);
            cardData.domAppended = true;
            debugLog(`[ZenSync] Appended pod ${downloadKeyToTrigger} to DOM.`);
          }

          updateUI(focusedKeyRef.current || downloadKeyToTrigger, false);
        } else {
          debugLog(`[ZenSync] triggerCardEntrance: ${downloadKeyToTrigger} was not waiting for Zen animation.`);
        }
      }

      function initZenAnimationObserver(downloadKey, podElementToMonitor) {
        debugLog("[ZenSync] Initializing observer for key:", downloadKey);
        let observer = null;
        let fallbackTimeoutId = null;

        const zenAnimationHost = document.querySelector("zen-download-animation");

        if (zenAnimationHost && zenAnimationHost.shadowRoot) {
          observer = new MutationObserver((mutationsList, obs) => {
            for (const mutation of mutationsList) {
              if (mutation.type === "childList" && mutation.removedNodes.length > 0) {
                for (const removedNode of mutation.removedNodes) {
                  if (removedNode.nodeType === Node.ELEMENT_NODE && removedNode.classList.contains("zen-download-arc-animation")) {
                    debugLog("[ZenSync] Detected .zen-download-arc-animation removal.", { key: downloadKey });
                    clearTimeout(fallbackTimeoutId);
                    triggerCardEntrance(downloadKey, podElementToMonitor);
                    obs.disconnect();
                    observer = null;
                    return;
                  }
                }
              }
            }
          });
          observer.observe(zenAnimationHost.shadowRoot, { childList: true });

          fallbackTimeoutId = setTimeout(() => {
            debugLog("[ZenSync] Fallback timeout reached.", { key: downloadKey });
            if (observer) {
              observer.disconnect();
              observer = null;
            }
            triggerCardEntrance(downloadKey);
          }, 3000);
        } else {
          debugLog("[ZenSync] zen-download-animation not found. Triggering immediately.", { key: downloadKey });
          triggerCardEntrance(downloadKey);
        }
      }

      return { initZenAnimationObserver, initSidebarWidthSync, triggerCardEntrance };
    }
  };

  console.log("[Zen Tidy Downloads] Sync module loaded");
})();
