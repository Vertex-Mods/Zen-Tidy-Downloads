// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-library-pie.uc.js
// Circular download progress at zen-library-button (or downloads-button) after Zen arc animation ends
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const PREF_ENABLE = "extensions.downloads.enable_library_pie_progress";

  /** Geometry + anchor offset (matches Zen arc styling, smaller footprint) */
  const PIE = Object.freeze({
    hostPx: 20,
    /** Fills content box inside host padding (host − 2×padPx) */
    svgPx: 16,
    padPx: 2,
    cx: 16,
    cy: 16,
    r: 13,
    stroke: 3.5,
    /** px from anchor center */
    offsetX: 10,
    offsetY: -10
  });

  const PIE_CIRC = 2 * Math.PI * PIE.r;

  /** @param {unknown} dl */
  function sessionKeyForDownload(dl) {
    if (dl && dl.id != null) {
      return `id:${dl.id}`;
    }
    const url = dl?.source?.url || dl?.url || "";
    const st = dl?.startTime || "";
    return `t:${url}_${st}`;
  }

  /**
   * @param {unknown} dl
   * @returns {number|null} 0..1 or null if indeterminate
   */
  function progressFraction(dl) {
    if (!dl || dl.succeeded || dl.error || dl.canceled) {
      return null;
    }
    const total = dl.totalBytes;
    const cur = dl.currentBytes || 0;
    if (typeof total === "number" && total > 0) {
      return Math.min(1, Math.max(0, cur / total));
    }
    return null;
  }

  /**
   * @param {Map<string, unknown>} active
   * @returns {{ fraction: number|null, indeterminate: boolean }}
   */
  function aggregateProgress(active) {
    if (active.size === 0) {
      return { fraction: null, indeterminate: false };
    }
    let maxFrac = -1;
    let anyIndeterminate = false;
    for (const dl of active.values()) {
      const f = progressFraction(dl);
      if (f === null) {
        anyIndeterminate = true;
      } else {
        maxFrac = Math.max(maxFrac, f);
      }
    }
    if (maxFrac >= 0) {
      return { fraction: maxFrac, indeterminate: false };
    }
    return { fraction: null, indeterminate: anyIndeterminate };
  }

  window.zenTidyDownloadsLibraryPie = {
    /**
     * @param {Object} ctx
     * @param {function} ctx.getPref
     * @param {function} ctx.debugLog
     * @returns {{ getDownloadViewListener: function(): Object, destroy: function(): void }}
     */
    createController(ctx) {
      const { getPref, debugLog } = ctx;

      /** @type {Map<string, unknown>} */
      const active = new Map();

      let root = null;
      let trackCircle = null;
      let progressCircle = null;
      let indeterminateGroup = null;
      /** @type {HTMLDivElement|null} */
      let zenInnerCircleEl = null;

      let pieRevealed = false;
      let arcMutationObserver = null;
      let arcFallbackTimerId = null;
      let resizeObserver = null;
      /** @type {Element|null} */
      let observedAnchor = null;
      /** @type {HTMLElement|null} clone of Zen's arc icon when arc node is removed */
      let pendingArcIconClone = null;

      function isFeatureEnabled() {
        try {
          return getPref(PREF_ENABLE, true) !== false;
        } catch (e) {
          return true;
        }
      }

      /**
       * @param {Element|null} el
       * @returns {boolean}
       */
      function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 1 || rect.right < 1 || rect.top > window.innerHeight || rect.left > window.innerWidth) {
          return false;
        }
        return true;
      }

      function getAnchor() {
        let lib = document.getElementById("zen-library-button");
        if (!lib) {
          lib = document.querySelector("zen-library-button");
        }
        if (lib && isElementVisible(lib)) {
          return lib;
        }
        const dlBtn = document.getElementById("downloads-button");
        if (dlBtn && isElementVisible(dlBtn)) {
          return dlBtn;
        }
        return null;
      }

      function teardownArcWatcher() {
        if (arcMutationObserver) {
          arcMutationObserver.disconnect();
          arcMutationObserver = null;
        }
        if (arcFallbackTimerId) {
          clearTimeout(arcFallbackTimerId);
          arcFallbackTimerId = null;
        }
      }

      function onArcRemovedOrTimeout() {
        teardownArcWatcher();
        pieRevealed = true;
        updateVisual();
      }

      /**
       * Wait for Zen's flying arc node to leave the shadow root, then reveal the pie.
       */
      function beginWaitForArcThenReveal() {
        teardownArcWatcher();
        const host = document.querySelector("zen-download-animation");
        const sr = host?.shadowRoot;
        if (!sr) {
          debugLog("[LibraryPie] No zen-download-animation shadow root — showing pie immediately");
          pieRevealed = true;
          updateVisual();
          return;
        }

        const arcPresent = sr.querySelector(".zen-download-arc-animation");
        if (!arcPresent) {
          debugLog("[LibraryPie] No arc node in shadow — showing pie immediately");
          pieRevealed = true;
          updateVisual();
          return;
        }

        arcMutationObserver = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const n of m.removedNodes) {
              if (
                n.nodeType === Node.ELEMENT_NODE &&
                /** @type {Element} */ (n).classList?.contains("zen-download-arc-animation")
              ) {
                const arcRoot = /** @type {Element} */ (n);
                const liveIcon = arcRoot.querySelector?.(".zen-download-arc-animation-icon");
                if (liveIcon instanceof HTMLElement) {
                  pendingArcIconClone = /** @type {HTMLElement} */ (liveIcon.cloneNode(true));
                }
                debugLog("[LibraryPie] Arc animation node removed — revealing pie");
                onArcRemovedOrTimeout();
                return;
              }
            }
          }
        });
        arcMutationObserver.observe(sr, { childList: true });

        arcFallbackTimerId = setTimeout(() => {
          debugLog("[LibraryPie] Arc wait fallback elapsed — revealing pie");
          onArcRemovedOrTimeout();
        }, 3200);
      }

      function ensureDom() {
        if (root) return;

        const NS = "http://www.w3.org/2000/svg";
        root = document.createElement("div");
        root.id = "zen-tidy-download-pie-host";
        root.className = "zen-tidy-pie-host";
        root.setAttribute("role", "presentation");
        root.style.cssText = [
          "position:fixed",
          "left:0",
          "top:0",
          `width:${PIE.hostPx}px`,
          `height:${PIE.hostPx}px`,
          "margin:0",
          `padding:${PIE.padPx}px`,
          "pointer-events:none",
          "z-index:2147483646",
          "display:none",
          "box-sizing:border-box",
          "border-radius:50%",
          "background-color:var(--zen-colors-hover-bg, rgba(128,128,128,0.25))",
          "box-shadow:var(--zen-big-shadow, 0 2px 8px rgba(0,0,0,0.2))",
          "align-items:stretch",
          "justify-content:center",
          "flex-direction:column"
        ].join(";");

        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("width", String(PIE.svgPx));
        svg.setAttribute("height", String(PIE.svgPx));
        svg.setAttribute("viewBox", "0 0 32 32");
        svg.classList.add("zen-tidy-pie-ring-svg");
        svg.style.cssText = [
          "position:absolute",
          "left:50%",
          "top:50%",
          "transform:translate(-50%,-50%)",
          "z-index:2",
          "pointer-events:none",
          "display:block",
          "overflow:visible"
        ].join(";");

        const cx = String(PIE.cx);
        const cy = String(PIE.cy);
        const r = String(PIE.r);
        const sw = String(PIE.stroke);

        trackCircle = document.createElementNS(NS, "circle");
        trackCircle.setAttribute("cx", cx);
        trackCircle.setAttribute("cy", cy);
        trackCircle.setAttribute("r", r);
        trackCircle.setAttribute("fill", "none");
        trackCircle.setAttribute("stroke", "var(--toolbar-color, rgba(200,200,200,0.35))");
        trackCircle.setAttribute("stroke-width", sw);

        progressCircle = document.createElementNS(NS, "circle");
        progressCircle.setAttribute("cx", cx);
        progressCircle.setAttribute("cy", cy);
        progressCircle.setAttribute("r", r);
        progressCircle.setAttribute("fill", "none");
        progressCircle.setAttribute("stroke", "var(--zen-primary-color, #0a84ff)");
        progressCircle.setAttribute("stroke-width", sw);
        progressCircle.setAttribute("stroke-linecap", "round");
        progressCircle.setAttribute("transform", `rotate(-90 ${PIE.cx} ${PIE.cy})`);
        progressCircle.setAttribute("stroke-dasharray", String(PIE_CIRC));
        progressCircle.setAttribute("stroke-dashoffset", String(PIE_CIRC));

        indeterminateGroup = document.createElementNS(NS, "g");
        indeterminateGroup.style.display = "none";
        indeterminateGroup.style.transformOrigin = `${PIE.cx}px ${PIE.cy}px`;
        indeterminateGroup.style.animation = "zen-tidy-pie-spin 0.85s linear infinite";
        const indTrack = trackCircle.cloneNode(true);
        const spin = document.createElementNS(NS, "circle");
        spin.setAttribute("cx", cx);
        spin.setAttribute("cy", cy);
        spin.setAttribute("r", r);
        spin.setAttribute("fill", "none");
        spin.setAttribute("stroke", "var(--zen-primary-color, #0a84ff)");
        spin.setAttribute("stroke-width", sw);
        spin.setAttribute("stroke-linecap", "round");
        spin.setAttribute("stroke-dasharray", `${Math.round(PIE_CIRC * 0.25)} ${Math.round(PIE_CIRC * 0.75)}`);
        spin.setAttribute("transform", `rotate(-90 ${PIE.cx} ${PIE.cy})`);
        indeterminateGroup.appendChild(indTrack);
        indeterminateGroup.appendChild(spin);

        svg.appendChild(trackCircle);
        svg.appendChild(progressCircle);
        svg.appendChild(indeterminateGroup);
        root.appendChild(svg);

        // Same structure as Zen arc (see zen-download-arc-animation.css + ZenDownloadAnimation.mjs):
        // inner toolbar disc + .zen-download-arc-animation-icon (mask + primary fill). Full Zen stylesheet
        // cannot be linked here — its :host { position:fixed; inset:0 } would break this widget — so we inject scoped copies.
        zenInnerCircleEl = document.createElement("div");
        zenInnerCircleEl.className = "zen-download-arc-animation-inner-circle";
        zenInnerCircleEl.style.cssText =
          "width:100%;height:100%;min-width:0;min-height:0;flex:1 1 auto;box-sizing:border-box";
        /** @type {HTMLElement} */
        let zenIconEl;
        if (pendingArcIconClone) {
          zenIconEl = pendingArcIconClone;
          pendingArcIconClone = null;
          zenIconEl.setAttribute("aria-hidden", "true");
        } else {
          zenIconEl = document.createElement("div");
          zenIconEl.className = "zen-download-arc-animation-icon";
          zenIconEl.setAttribute("aria-hidden", "true");
        }
        zenInnerCircleEl.appendChild(zenIconEl);
        root.appendChild(zenInnerCircleEl);

        if (!document.getElementById("zen-tidy-pie-zen-arc-styles")) {
          const zst = document.createElement("style");
          zst.id = "zen-tidy-pie-zen-arc-styles";
          zst.textContent = [
            "#zen-tidy-download-pie-host.zen-tidy-pie-host .zen-download-arc-animation-inner-circle {",
            "  position: relative;",
            "  z-index: 0;",
            "  width: 100%;",
            "  height: 100%;",
            "  border-radius: 50%;",
            "  background-color: var(--toolbar-color, rgba(200,200,200,0.35));",
            "  flex-shrink: 0;",
            "}",
            "#zen-tidy-download-pie-host.zen-tidy-pie-host .zen-download-arc-animation-icon {",
            "  position: absolute;",
            "  top: 0;",
            "  left: 0;",
            "  width: 100%;",
            "  height: 100%;",
            "  background-color: var(--zen-primary-color, #0a84ff);",
            '  -webkit-mask: url("chrome://browser/content/zen-images/downloads/download.svg") no-repeat center;',
            "  -webkit-mask-size: 70%;",
            '  mask: url("chrome://browser/content/zen-images/downloads/download.svg") no-repeat center;',
            "  mask-size: 70%;",
            "}"
          ].join("\n");
          document.head.appendChild(zst);
        }

        if (!document.getElementById("zen-tidy-pie-spin-style")) {
          const st = document.createElement("style");
          st.id = "zen-tidy-pie-spin-style";
          st.textContent =
            "@keyframes zen-tidy-pie-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
          document.head.appendChild(st);
        }

        document.body.appendChild(root);
      }

      function bindAnchorResize(anchor) {
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        observedAnchor = anchor;
        if (!anchor) return;
        try {
          resizeObserver = new ResizeObserver(() => updateVisual());
          resizeObserver.observe(anchor);
        } catch (e) {
          debugLog("[LibraryPie] ResizeObserver unavailable:", e);
        }
      }

      function updateVisual() {
        if (!isFeatureEnabled()) {
          if (root) root.style.display = "none";
          return;
        }

        if (active.size === 0 || !pieRevealed) {
          if (root) root.style.display = "none";
          return;
        }

        const anchor = getAnchor();
        if (!anchor) {
          if (root) root.style.display = "none";
          return;
        }

        ensureDom();
        if (!root) return;

        const rect = anchor.getBoundingClientRect();
        root.style.left = `${rect.left + rect.width / 2 + PIE.offsetX}px`;
        root.style.top = `${rect.top + rect.height / 2 + PIE.offsetY}px`;
        root.style.transform = "translate(-50%, -50%)";

        if (observedAnchor !== anchor) {
          bindAnchorResize(anchor);
        }

        const { fraction, indeterminate } = aggregateProgress(active);

        if (indeterminateGroup && progressCircle) {
          if (indeterminate) {
            indeterminateGroup.style.display = "";
            progressCircle.style.display = "none";
          } else {
            indeterminateGroup.style.display = "none";
            progressCircle.style.display = "";
            const p = fraction != null ? fraction : 0;
            progressCircle.setAttribute("stroke-dashoffset", String(PIE_CIRC * (1 - p)));
          }
        }

        root.style.display = "flex";
      }

      function syncDownload(dl, removed = false) {
        const key = sessionKeyForDownload(dl);
        if (!dl) return;

        if (removed || dl.succeeded || dl.error || dl.canceled) {
          active.delete(key);
        } else {
          active.set(key, dl);
        }

        if (active.size === 0) {
          pieRevealed = false;
          teardownArcWatcher();
          if (root) root.style.display = "none";
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
          }
          observedAnchor = null;
          return;
        }

        if (!pieRevealed) {
          beginWaitForArcThenReveal();
        } else {
          updateVisual();
        }
      }

      function destroy() {
        teardownArcWatcher();
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        observedAnchor = null;
        active.clear();
        pieRevealed = false;
        pendingArcIconClone = null;
        if (root?.parentNode) {
          root.parentNode.removeChild(root);
        }
        root = null;
        trackCircle = null;
        progressCircle = null;
        indeterminateGroup = null;
        zenInnerCircleEl = null;
      }

      return {
        getDownloadViewListener() {
          return {
            onDownloadAdded: (dl) => syncDownload(dl, false),
            onDownloadChanged: (dl) => syncDownload(dl, false),
            onDownloadRemoved: (dl) => syncDownload(dl, true)
          };
        },
        destroy
      };
    }
  };

  console.log("[Zen Tidy Downloads] Library pie module loaded");
})();
