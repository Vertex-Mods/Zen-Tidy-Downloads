// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-library-pie.uc.js
// Circular download progress pie rendered inside #userchrome-pods-row-container
// (stacked with completed pods in badge mode). Living in the same parent as the pods makes
// the pie inherit the pods' compact-mode / sidebar-expanded hide/show rules
// for free, and makes its position automatically match where the completed
// pod will land (it IS visually the "progress" state of the pod).
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const PREF_ENABLE = "extensions.downloads.enable_library_pie_progress";

  /** Geometry - host sized to match .download-pod (25x25). */
  const PIE = Object.freeze({
    hostPx: 16,
    svgPx: 16,
    padPx: 2,
    cx: 16,
    cy: 16,
    r: 13,
    stroke: 3.5
  });

  const PIE_CIRC = 2 * Math.PI * PIE.r;

  /** Pause after Zen's arc leaves the DOM before showing the pie (ms). */
  const POST_ARC_PIE_DELAY_MS = 200;

  /**
   * Fallback key when no external getDownloadKey is provided. Canonicalisation
   * (target.path preferred) happens upstream via ctx.getDownloadKey.
   * @param {unknown} dl
   */
  function fallbackKeyForDownload(dl) {
    if (dl?.target?.path) return dl.target.path;
    if (dl?.id != null) return `id:${dl.id}`;
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
     * @param {function} [ctx.getDownloadKey] - canonical key resolver shared with the pods module
     * @param {Object} [ctx.store] - shared state bag; when provided, active downloads
     *   are tracked via store.progressingDownloads so the pod-lifecycle can see them too
     * @param {function(): (HTMLElement|null)} [ctx.getPodsRowContainer] - returns
     *   the #userchrome-pods-row-container element; the pie is appended there as a
     *   flex sibling of the pods
     * @param {function} [ctx.updateDownloadCardsVisibility] - compact-visibility
     *   refresh hook, called whenever the pie appears/disappears so the parent
     *   container can show/hide even when there are zero pods
     * @returns {{ syncDownload: function, captureHandoffSnapshot: function, destroy: function(): void }}
     */
    createController(ctx) {
      const { getPref, debugLog } = ctx;
      const resolveKey = typeof ctx.getDownloadKey === "function" ? ctx.getDownloadKey : fallbackKeyForDownload;
      const getPodsRowContainer = typeof ctx.getPodsRowContainer === "function" ? ctx.getPodsRowContainer : () => null;
      const refreshContainerVisibility =
        typeof ctx.updateDownloadCardsVisibility === "function" ? ctx.updateDownloadCardsVisibility : () => {};

      /**
       * Active in-progress downloads keyed by canonical getDownloadKey. Backed
       * by the shared store when available so the pod-lifecycle module can
       * inspect the progress phase without reaching into the pie's internals.
       * @type {Map<string, unknown>}
       */
      const active = ctx.store?.progressingDownloads instanceof Map
        ? ctx.store.progressingDownloads
        : new Map();
      /** @type {WeakMap<object, string>} Track the last key assigned to each Download ref so we can rekey in place when target.path arrives mid-download. */
      const keyByDownload = new WeakMap();

      let root = null;
      let progressCircle = null;
      let indeterminateGroup = null;
      /** @type {HTMLElement|null} clone of Zen's arc icon when arc node is removed */
      let pendingArcIconClone = null;

      let pieRevealed = false;
      let arcMutationObserver = null;
      let arcFallbackTimerId = null;
      /** @type {ReturnType<typeof setTimeout>|null} */
      let postArcPieDelayId = null;
      /** @type {Array<() => void>} Resolvers waiting for the arc animation to finish. */
      const arcDoneWaiters = [];

      function isFeatureEnabled() {
        try {
          return getPref(PREF_ENABLE, true) !== false;
        } catch (e) {
          return true;
        }
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
        if (postArcPieDelayId) {
          clearTimeout(postArcPieDelayId);
          postArcPieDelayId = null;
        }
      }

      function flushArcDoneWaiters() {
        const waiters = arcDoneWaiters.splice(0, arcDoneWaiters.length);
        for (const resolve of waiters) {
          try { resolve(); } catch (_e) {}
        }
      }

      function onArcRemovedOrTimeout() {
        teardownArcWatcher();
        postArcPieDelayId = setTimeout(() => {
          postArcPieDelayId = null;
          // Only mark the pie as "revealed" if there is still an active
          // download it would reveal FOR. Otherwise (fast download that
          // terminated while the arc was still flying) we must leave
          // pieRevealed=false so the NEXT download re-arms the arc watcher
          // instead of skipping it and popping the pie over the fresh arc.
          if (active.size > 0) {
            pieRevealed = true;
            updateVisual();
          } else {
            pieRevealed = false;
          }
          flushArcDoneWaiters();
        }, POST_ARC_PIE_DELAY_MS);
      }

      /**
       * Returns true if Zen's flying arc animation node is currently present
       * in the shadow root — i.e. the download-start animation is still playing.
       */
      function isArcAnimationActive() {
        try {
          const host = document.querySelector("zen-download-animation");
          const sr = host?.shadowRoot;
          if (!sr) return false;
          return !!sr.querySelector(".zen-download-arc-animation");
        } catch (_e) {
          return false;
        }
      }

      /**
       * Resolve when the arc animation node leaves the shadow root (or
       * immediately if it isn't currently playing). Used by the lifecycle to
       * defer pod creation on very fast downloads that terminate before the
       * arc finishes flying.
       * @returns {Promise<void>}
       */
      function waitForArcDone() {
        if (!isArcAnimationActive()) return Promise.resolve();
        return new Promise((resolve) => {
          arcDoneWaiters.push(resolve);
          // Arm the watcher in case there is no active download right now
          // (pie may already have torn it down after syncDownload removed
          // the only entry on terminal state).
          if (!arcMutationObserver && !arcFallbackTimerId) {
            beginWaitForArcThenReveal();
          }
        });
      }

      /**
       * Wait for Zen's flying arc node to leave the shadow root, then reveal the pie.
       * Timing only - we keep this so the pie appears at the same familiar moment
       * (arc flight complete), even though the pie itself no longer lives at the
       * toolbar button.
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

      /**
       * Build the pie element and append it to the pods-row container as the
       * first (leading) flex child. Leading position means in-progress activity
       * surfaces on the side closest to the library button, and completed pods
       * stack after it.
       */
      function ensureDom() {
        if (root && root.isConnected) return;

        const podsRow = getPodsRowContainer();
        if (!podsRow) {
          debugLog("[LibraryPie] pods-row container not ready; deferring DOM creation");
          return;
        }

        if (!root) {
          const NS = "http://www.w3.org/2000/svg";
          root = document.createElement("div");
          root.id = "zen-tidy-download-pie-host";
          root.className = "zen-tidy-pie-host";
          root.setAttribute("role", "presentation");

          const svg = document.createElementNS(NS, "svg");
          svg.setAttribute("width", String(PIE.svgPx));
          svg.setAttribute("height", String(PIE.svgPx));
          svg.setAttribute("viewBox", "0 0 32 32");
          svg.classList.add("zen-tidy-pie-ring-svg");

          const cx = String(PIE.cx);
          const cy = String(PIE.cy);
          const r = String(PIE.r);
          const sw = String(PIE.stroke);

          const trackCircle = document.createElementNS(NS, "circle");
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

          // Same inner-circle + icon structure as Zen's arc widget, so the pie
          // looks like the arc landed and is now spinning progress around it.
          const inner = document.createElement("div");
          inner.className = "zen-download-arc-animation-inner-circle";
          /** @type {HTMLElement} */
          let iconEl;
          if (pendingArcIconClone) {
            iconEl = pendingArcIconClone;
            pendingArcIconClone = null;
            iconEl.setAttribute("aria-hidden", "true");
          } else {
            iconEl = document.createElement("div");
            iconEl.className = "zen-download-arc-animation-icon";
            iconEl.setAttribute("aria-hidden", "true");
          }
          inner.appendChild(iconEl);
          root.appendChild(inner);
        }

        // Always (re)insert at the leading edge of the pods row.
        if (root.parentNode !== podsRow) {
          podsRow.insertBefore(root, podsRow.firstChild);
        } else if (podsRow.firstChild !== root) {
          podsRow.insertBefore(root, podsRow.firstChild);
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

        ensureDom();
        if (!root) return;

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

        const wasHidden = root.style.display !== "flex";
        root.style.display = "flex";
        if (wasHidden) {
          root.classList.remove("zen-tidy-pie-pop-in");
          requestAnimationFrame(() => {
            root.classList.add("zen-tidy-pie-pop-in");
            const onEnd = () => {
              root.classList.remove("zen-tidy-pie-pop-in");
            };
            root.addEventListener("animationend", onEnd, { once: true });
            setTimeout(onEnd, 700);
          });
        }
        refreshContainerVisibility();
      }

      function syncDownload(dl, removed = false) {
        if (!dl) return;
        const key = resolveKey(dl) || fallbackKeyForDownload(dl);
        if (!key) return;

        // If this Download ref was previously tracked under a different key
        // (temp_url_startTime → real target.path after succeeded), migrate the
        // entry in place so we don't leave a stale key behind.
        const priorKey = keyByDownload.get(dl);
        if (priorKey && priorKey !== key && active.has(priorKey)) {
          active.delete(priorKey);
        }

        if (removed || dl.succeeded || dl.error || dl.canceled) {
          active.delete(key);
          keyByDownload.delete(dl);
        } else {
          active.set(key, dl);
          keyByDownload.set(dl, key);
        }

        if (active.size === 0) {
          pieRevealed = false;
          // Only tear down the arc watcher if the arc is no longer playing —
          // otherwise fast downloads that terminate mid-flight would lose
          // their waitForArcDone() notification.
          if (!isArcAnimationActive()) {
            teardownArcWatcher();
            flushArcDoneWaiters();
          }
          if (root) root.style.display = "none";
          refreshContainerVisibility();
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
        flushArcDoneWaiters();
        active.clear();
        pieRevealed = false;
        pendingArcIconClone = null;
        if (root?.parentNode) {
          root.parentNode.removeChild(root);
        }
        root = null;
        progressCircle = null;
        indeterminateGroup = null;
      }

      return {
        /**
         * Feed a single download event into the pie. The unified downloads
         * listener calls this for every add/change/remove so the pie and the
         * pods pipeline share one event source.
         * @param {unknown} dl
         * @param {boolean} [removed] - true when the download was removed from the list
         */
        syncDownload(dl, removed = false) {
          syncDownload(dl, removed);
        },
        /**
         * Read-only snapshot of the pie's current visual position and icon,
         * used by the pod-handoff animator at the moment of transition from
         * "progress" to "live-pod". Returns null when the pie isn't
         * currently visible.
         * @returns {{ rect: DOMRect, iconClone: HTMLElement|null }|null}
         */
        captureHandoffSnapshot() {
          if (!root) return null;
          if (root.style.display === "none") return null;
          const rect = root.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) return null;
          let iconClone = null;
          const iconEl = root.querySelector(".zen-download-arc-animation-icon");
          if (iconEl instanceof HTMLElement) {
            iconClone = /** @type {HTMLElement} */ (iconEl.cloneNode(true));
          }
          return { rect, iconClone };
        },
        /**
         * Resolves when Zen's flying arc animation has finished (or immediately
         * if it isn't currently playing). The pod lifecycle uses this to delay
         * creating a live-pod on very fast downloads so the pod doesn't pop in
         * on top of the arc.
         * @returns {Promise<void>}
         */
        waitForArcDone() {
          return waitForArcDone();
        },
        destroy
      };
    }
  };

  console.log("[Zen Tidy Downloads] Library pie module loaded");
})();
