// ==UserScript==
// @include   main
// @loadOrder 99999999999998
// @ignorecache
// ==/UserScript==

// zen-stuff.uc.js - Native-aligned download stack
// This is a stub that loads the actual implementation from modules/zen-stuff/
(function () {
  "use strict";
  if (location.href !== "chrome://browser/content/browser.xhtml") return;
  // Single-flight
  if (window.__zenStuffExecuted) return;
  window.__zenStuffExecuted = true;
})();
