// ==UserScript==
// @include   main
// @loadOrder 99999999999998
// @ignorecache
// ==/UserScript==

// zen-stuff.uc.js
// Native-aligned download stack for Zen Browser
// Matches ZenLibraryDownloadStack behavior from Zen Browser source
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  // Single-flight: avoid duplicate initialization
  if (window.__zenStuffBundleExecuted) {
    console.warn("[Zen Stuff] Bundle already executed in this window; skipping duplicate load.");
    return;
  }
  window.__zenStuffBundleExecuted = true;

  // Required for native alignment: ensure Downloads API is available
  if (!window.Downloads || typeof window.Downloads.getList !== "function") {
    // Retry if not ready
    setTimeout(() => {
      if (!window.__zenStuffInitAttempted) {
        window.__zenStuffInitAttempted = true;
        // Re-run this script
        const script = document.createElement('script');
        script.textContent = arguments.callee.toString() + '();';
        document.head.appendChild(script);
        document.head.removeChild(script);
      }
    }, 100);
    return;
  }

  // Wait for the download stack module
  function tryInit(attempt) {
    if (window.zenStuffDownloadStack) {
      initialize();
      return;
    }
    if (attempt < 40) {
      setTimeout(() => tryInit(attempt + 1), 50);
      return;
    }
    console.error("[Zen Stuff] Download stack module failed to load after 2s");
  }

  function initialize() {
    // The download stack is self-initializing in zen-stuff-download-stack.uc.js
    // This file just ensures proper load order
    console.log("[Zen Stuff] Native-aligned download stack initialized");
  }

  // Start initialization
  tryInit(0);
})();
