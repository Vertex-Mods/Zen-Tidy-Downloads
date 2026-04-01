// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-pile-theme-colors.uc.js
// Blended background sampling and dismissed-pile row text contrast.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenStuffPileThemeColors = {
    /**
     * @param {{ state: Object, debugLog: function(string, *=): void }} ctx
     * @returns {{
     *  parseRGB: function(string): { r: number, g: number, b: number, a: number }|null,
     *  computeBlendedBackgroundColor: function(): string,
     *  calculateTextColorForBackground: function(string): string,
     *  updatePodTextColors: function(): void
     * }}
     */
    createPileThemeColorsApi(ctx) {
      const { state, debugLog } = ctx;

      /**
       * Parse RGB/RGBA from CSS color string - returns { r, g, b, a } or null
       * @param {string} colorStr
       */
      function parseRGB(colorStr) {
        if (!colorStr || typeof colorStr !== "string") return null;
        if (colorStr.startsWith("rgba(")) {
          const match = colorStr.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
          if (match) {
            return {
              r: parseInt(match[1], 10),
              g: parseInt(match[2], 10),
              b: parseInt(match[3], 10),
              a: parseFloat(match[4])
            };
          }
        } else if (colorStr.startsWith("rgb(")) {
          const match = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
          if (match) {
            return {
              r: parseInt(match[1], 10),
              g: parseInt(match[2], 10),
              b: parseInt(match[3], 10),
              a: 1
            };
          }
        }
        return null;
      }

      /**
       * Compute the blended background color that matches Zen's lightening effect
       * @returns {string}
       */
      function computeBlendedBackgroundColor() {
        const isCompactMode = document.documentElement.getAttribute("zen-compact-mode") === "true";
        const isSidebarExpanded = document.documentElement.getAttribute("zen-sidebar-expanded") === "true";

        if (isCompactMode && isSidebarExpanded) {
          const navigatorToolbox = document.getElementById("navigator-toolbox");
          if (navigatorToolbox) {
            const toolbarBg = window
              .getComputedStyle(navigatorToolbox)
              .getPropertyValue("--zen-main-browser-background-toolbar")
              .trim();
            if (toolbarBg) {
              const testEl = document.createElement("div");
              testEl.style.backgroundColor = toolbarBg || "var(--zen-main-browser-background-toolbar)";
              testEl.style.position = "absolute";
              testEl.style.visibility = "hidden";
              document.body.appendChild(testEl);
              const computedColor = window.getComputedStyle(testEl).backgroundColor;
              document.body.removeChild(testEl);

              if (computedColor && computedColor !== "transparent" && computedColor !== "rgba(0, 0, 0, 0)") {
                debugLog("[BackgroundColor] Using toolbar background color for compact mode:", computedColor);
                if (computedColor.startsWith("rgba(")) {
                  const match = computedColor.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)/);
                  if (match) {
                    return `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
                  }
                }
                return computedColor;
              }

              return toolbarBg || "var(--zen-main-browser-background-toolbar)";
            }
          }
        }

        const navigatorToolbox = document.getElementById("navigator-toolbox");
        let baseColor = null;
        if (navigatorToolbox) {
          const baseComputed = window.getComputedStyle(navigatorToolbox);
          const baseResolved = baseComputed.getPropertyValue("--zen-main-browser-background").trim();

          if (baseResolved.includes("gradient") || baseResolved.includes("linear") || baseResolved.includes("radial")) {
            return "var(--zen-main-browser-background)";
          }

          const testEl = document.createElement("div");
          testEl.style.backgroundColor = "var(--zen-main-browser-background)";
          testEl.style.position = "absolute";
          testEl.style.visibility = "hidden";
          document.body.appendChild(testEl);
          const computedBase = window.getComputedStyle(testEl).backgroundColor;
          document.body.removeChild(testEl);

          if (computedBase && computedBase !== "transparent" && computedBase !== "rgba(0, 0, 0, 0)") {
            baseColor = computedBase;
          }
        }

        const appWrapper = document.getElementById("zen-main-app-wrapper");
        let wrapperColor = null;
        if (appWrapper) {
          const wrapperComputed = window.getComputedStyle(appWrapper);
          wrapperColor = wrapperComputed.backgroundColor;
        }

        if (!baseColor || !wrapperColor || baseColor === "transparent" || wrapperColor === "transparent") {
          return "var(--zen-main-browser-background)";
        }

        const baseRGB = parseRGB(baseColor);
        const wrapperRGB = parseRGB(wrapperColor);

        if (!baseRGB || !wrapperRGB) {
          return "var(--zen-main-browser-background)";
        }

        const wrapperRatio = 0.067;

        const blendedR = Math.round(baseRGB.r * (1 - wrapperRatio) + wrapperRGB.r * wrapperRatio);
        const blendedG = Math.round(baseRGB.g * (1 - wrapperRatio) + wrapperRGB.g * wrapperRatio);
        const blendedB = Math.round(baseRGB.b * (1 - wrapperRatio) + wrapperRGB.b * wrapperRatio);

        return `rgb(${blendedR}, ${blendedG}, ${blendedB})`;
      }

      /**
       * Calculate text color based on background color (using Zen's luminance/contrast logic)
       * @param {string} backgroundColor
       * @returns {string}
       */
      function calculateTextColorForBackground(backgroundColor) {
        const parsed = parseRGB(backgroundColor);
        const bgRGB = parsed ? [parsed.r, parsed.g, parsed.b] : null;
        if (!bgRGB) {
          return "var(--zen-text-color, #e0e0e0)";
        }

        function luminance([r, g, b]) {
          const a = [r, g, b].map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          });
          return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
        }

        function contrastRatio(rgb1, rgb2) {
          const lum1 = luminance(rgb1);
          const lum2 = luminance(rgb2);
          const brightest = Math.max(lum1, lum2);
          const darkest = Math.min(lum1, lum2);
          return (brightest + 0.05) / (darkest + 0.05);
        }

        const darkText = [0, 0, 0];
        const lightText = [255, 255, 255];

        const darkContrast = contrastRatio(bgRGB, darkText);
        const lightContrast = contrastRatio(bgRGB, lightText);

        const bgLuminance = luminance(bgRGB);
        const useDarkText = darkContrast > lightContrast || bgLuminance > 0.5;

        if (useDarkText) {
          return "rgba(0, 0, 0, 0.8)";
        }
        return "rgba(255, 255, 255, 0.8)";
      }

      function updatePodTextColors() {
        if (!state.dynamicSizer) {
          return;
        }

        const blendedColor = computeBlendedBackgroundColor();
        const textColor = calculateTextColorForBackground(blendedColor);

        const textElements = state.pileContainer.querySelectorAll(
          ".dismissed-pod-filename, .dismissed-pod-filesize"
        );
        textElements.forEach((el) => {
          el.style.color = textColor;
        });

        console.log("[ShowPile] Updated text colors to:", textColor, "for background:", blendedColor);
      }

      return {
        parseRGB,
        computeBlendedBackgroundColor,
        calculateTextColorForBackground,
        updatePodTextColors
      };
    }
  };
})();
