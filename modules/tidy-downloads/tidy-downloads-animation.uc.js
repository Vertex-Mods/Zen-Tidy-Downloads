// ==UserScript==
// @include   main
// @ignorecache
// ==/UserScript==

// tidy-downloads-animation.uc.js
// Downloads button detection, zen-library-button animation targeting, indicator patching
// Receives context from tidy-downloads.uc.js
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsAnimation = {
    /**
     * Initialize animation module. Called by tidy-downloads.uc.js with context.
     * @param {Object} ctx - Context from main script
     * @param {function} ctx.waitForElement - waitForElement from utils
     * @param {function} ctx.debugLog - debugLog
     * @returns {{ findDownloadsButton, patchDownloadsIndicatorMethods }}
     */
    init(ctx) {
      const { waitForElement, debugLog } = ctx;
      let _proxyButtonRef = null;

      function isElementVisible(element) {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        if (rect.bottom < 1 ||
          rect.right < 1 ||
          rect.top > window.innerHeight ||
          rect.left > window.innerWidth) {
          return false;
        }
        return true;
      }

      function patchAnimationElement(animationElement) {
        try {
          if (!document.getElementById("zen-library-button")) return;

          if (animationElement.determineEndPosition) {
            const originalMethod = animationElement.determineEndPosition;
            animationElement.determineEndPosition = function () {
              const zenLibraryButton = document.getElementById("zen-library-button");
              if (zenLibraryButton && isElementVisible(zenLibraryButton)) {
                const buttonRect = zenLibraryButton.getBoundingClientRect();
                return {
                  endPosition: {
                    clientX: buttonRect.left + buttonRect.width / 2,
                    clientY: buttonRect.top + buttonRect.height / 2,
                  },
                  isDownloadButtonVisible: true
                };
              }
              return originalMethod.call(this);
            };
          }

          if (animationElement._determineEndPosition) {
            const originalPrivateMethod = animationElement._determineEndPosition;
            animationElement._determineEndPosition = function () {
              const zenLibraryButton = document.getElementById("zen-library-button");
              if (zenLibraryButton && isElementVisible(zenLibraryButton)) {
                const buttonRect = zenLibraryButton.getBoundingClientRect();
                return {
                  endPosition: {
                    clientX: buttonRect.left + buttonRect.width / 2,
                    clientY: buttonRect.top + buttonRect.height / 2,
                  },
                  isDownloadButtonVisible: true
                };
              }
              return originalPrivateMethod.call(this);
            };
          }
        } catch (error) {
          console.error("[Tidy Downloads] Error patching animation element:", error);
        }
      }

      function setupAnimationElementPatcher() {
        let patchCount = 0;
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;
              if (node.tagName === "ZEN-DOWNLOAD-ANIMATION") {
                patchAnimationElement(node);
                patchCount++;
              }
              const animationElements = node.querySelectorAll?.("zen-download-animation");
              if (animationElements) {
                animationElements.forEach(el => { patchAnimationElement(el); patchCount++; });
              }
            }
          }
          if (patchCount > 0) {
            observer.disconnect();
            debugLog("[Animation] Subtree observer disconnected after patching elements");
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        console.log("[Tidy Downloads] Set up animation element patcher");
      }

      function getTabsRightSidePref() {
        try {
          if (typeof Services !== "undefined" && Services.prefs) {
            return Services.prefs.getBoolPref("zen.tabs.vertical.right-side");
          }
        } catch (_) {}
        return false;
      }

      function setupLibraryButtonAnimationTarget(libraryButton) {
        try {
          const originalDetermineEndPosition = window.nsZenDownloadAnimationElement?.prototype?._determineEndPosition;

          if (window.nsZenDownloadAnimationElement?.prototype) {
            window.nsZenDownloadAnimationElement.prototype._determineEndPosition = function () {
              const zenLibraryButton = document.getElementById("zen-library-button");
              if (zenLibraryButton && isElementVisible(zenLibraryButton)) {
                const buttonRect = zenLibraryButton.getBoundingClientRect();
                return {
                  endPosition: {
                    clientX: buttonRect.left + buttonRect.width / 2,
                    clientY: buttonRect.top + buttonRect.height / 2,
                  },
                  isDownloadButtonVisible: true
                };
              }
              if (originalDetermineEndPosition) {
                return originalDetermineEndPosition.call(this);
              }
              const downloadsButton = document.getElementById("downloads-button");
              const isDownloadButtonVisible = downloadsButton && isElementVisible(downloadsButton);
              let endPosition = { clientX: 0, clientY: 0 };
              if (isDownloadButtonVisible) {
                const buttonRect = downloadsButton.getBoundingClientRect();
                endPosition = {
                  clientX: buttonRect.left + buttonRect.width / 2,
                  clientY: buttonRect.top + buttonRect.height / 2,
                };
              } else {
                const areTabsPositionedRight = getTabsRightSidePref();
                const wrapper = document.getElementById("zen-main-app-wrapper");
                const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : { left: 0, right: 0, bottom: 0 };
                endPosition = {
                  clientX: areTabsPositionedRight ? wrapperRect.right - 42 : wrapperRect.left + 42,
                  clientY: wrapperRect.bottom - 40,
                };
              }
              return { endPosition, isDownloadButtonVisible };
            };
            console.log("[Tidy Downloads] Successfully overrode animation target for zen-library-button");
          } else {
            setupAnimationElementPatcher();
          }
          setupAnimationObserver();
        } catch (error) {
          console.error("[Tidy Downloads] Error setting up library button animation target:", error);
        }
      }

      function setupAnimationObserver() {
        const existingAnimations = document.querySelectorAll("zen-download-animation");
        existingAnimations.forEach(patchAnimationElement);
        if (document.getElementById("zen-library-button")) {
          createDownloadsButtonProxy();
        }
      }

      function setupDownloadsIndicatorFix(proxyButton) {
        try {
          patchDownloadsIndicatorMethods();
          setTimeout(() => {
            const indicator = window.DownloadsIndicatorView || window.DownloadsButton;
            if (indicator) {
              const progressIcon = proxyButton.querySelector("#downloads-indicator-progress-icon");
              const progressArea = proxyButton.querySelector(".downloads-indicator-progress-area");
              if (progressIcon && progressArea) {
                Object.defineProperty(indicator, "_progressIcon", {
                  get: () => progressIcon,
                  configurable: true,
                  enumerable: true
                });
                Object.defineProperty(indicator, "_progressArea", {
                  get: () => progressArea,
                  configurable: true,
                  enumerable: true
                });
                Object.defineProperty(indicator, "indicator", {
                  get: () => proxyButton,
                  configurable: true,
                  enumerable: true
                });
                console.log("[Tidy Downloads] Fixed downloads indicator references to use proxy elements");
              }
            }
          }, 500);
          setTimeout(() => {
            const indicator = window.DownloadsIndicatorView || window.DownloadsButton;
            if (indicator && !indicator._progressIcon) {
              const progressIcon = proxyButton.querySelector("#downloads-indicator-progress-icon");
              if (progressIcon) {
                Object.defineProperty(indicator, "_progressIcon", {
                  get: () => progressIcon,
                  configurable: true,
                  enumerable: true
                });
                console.log("[Tidy Downloads] Late fix applied for downloads indicator progress icon");
              }
            }
          }, 2000);
        } catch (error) {
          console.error("[Tidy Downloads] Error setting up downloads indicator fix:", error);
        }
      }

      function patchDownloadsIndicatorMethods() {
        try {
          const indicator = window.DownloadsIndicatorView || window.DownloadsButton;
          if (!indicator) {
            console.debug("[Tidy Downloads] No downloads indicator found to patch");
            return;
          }

          if (indicator._progressRaf && !indicator._progressRaf._patched) {
            const originalProgressRaf = indicator._progressRaf;
            indicator._progressRaf = function () {
              try {
                if (this._progressIcon && this._progressIcon.style) {
                  return originalProgressRaf.call(this);
                }
                console.debug("[Tidy Downloads] Skipping _progressRaf - no progress icon available");
                return;
              } catch (error) {
                console.debug("[Tidy Downloads] _progressRaf error handled:", error.message);
                return;
              }
            };
            indicator._progressRaf._patched = true;
          }

          if (indicator._maybeScheduleProgressUpdate && !indicator._maybeScheduleProgressUpdate._patched) {
            const originalMaybeSchedule = indicator._maybeScheduleProgressUpdate;
            indicator._maybeScheduleProgressUpdate = function () {
              try {
                if (this._progressIcon && this._progressIcon.style) {
                  return originalMaybeSchedule.call(this);
                }
                console.debug("[Tidy Downloads] Skipping _maybeScheduleProgressUpdate - no progress icon available");
                return;
              } catch (error) {
                console.debug("[Tidy Downloads] _maybeScheduleProgressUpdate error handled:", error.message);
                return;
              }
            };
            indicator._maybeScheduleProgressUpdate._patched = true;
          }

          const percentCompleteDescriptor = Object.getOwnPropertyDescriptor(indicator, "percentComplete") ||
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(indicator), "percentComplete");
          if (percentCompleteDescriptor && percentCompleteDescriptor.set && !percentCompleteDescriptor.set._patched) {
            const originalSetter = percentCompleteDescriptor.set;
            Object.defineProperty(indicator, "percentComplete", {
              get: percentCompleteDescriptor.get,
              set: function (value) {
                try {
                  if (this._progressIcon && this._progressIcon.style) {
                    return originalSetter.call(this, value);
                  }
                  console.debug("[Tidy Downloads] Skipping percentComplete setter - no progress icon available");
                  return;
                } catch (error) {
                  console.debug("[Tidy Downloads] percentComplete setter error handled:", error.message);
                  return;
                }
              },
              configurable: true,
              enumerable: true
            });
            Object.defineProperty(indicator, "_percentCompletePatched", { value: true });
          }

          if (indicator._updateView && !indicator._updateView._patched) {
            const originalUpdateView = indicator._updateView;
            indicator._updateView = function () {
              try {
                if (this._progressIcon && this._progressIcon.style) {
                  return originalUpdateView.call(this);
                }
                console.debug("[Tidy Downloads] Skipping _updateView - no progress icon available");
                return;
              } catch (error) {
                console.debug("[Tidy Downloads] _updateView error handled:", error.message);
                return;
              }
            };
            indicator._updateView._patched = true;
          }

          if (indicator.refreshView && !indicator.refreshView._patched) {
            const originalRefreshView = indicator.refreshView;
            indicator.refreshView = function () {
              try {
                if (this._progressIcon && this._progressIcon.style) {
                  return originalRefreshView.call(this);
                }
                console.debug("[Tidy Downloads] Skipping refreshView - no progress icon available");
                return;
              } catch (error) {
                console.debug("[Tidy Downloads] refreshView error handled:", error.message);
                return;
              }
            };
            indicator.refreshView._patched = true;
          }

          if (indicator._ensureOperational && !indicator._ensureOperational._patched) {
            const originalEnsureOperational = indicator._ensureOperational;
            indicator._ensureOperational = function () {
              try {
                return originalEnsureOperational.call(this);
              } catch (error) {
                console.debug("[Tidy Downloads] _ensureOperational error handled:", error.message);
                if (!this._progressIcon) {
                  const proxyButton = document.getElementById("downloads-button");
                  if (proxyButton) {
                    const progressIcon = proxyButton.querySelector("#downloads-indicator-progress-icon");
                    if (progressIcon) {
                      this._progressIcon = progressIcon;
                      console.debug("[Tidy Downloads] Set up progress icon in _ensureOperational fallback");
                    }
                  }
                }
                return;
              }
            };
            indicator._ensureOperational._patched = true;
          }

          const hasDownloadsDescriptor = Object.getOwnPropertyDescriptor(indicator, "hasDownloads") ||
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(indicator), "hasDownloads");
          if (hasDownloadsDescriptor && hasDownloadsDescriptor.set && !indicator._hasDownloadsPatched) {
            const originalSetter = hasDownloadsDescriptor.set;
            Object.defineProperty(indicator, "hasDownloads", {
              get: hasDownloadsDescriptor.get,
              set: function (value) {
                try {
                  return originalSetter.call(this, value);
                } catch (error) {
                  console.debug("[Tidy Downloads] hasDownloads setter error handled:", error.message);
                  return;
                }
              },
              configurable: true,
              enumerable: true
            });
            Object.defineProperty(indicator, "_hasDownloadsPatched", { value: true });
          }

          console.log("[Tidy Downloads] Comprehensively patched downloads indicator methods for error handling");
        } catch (error) {
          console.error("[Tidy Downloads] Error patching downloads indicator methods:", error);
        }
      }

      function createDownloadsButtonProxy() {
        try {
          const zenLibraryButton = document.getElementById("zen-library-button");
          const existingDownloadsButton = document.getElementById("downloads-button");
          if (!zenLibraryButton || existingDownloadsButton) return;

          const proxy = document.createElement("toolbarbutton");
          proxy.id = "downloads-button";
          proxy.className = "toolbarbutton-1 chromeclass-toolbar-additional";
          proxy.setAttribute("command", "Tools:Downloads");
          proxy.setAttribute("tooltiptext", "Downloads");

          const stack = document.createElement("stack");
          stack.className = "toolbarbutton-icon";
          const mainIcon = document.createElement("image");
          mainIcon.className = "toolbarbutton-icon";
          mainIcon.setAttribute("src", "chrome://browser/skin/downloads/downloads.svg");

          const progressIcon = document.createElement("vbox");
          progressIcon.className = "toolbarbutton-icon";
          progressIcon.id = "downloads-indicator-progress-icon";
          progressIcon.style.cssText = "opacity: 0; pointer-events: none; position: relative;";

          const progressArea = document.createElement("vbox");
          progressArea.className = "downloads-indicator-progress-area";
          progressArea.style.cssText = "position: relative; overflow: hidden; width: 100%; height: 100%;";
          const progressInner = document.createElement("vbox");
          progressInner.className = "downloads-indicator-progress-inner";
          progressInner.style.cssText = "background-color: #0a84ff; height: 100%; transition: transform 0.2s ease; transform: translateY(100%);";
          const notificationDot = document.createElement("box");
          notificationDot.className = "downloads-indicator-notification";
          notificationDot.style.cssText = "display: none; position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; background: #ff4444; border-radius: 50%; border: 1px solid white;";

          progressArea.appendChild(progressInner);
          progressIcon.appendChild(progressArea);
          progressIcon.appendChild(notificationDot);
          stack.appendChild(mainIcon);
          stack.appendChild(progressIcon);
          proxy.appendChild(stack);

          proxy.style.cssText = `
            position: absolute;
            left: ${zenLibraryButton.offsetLeft}px;
            top: ${zenLibraryButton.offsetTop}px;
            width: ${zenLibraryButton.offsetWidth}px;
            height: ${zenLibraryButton.offsetHeight}px;
            pointer-events: none;
            opacity: 0;
            z-index: -1;
            visibility: hidden;
          `;

          zenLibraryButton.parentNode.insertBefore(proxy, zenLibraryButton);

          const updateProxyPosition = () => {
            if (zenLibraryButton.isConnected && proxy.isConnected) {
              proxy.style.left = `${zenLibraryButton.offsetLeft}px`;
              proxy.style.top = `${zenLibraryButton.offsetTop}px`;
              proxy.style.width = `${zenLibraryButton.offsetWidth}px`;
              proxy.style.height = `${zenLibraryButton.offsetHeight}px`;
            }
          };

          let resizeObserver, mutationObserver;
          try {
            resizeObserver = new ResizeObserver(updateProxyPosition);
            resizeObserver.observe(zenLibraryButton);
            mutationObserver = new MutationObserver((mutations) => {
              mutations.forEach((mutation) => {
                if (mutation.type === "attributes" &&
                  (mutation.attributeName === "style" || mutation.attributeName === "class")) {
                  updateProxyPosition();
                }
              });
            });
            mutationObserver.observe(zenLibraryButton, {
              attributes: true,
              attributeFilter: ["style", "class"]
            });
          } catch (observerError) {
            console.warn("[Tidy Downloads] Observer setup failed, using fallback interval:", observerError);
            const positionInterval = setInterval(() => {
              if (!proxy.isConnected) {
                clearInterval(positionInterval);
                return;
              }
              updateProxyPosition();
            }, 200);
          }

          proxy._cleanupObservers = () => {
            if (resizeObserver) resizeObserver.disconnect();
            if (mutationObserver) mutationObserver.disconnect();
          };

          _proxyButtonRef = proxy;
          setupDownloadsIndicatorFix(proxy);
          console.log("[Tidy Downloads] Created complete downloads-button proxy with progress elements for zen-library-button");
        } catch (error) {
          console.error("[Tidy Downloads] Error creating downloads button proxy:", error);
        }
      }

      async function findDownloadsButton() {
        try {
          console.log("[Tidy Downloads] Auto-detecting download button (trying zen-library-button first)...");
          const libraryButton = await waitForElement("zen-library-button", 2000);

          if (libraryButton) {
            console.log("[Tidy Downloads] Found zen-library-button (auto-detected)");
            debugLog("Found zen-library-button for hover detection (auto-detected)");
            patchDownloadsIndicatorMethods();
            setupLibraryButtonAnimationTarget(libraryButton);
            return libraryButton;
          }

          console.log("[Tidy Downloads] zen-library-button not found, trying downloads button...");
          debugLog("zen-library-button not found, falling back to downloads button");

          const selectors = [
            "#downloads-button",
            "#downloads-indicator",
            '[data-l10n-id="downloads-button"]',
            '.toolbarbutton-1[command="Tools:Downloads"]'
          ];

          for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (button) {
              console.log(`[Tidy Downloads] Found downloads button using selector: ${selector}`, button);
              debugLog(`Found downloads button using selector: ${selector}`);
              return button;
            }
          }

          const fallbackElements = document.querySelectorAll('[id*="download"], [class*="download"]');
          for (const element of fallbackElements) {
            if (element.getAttribute("command")?.includes("Downloads") ||
              element.textContent?.toLowerCase().includes("download")) {
              console.log("[Tidy Downloads] Found downloads button using fallback method", element);
              debugLog("Found downloads button using fallback method", element);
              return element;
            }
          }

          console.warn("[Tidy Downloads] Downloads button not found after all attempts");
          return null;
        } catch (error) {
          console.error("[Tidy Downloads] Error finding downloads button:", error);
          return null;
        }
      }

      function cleanup() {
        if (_proxyButtonRef && typeof _proxyButtonRef._cleanupObservers === "function") {
          _proxyButtonRef._cleanupObservers();
        }
      }

      return {
        findDownloadsButton,
        patchDownloadsIndicatorMethods,
        cleanup
      };
    }
  };
})();
