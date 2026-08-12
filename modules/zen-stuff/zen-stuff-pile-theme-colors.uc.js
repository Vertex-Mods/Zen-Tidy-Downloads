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
     *  updatePodTextColors: function(): void
     * }}
     */
    createPileThemeColorsApi(ctx) {
      const { state, debugLog } = ctx;

      /**
       * Zen already computes the correct chrome text color and stores it in
       * `--toolbar-color` (which itself is `var(--toolbox-textcolor)`). The
       * theme picker updates that variable whenever the workspace theme changes,
       * so it is always correct for bright and dark accents alike.
       *
       * We simply forward that variable to every text element in the pile so
       * that the pile inherits Zen's own contrast decision.  A de-emphasised
       * variant is produced with `color-mix` to approximate the secondary/muted
       * text style used elsewhere in chrome UI.
       */
      /**
       * No-op: `--toolbar-color` is already referenced as a live CSS variable
       * in each pod element's inline style at creation time, so it tracks theme
       * changes automatically. This function is kept for call-site compatibility.
       */
      function updatePodTextColors() {
        debugLog("[PileTheme] updatePodTextColors: no-op (color driven by --toolbar-color CSS var)");
      }

      return {
        updatePodTextColors
      };
    }
  };
})();
