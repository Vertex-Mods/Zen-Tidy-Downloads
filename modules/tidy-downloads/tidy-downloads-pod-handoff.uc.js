// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-pod-handoff.uc.js
// Visual bridge between the library-pie (progress phase) and the pod card
// (live-pod phase). When a download terminates, the lifecycle module calls
// animate(...) with a snapshot of the pie's current rect/icon and the newly
// created pod element. This module builds a fixed-position ghost clone at the
// pie's position and animates it toward the pod, fading out as it lands.
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const PREF_ENABLE = "extensions.downloads.enable_pod_handoff_animation";
  const GHOST_CLASS = "zen-tidy-pod-handoff-ghost";

  /** Motion constants; kept local so future tuning only touches this file. */
  const MOTION = Object.freeze({
    durationMs: 380,
    easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    /** Ghost final opacity; the pod's own CSS transition provides the visible landing state. */
    endOpacity: 0
  });

  window.zenTidyDownloadsPodHandoff = {
    /**
     * @param {Object} ctx
     * @param {function} ctx.getPref
     * @param {function} ctx.debugLog
     * @returns {{
     *   isEnabled: function(): boolean,
     *   animate: function(options: { fromRect: DOMRect, iconClone?: HTMLElement|null, toElement: HTMLElement, onComplete?: function }): boolean
     * }}
     */
    createHandoffAnimator(ctx) {
      const { getPref, debugLog } = ctx;

      function isEnabled() {
        try {
          return getPref(PREF_ENABLE, true) !== false;
        } catch (e) {
          return true;
        }
      }

      /**
       * Build the ghost element. We reuse the pie's cloned icon when
       * available so the moving visual preserves Zen's arc-icon appearance
       * throughout the handoff.
       * @param {DOMRect} fromRect
       * @param {HTMLElement|null} iconClone
       * @returns {HTMLElement}
       */
      function buildGhost(fromRect, iconClone) {
        const ghost = document.createElement("div");
        ghost.className = GHOST_CLASS;
        ghost.setAttribute("role", "presentation");
        ghost.setAttribute("aria-hidden", "true");
        ghost.style.cssText = [
          "position:fixed",
          `left:${fromRect.left}px`,
          `top:${fromRect.top}px`,
          `width:${fromRect.width}px`,
          `height:${fromRect.height}px`,
          "margin:0",
          "padding:0",
          "pointer-events:none",
          "z-index:2147483646",
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "border-radius:50%",
          "box-sizing:border-box",
          "background-color:var(--zen-colors-hover-bg, rgba(128,128,128,0.25))",
          "box-shadow:var(--zen-big-shadow, 0 2px 8px rgba(0,0,0,0.2))",
          "will-change:transform, opacity",
          "transform-origin:50% 50%"
        ].join(";");

        if (iconClone instanceof HTMLElement) {
          iconClone.style.cssText +=
            ";width:60%;height:60%;flex:0 0 auto;pointer-events:none";
          ghost.appendChild(iconClone);
        }
        return ghost;
      }

      /**
       * Kick off the handoff. Returns true if an animation was scheduled.
       * @param {{ fromRect: DOMRect, iconClone?: HTMLElement|null, toElement: HTMLElement, onComplete?: function }} opts
       * @returns {boolean}
       */
      function animate(opts) {
        if (!isEnabled()) return false;
        const { fromRect, iconClone, toElement, onComplete } = opts || {};

        if (!fromRect || !toElement) {
          debugLog?.("[PodHandoff] Skipped: missing fromRect or toElement");
          return false;
        }
        if (fromRect.width <= 0 || fromRect.height <= 0) {
          debugLog?.("[PodHandoff] Skipped: zero-size fromRect");
          return false;
        }

        const toRect = toElement.getBoundingClientRect();
        if (toRect.width <= 0 || toRect.height <= 0) {
          debugLog?.("[PodHandoff] Skipped: zero-size toElement rect (pods row hidden?)");
          return false;
        }

        const fromCx = fromRect.left + fromRect.width / 2;
        const fromCy = fromRect.top + fromRect.height / 2;
        const toCx = toRect.left + toRect.width / 2;
        const toCy = toRect.top + toRect.height / 2;
        const dx = toCx - fromCx;
        const dy = toCy - fromCy;
        const scale = Math.max(0.2, toRect.width / fromRect.width);

        // We deliberately do NOT animate `toElement` itself. The pod has its
        // own CSS transition (see .download-pod in chrome.css) driven by the
        // tooltip-layout manager writing inline opacity/transform — animating
        // the pod here would fight that system. The ghost glides into the
        // pod's final position and fades out while the pod pops in on its own.
        const ghost = buildGhost(fromRect, iconClone);
        document.body.appendChild(ghost);

        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
          if (typeof onComplete === "function") {
            try {
              onComplete();
            } catch (e) {
              debugLog?.("[PodHandoff] onComplete threw", e);
            }
          }
        };

        try {
          const ghostAnim = ghost.animate(
            [
              { transform: "translate(0px, 0px) scale(1)", opacity: 1 },
              {
                transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
                opacity: MOTION.endOpacity
              }
            ],
            {
              duration: MOTION.durationMs,
              easing: MOTION.easing,
              fill: "forwards"
            }
          );
          ghostAnim.onfinish = cleanup;
          ghostAnim.oncancel = cleanup;
        } catch (e) {
          debugLog?.("[PodHandoff] Web Animations API failed, falling back to immediate finish", e);
          cleanup();
          return false;
        }

        // Safety net: even if animationend never fires, clean up eventually.
        setTimeout(cleanup, MOTION.durationMs + 500);

        return true;
      }

      return {
        isEnabled,
        animate
      };
    }
  };

  console.log("[Zen Tidy Downloads] Pod handoff module loaded");
})();
