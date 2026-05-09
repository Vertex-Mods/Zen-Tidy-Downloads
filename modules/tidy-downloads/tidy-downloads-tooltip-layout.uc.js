// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-tooltip-layout.uc.js
// Master tooltip content + jukebox pod layout / animations
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  window.zenTidyDownloadsTooltipLayout = {
    /**
     * @param {Object} ctx
     * @param {Object} ctx.store
     * @param {function} ctx.getPref
     * @param {function} ctx.debugLog
     * @param {function} ctx.formatBytes
     * @param {Object} ctx.previewApi
     * @param {function} ctx.getMasterTooltip
     * @param {function} ctx.getPodsRowContainer
     * @param {function} ctx.getDownloadCardsContainer
     * @param {function} ctx.updateDownloadCardsVisibility
     */
    init(ctx) {
      const {
        store,
        getPref,
        debugLog,
        formatBytes,
        previewApi,
        getMasterTooltip,
        getPodsRowContainer,
        getDownloadCardsContainer,
        updateDownloadCardsVisibility
      } = ctx;

      const { activeDownloadCards, focusedKeyRef, orderedPodKeys } = store;
      let pendingZeroWidthLayoutRetry = false;

      let _cachedTooltipEls = null;
      let _cachedTooltipRoot = null;
      function getTooltipElements(tooltipDom) {
        if (_cachedTooltipRoot === tooltipDom && _cachedTooltipEls) return _cachedTooltipEls;
        _cachedTooltipRoot = tooltipDom;
        _cachedTooltipEls = {
          titleEl: tooltipDom.querySelector(".card-title"),
          statusEl: tooltipDom.querySelector(".card-status"),
          progressEl: tooltipDom.querySelector(".card-progress"),
          originalFilenameEl: tooltipDom.querySelector(".card-original-filename"),
          undoBtnEl: tooltipDom.querySelector(".card-undo-button"),
          sparkleLayer: tooltipDom.querySelector(".ai-sparkle-layer"),
          fileSizeEl: tooltipDom.querySelector(".card-filesize")
        };
        return _cachedTooltipEls;
      }

      /**
       * Master tooltip is only shown after a successful on-disk AI rename
       * (`download.aiName` set). Progress pods never get the tooltip.
       * @param {{ phase?: string, podElement?: HTMLElement|null }|null|undefined} cardData
       * @param {{ succeeded?: boolean, aiName?: string|null }|null|undefined} download
       * @returns {boolean}
       */
      function shouldShowMasterRenameTooltip(cardData, download) {
        if (!cardData?.podElement || !download) return false;
        const isProgress =
          cardData.phase === "progress" ||
          cardData.podElement.dataset?.state === "progress";
        if (isProgress) return false;
        return !!(download.succeeded && download.aiName);
      }

      /**
       * True if any toolbar sticky still has post–AI-rename success state (`aiName`), used when
       * `orderedPodKeys` is empty so we do not collapse the master tooltip only because `focusedKeyRef` lags.
       * @returns {boolean}
       */
      function anyStickyNeedsRenameSuccessTooltip() {
        const sticky = store.stickyPods;
        if (!(sticky instanceof Set) || sticky.size === 0) return false;
        for (const sk of sticky) {
          const cd = activeDownloadCards.get(sk);
          if (!cd || cd.isBeingRemoved) continue;
          if (shouldShowMasterRenameTooltip(cd, cd.download)) return true;
        }
        return false;
      }

      const MASTER_TOOLTIP_FADEOUT_MS = window.zenTidyDownloadsUtils.MASTER_TOOLTIP_FADEOUT_MS;

      /**
       * Hard-hide rename tooltip chrome (instant). Use when swapping focus/UI state — not for user-dismiss.
       * @param {HTMLElement} masterTooltipDOMElement
       * @param {HTMLElement|null|undefined} downloadCardsContainer
       */
      function hideMasterTooltipChrome(masterTooltipDOMElement, downloadCardsContainer) {
        store.masterRenameTooltipSuppressed = true;
        store.pileHoverBlockedByRenameTooltip = false;
        store.masterTooltipFadeoutActive = false;
        masterTooltipDOMElement.style.display = "none";
        masterTooltipDOMElement.style.opacity = "0";
        masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
        masterTooltipDOMElement.style.pointerEvents = "none";
        masterTooltipDOMElement.style.visibility = "hidden";
        if (downloadCardsContainer) {
          downloadCardsContainer.style.display = "none";
          downloadCardsContainer.style.opacity = "0";
          downloadCardsContainer.style.visibility = "hidden";
          downloadCardsContainer.style.pointerEvents = "none";
        }
      }

      /**
       * Fade out tooltip then finalize hide. Caller must guard against re-entrancy.
       * @param {HTMLElement} masterTooltipDOMElement
       * @param {HTMLElement|null|undefined} downloadCardsContainer
       */
      function hideMasterTooltipChromeWithFade(masterTooltipDOMElement, downloadCardsContainer) {
        const tooltipPainted = (() => {
          const cs = window.getComputedStyle(masterTooltipDOMElement);
          return (
            cs.display !== "none" &&
            cs.visibility !== "hidden" &&
            parseFloat(cs.opacity) > 0.01
          );
        })();
        const cardsPainted =
          !!downloadCardsContainer &&
          (() => {
            const cs = window.getComputedStyle(downloadCardsContainer);
            return (
              cs.display !== "none" &&
              cs.visibility !== "hidden" &&
              parseFloat(cs.opacity) > 0.01
            );
          })();
        // Pile expand calls dismissMasterRenameTooltip even when no rename tooltip is
        // visible (e.g. in-progress download). Without this guard, we set
        // masterTooltipFadeoutActive and compact-visibility forces
        // #userchrome-download-cards-container to display:flex for 450ms — a visible flash.
        if (!tooltipPainted && !cardsPainted) {
          hideMasterTooltipChrome(masterTooltipDOMElement, downloadCardsContainer);
          return;
        }

        store.masterRenameTooltipSuppressed = true;
        store.pileHoverBlockedByRenameTooltip = false;
        const sharedFade = window.zenTidyDownloadsUtils?.runMasterTooltipFade;
        if (typeof sharedFade === "function") {
          sharedFade({
            store,
            masterTooltipDOMElement,
            downloadCardsContainer,
            beginFade: (container) => {
              store.masterTooltipFadeoutActive = true;
              if (container) container.style.pointerEvents = "none";
            },
            collapseContainer: () => {
              store.masterTooltipFadeoutActive = false;
              hideMasterTooltipChrome(masterTooltipDOMElement, downloadCardsContainer);
            }
          });
          return;
        }
        store.masterTooltipFadeoutActive = true;
        masterTooltipDOMElement.style.opacity = "0";
        masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
        masterTooltipDOMElement.style.pointerEvents = "none";
        if (downloadCardsContainer) {
          downloadCardsContainer.style.pointerEvents = "none";
        }
        window.setTimeout(() => {
          store.masterTooltipFadeoutActive = false;
          if (store.masterRenameTooltipSuppressed === false) return;
          hideMasterTooltipChrome(masterTooltipDOMElement, downloadCardsContainer);
        }, MASTER_TOOLTIP_FADEOUT_MS);
      }

      function dismissMasterRenameTooltip() {
        const masterTooltipDOMElement = getMasterTooltip();
        const downloadCardsContainer = getDownloadCardsContainer();
        if (!masterTooltipDOMElement) return false;
        hideMasterTooltipChromeWithFade(masterTooltipDOMElement, downloadCardsContainer);
        updateDownloadCardsVisibility();
        window.setTimeout(() => {
          try {
            updateDownloadCardsVisibility();
          } catch (_e) {
            /* ignore */
          }
        }, MASTER_TOOLTIP_FADEOUT_MS);
        return true;
      }

      function managePodVisibilityAndAnimations() {
            const masterTooltipDOMElement = getMasterTooltip();
            const podsRowContainerElement = getPodsRowContainer();
            const downloadCardsContainer = getDownloadCardsContainer();
        if (!masterTooltipDOMElement || !podsRowContainerElement) return;
        const podNominalWidth = 56;

        /**
         * Sticky pods normally stay in orderedPodKeys and use jukebox layout. This only
         * covers orphan stickies (e.g. rekey race) as plain flex items in the row.
         * @returns {boolean} true if at least one orphan sticky pod was laid out
         */
        function layoutStickyPodsOutsideJukebox() {
          const sticky = store.stickyPods;
          if (!(sticky instanceof Set) || sticky.size === 0) return false;
          let laidOut = false;
          for (const sk of sticky) {
            if (orderedPodKeys.includes(sk)) continue;
            const cd = activeDownloadCards.get(sk);
            if (!cd?.podElement || cd.isBeingRemoved) continue;
            laidOut = true;
            const el = cd.podElement;
            if (!el.parentNode && podsRowContainerElement) {
              podsRowContainerElement.appendChild(el);
              cd.domAppended = true;
            }
            el.style.position = "relative";
            el.style.display = "flex";
            el.style.opacity = "1";
            el.style.transform = "none";
            el.style.zIndex = "";
            el.style.marginRight = "";
            if (el.style.width === `${podNominalWidth}px`) {
              el.style.width = "";
            }
            cd.isVisible = true;
            cd.intendedTargetTransform = null;
            cd.intendedTargetOpacity = null;
          }
          return laidOut;
        }

        debugLog("[LayoutManager] managePodVisibilityAndAnimations Natural Stacking Style called.");
        debugLog(`[LayoutManager] Current state: orderedPodKeys=${orderedPodKeys.length}, focusedKey=${focusedKeyRef.current}, activeDownloadCards=${activeDownloadCards.size}`);

        if (orderedPodKeys.length === 0) {
            const progressing =
              store.progressingDownloads instanceof Map && store.progressingDownloads.size > 0;

            const cardForFocus = focusedKeyRef.current
              ? activeDownloadCards.get(focusedKeyRef.current)
              : null;
            const focusWantsRenameTooltip = shouldShowMasterRenameTooltip(
              cardForFocus,
              cardForFocus?.download
            );
            const keepRenameSuccessTooltip =
              !store.masterRenameTooltipSuppressed &&
              (focusWantsRenameTooltip || anyStickyNeedsRenameSuccessTooltip());

            if (!keepRenameSuccessTooltip) {
              if (!store.masterTooltipFadeoutActive) {
                // Collapse the master tooltip when nothing jukebox-focused needs it.
                // Sticky pods after AI rename keep the rename-success tooltip visible
                // even though orderedPodKeys is empty (see updateUIForFocusedDownload).
                masterTooltipDOMElement.style.display = "none";
                masterTooltipDOMElement.style.opacity = "0";
                masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
                masterTooltipDOMElement.style.pointerEvents = "none";
                masterTooltipDOMElement.style.visibility = "hidden";

                if (downloadCardsContainer) {
                  downloadCardsContainer.style.display = "none";
                  downloadCardsContainer.style.opacity = "0";
                  downloadCardsContainer.style.visibility = "hidden";
                  downloadCardsContainer.style.pointerEvents = "none";
                }
              } else {
                masterTooltipDOMElement.style.pointerEvents = "none";
                if (downloadCardsContainer) {
                  downloadCardsContainer.style.pointerEvents = "none";
                }
              }

              store.pileHoverBlockedByRenameTooltip = false;
            } else {
              store.pileHoverBlockedByRenameTooltip = !store.masterRenameTooltipSuppressed;
            }

            const hasStickyLayout = layoutStickyPodsOutsideJukebox();
            if (hasStickyLayout || progressing) {
              podsRowContainerElement.style.height = `${podNominalWidth}px`;
            } else {
              podsRowContainerElement.style.height = "0px";
            }
            podsRowContainerElement.style.gap = "0px";

            if (progressing) {
              // Pie-only: pods shell visible; cards container stays off-layout (compact-visibility).
              updateDownloadCardsVisibility();
              debugLog("[LayoutManager] Progress-only (pie, no pods): master tooltip hidden; pods shell only.");
            } else {
              updateDownloadCardsVisibility();
              debugLog("[LayoutManager] No jukebox pods — compact visibility (sticky and/or idle).");
            }

            debugLog(`[LayoutManager] Exiting: No OrderedPodKeys.`);
            return;
        }

        // Show the container when we have pods (respects compact mode via updateDownloadCardsVisibility)
        updateDownloadCardsVisibility();

        // Ensure focused key is valid and in orderedPodKeys, default to newest if not.
        if (!focusedKeyRef.current || !orderedPodKeys.includes(focusedKeyRef.current)) {
            if (orderedPodKeys.length > 0) {
              const newFocusKey = orderedPodKeys[orderedPodKeys.length - 1]; // Default to newest
                if (focusedKeyRef.current !== newFocusKey) {
                    focusedKeyRef.current = newFocusKey;
                    debugLog(`[LayoutManager] Focused key was invalid or missing, defaulted to newest: ${focusedKeyRef.current}`);
                }
            }
        }

        // Ensure all pods in orderedPodKeys are in the DOM and have initial styles for animation/layout.
        // Run before tooltip width check so pods are attached even when the master tooltip still measures 0 on first show.
        orderedPodKeys.forEach(key => {
            const cardData = activeDownloadCards.get(key);
            if (cardData && cardData.podElement && !cardData.isWaitingForZenAnimation) {
                if (!cardData.domAppended && podsRowContainerElement) {
                    podsRowContainerElement.appendChild(cardData.podElement);
                    cardData.domAppended = true;
                    debugLog(`[LayoutManager] Ensured pod ${key} is in DOM for Jukebox layout.`);
                }
                // Ensure consistent styling for all pods (in case they were created before layout manager)
                if (cardData.podElement.style.position !== 'absolute') {
                    cardData.podElement.style.position = 'absolute';
                    cardData.podElement.style.width = `${podNominalWidth}px`;
                    cardData.podElement.style.marginRight = '0px';
                    cardData.podElement.style.boxSizing = 'border-box';
                    if (!cardData.podElement.style.transition) {
                        cardData.podElement.style.transition = 
                            'opacity 0.4s ease-out, transform 0.5s cubic-bezier(0.68, -0.55, 0.27, 1.55), ' + 
                            'z-index 0.3s ease-out';
                    }
                    debugLog(`[LayoutManager] Updated pod ${key} styling for absolute positioning.`);
                }
            }
        });

        let tooltipWidth = masterTooltipDOMElement.offsetWidth;
        const tooltipCs = window.getComputedStyle(masterTooltipDOMElement);
        if (
          tooltipWidth === 0 &&
          orderedPodKeys.length > 0 &&
          (tooltipCs.display === "none" || masterTooltipDOMElement.style.display === "none")
        ) {
          tooltipWidth = 300;
          debugLog("[LayoutManager] Tooltip not in layout (display:none); using fallback width for jukebox.", {
            fallbackWidth: tooltipWidth
          });
        }

        const podOverlapAmount = 50;
        const baseZIndex = 10;
        const maxVisiblePodsInPile = Math.min(4, Math.floor((tooltipWidth - podNominalWidth) / (podNominalWidth - podOverlapAmount)) + 1);

        if (tooltipWidth === 0 && orderedPodKeys.length > 0) {
            debugLog("[LayoutManager] Master tooltip width is 0. Cannot manage pod layout yet.");
            if (podsRowContainerElement.style.height === '0px') {
                podsRowContainerElement.style.height = '56px';
            }
            if (!pendingZeroWidthLayoutRetry) {
                pendingZeroWidthLayoutRetry = true;
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        pendingZeroWidthLayoutRetry = false;
                        managePodVisibilityAndAnimations();
                    });
                });
            }
            return;
        }
        pendingZeroWidthLayoutRetry = false;

        let visiblePodsLayoutData = []; // Stores {key, x, zIndex, isFocused}
        const focusedIndexInOrdered = orderedPodKeys.indexOf(focusedKeyRef.current);

        if (focusedIndexInOrdered === -1 && orderedPodKeys.length > 0) {
            // This should not happen if the check above worked, but as a failsafe:
            debugLog(`[LayoutManager_ERROR] Focused key ${focusedKeyRef.current} not in ordered keys after all! Defaulting again.`);
            focusedKeyRef.current = orderedPodKeys[orderedPodKeys.length - 1];
            // updateUIForFocusedDownload(focusedKeyRef.current, false); // could loop; keep disabled
            // return; // Might be better to just proceed with the default for this frame
        }
        
        if (!focusedKeyRef.current) { // If still no focused key (e.g. orderedPodKeys became empty)
          debugLog("[LayoutManager] No focused key available, cannot proceed with jukebox layout.");
          // Potentially hide all pods if this state is reached unexpectedly.
          orderedPodKeys.forEach(key => {
            const cd = activeDownloadCards.get(key);
            if (cd && cd.podElement && cd.isVisible) {
              cd.podElement.style.opacity = '0';
              cd.podElement.style.transform = 'scale(0.8) translateX(-30px)';
              cd.isVisible = false;
            }
          });
          return;
        }

        // 1. Position the focused pod
        let currentX = 0;
        visiblePodsLayoutData.push({
            key: focusedKeyRef.current,
            x: currentX,
            zIndex: baseZIndex + orderedPodKeys.length + 1, // Highest Z
            isFocused: true
        });
        currentX += podNominalWidth - podOverlapAmount; // Next pod starts offset by (width - overlap)

        // 2. Position the pile pods to the right in reverse chronological order (natural stacking)
        // Create pile from newest to oldest, excluding the focused pod
        const pileKeys = orderedPodKeys.slice().reverse().filter(key => key !== focusedKeyRef.current);
        let pileCount = 0;
        
        for (let i = 0; i < pileKeys.length && pileCount < maxVisiblePodsInPile - 1; i++) {
            const podKeyInPile = pileKeys[i];

            if (currentX + podNominalWidth <= tooltipWidth + podOverlapAmount) { // Allow last one to partially show
                visiblePodsLayoutData.push({
                    key: podKeyInPile,
                    x: currentX,
                    zIndex: baseZIndex + pileKeys.length - i, // Decreasing Z (newest in pile has highest Z)
                    isFocused: false
                });
                currentX += (podNominalWidth - podOverlapAmount);
                pileCount++;
          } else {
                break; // No more space
            }
        }

        debugLog(`[LayoutManager_NaturalStack] Calculated layout for ${visiblePodsLayoutData.length} pods. Focused: ${focusedKeyRef.current}`, visiblePodsLayoutData);

        const layoutMap = new Map(visiblePodsLayoutData.map(p => [p.key, p]));

        // 3. Apply styles and animations
        orderedPodKeys.forEach(key => {
            const cardData = activeDownloadCards.get(key);
            if (!cardData || !cardData.podElement || !cardData.domAppended || cardData.isWaitingForZenAnimation || cardData.isBeingRemoved) {
                debugLog(`[LayoutManager_Jukebox_Skip] Skipping pod ${key}. Conditions: cardData=${!!cardData}, podElement=${!!cardData?.podElement}, domAppended=${cardData?.domAppended}, waitingZen=${cardData?.isWaitingForZenAnimation}, beingRemoved=${cardData?.isBeingRemoved}`);
                return;
            }
            if (cardData.phase === "deferred-sticky") {
                cardData.podElement.style.display = "none";
                cardData.isVisible = false;
                debugLog(`[LayoutManager_Jukebox_Skip] Pod ${key} is in deferred-sticky phase; keeping hidden.`);
                return;
            }
            if (!cardData.podElement.parentNode) {
                debugLog(`[LayoutManager_Jukebox_Skip] Pod ${key} not in DOM, skipping layout.`);
                return;
            }

            const podElement = cardData.podElement;
            const layoutData = layoutMap.get(key);

            if (cardData.suppressToolbarPodForAIRename) {
                // Keep the pod in the layout tree but let CSS supply the "from" state:
                //   .download-pod { opacity: 0; transform: scale(0.3) translateY(30px); transition: ... }
                // Clearing any inline opacity/transform lets CSS take over so that when suppression
                // lifts and the jukebox sets inline opacity:1 / scale(1), the CSS transition fires
                // from scale(0.3) — identical to a fresh non-AI pod appearance.
                podElement.style.display = 'flex';
                podElement.style.opacity = '';
                podElement.style.transform = '';
                podElement.style.pointerEvents = '';
                cardData.isVisible = false;
                debugLog(`[LayoutManager_Jukebox_Skip] Pod ${key} suppressToolbarPodForAIRename; parked via CSS from-state.`);
                return;
            }

            if (layoutData) {
                // This pod should be visible
                podElement.style.display = 'flex';
                podElement.style.zIndex = `${layoutData.zIndex}`;
                const targetTransform = `translateX(${layoutData.x}px) scale(1) translateY(0)`;
                const targetOpacity = layoutData.isFocused ? '1' : '0.75';

                // Only animate if intended state changes or if it's becoming visible
                if (
                    !cardData.isVisible ||
                    cardData.intendedTargetTransform !== targetTransform ||
                    cardData.intendedTargetOpacity !== targetOpacity
                ) {
                    debugLog(`[LayoutManager_Jukebox_Anim_Setup] Pod ${key}: Setting up IN/MOVE animation to X=${layoutData.x}, Opacity=${targetOpacity}. Prev IntendedTransform: ${cardData.intendedTargetTransform}, Prev Opacity: ${cardData.intendedTargetOpacity}, IsVisible: ${cardData.isVisible}`);
                    
                    // Apply directional entrance animation for newly focused pods during rotation
                    if (layoutData.isFocused && !cardData.isVisible && store.lastRotationDirection) {
                        const entranceTransform = `translateX(${layoutData.x + 80}px) scale(0.8) translateY(0)`;

                        podElement.style.transform = entranceTransform;
                        podElement.style.opacity = '0';

                        debugLog(
                            `[LayoutManager_DirectionalAnim] Pod ${key}: Starting ${store.lastRotationDirection} entrance from ${entranceTransform}`
                        );

                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                podElement.style.opacity = targetOpacity;
                                podElement.style.transform = targetTransform;
                                debugLog(`[LayoutManager_DirectionalAnim] Pod ${key}: Animating to final position ${targetTransform}`);
                            });
                        });
                    } else {
                        // Normal animation for non-focused pods or non-rotation scenarios (includes AI rename reveal)
                        requestAnimationFrame(() => {
                            podElement.style.opacity = targetOpacity;
                            podElement.style.transform = targetTransform;
                            debugLog(`[LayoutManager_Jukebox_Anim_Execute] Pod ${key}: Executing IN/MOVE to X=${layoutData.x}, Opacity=${targetOpacity}`);
                        });
                    }
                }
                cardData.intendedTargetTransform = targetTransform;
                cardData.intendedTargetOpacity = targetOpacity;
                cardData.isVisible = true;

                const fd = activeDownloadCards.get(key);
                const fdl = fd?.download;
                const showRenameTooltip = shouldShowMasterRenameTooltip(fd, fdl);

                if (
                  layoutData.isFocused &&
                  showRenameTooltip &&
                  !store.masterRenameTooltipSuppressed &&
                  masterTooltipDOMElement &&
                  masterTooltipDOMElement.style.opacity === '0'
                ) {
                     debugLog(`[LayoutManager_Jukebox_Tooltip] Focused pod ${key} (rename success) — animating tooltip IN.`);
                     setTimeout(() => {
                        if (focusedKeyRef.current !== key) return;
                        if (store.masterRenameTooltipSuppressed) return;
                        const fdNow = activeDownloadCards.get(key);
                        const fdlNow = fdNow?.download;
                        if (!shouldShowMasterRenameTooltip(fdNow, fdlNow)) return;
                        const dc = getDownloadCardsContainer();
                        if (dc) {
                          dc.style.display = "flex";
                          dc.style.opacity = "1";
                          dc.style.visibility = "visible";
                          /* Wrapper stays non-interactive so pods below (lower z-index) stay hoverable. */
                          dc.style.pointerEvents = "none";
                        }
                        masterTooltipDOMElement.style.visibility = "visible";
                        masterTooltipDOMElement.style.opacity = "1";
                        masterTooltipDOMElement.style.transform = "scaleY(1) translateY(0)";
                        masterTooltipDOMElement.style.pointerEvents = "auto";
                        store.pileHoverBlockedByRenameTooltip = true;
                    }, 100);
                }
            } else {
                // This pod should be hidden or moved to pile
                if (cardData.isVisible || podElement.style.opacity !== '0') {
                    debugLog(`[LayoutManager_Jukebox_Anim_OUT] Pod ${key}`);
                    
                    const targetTransformOut = store.lastRotationDirection
                        ? 'scale(0.8) translateX(-60px)'
                        : 'scale(0.8) translateX(-30px)';
                    
                    if (cardData.intendedTargetTransform !== targetTransformOut || cardData.intendedTargetOpacity !== '0') {
                        podElement.style.opacity = '0';
                        podElement.style.transform = targetTransformOut;
                        debugLog(`[LayoutManager_DirectionalExit] Pod ${key}: Exiting with ${store.lastRotationDirection || 'default'} animation: ${targetTransformOut}`);
                    }
                    cardData.intendedTargetTransform = targetTransformOut;
                    cardData.intendedTargetOpacity = '0';
                }
                cardData.isVisible = false;
            }
        });

        const hasStickyOutsideJukebox = layoutStickyPodsOutsideJukebox();

        // Set container height dynamically based on whether any pods are visible
        // This is important as pods are position:absolute now.
        if (visiblePodsLayoutData.length > 0 || hasStickyOutsideJukebox) {
            podsRowContainerElement.style.height = `${podNominalWidth}px`; // Set to pod height
          } else {
            podsRowContainerElement.style.height = '0px';
        }

          debugLog(`[LayoutManager_NaturalStack] Finished. Visible pods: ${visiblePodsLayoutData.map(p => p.key).join(", ")}`);
        
        // Reset rotation direction after animations are set up
        if (store.lastRotationDirection) {
            setTimeout(() => {
                store.lastRotationDirection = null;
                debugLog(`[LayoutManager] Reset rotation direction after animation`);
            }, 100); // Small delay to ensure animations start before reset
        }
      }

      function updateUIForFocusedDownload(keyToFocus, isNewOrSignificantUpdate = false) {
            const masterTooltipDOMElement = getMasterTooltip();
        const now = Date.now();
        const isFinalStateUpdateCandidate = (() => {
          const cd = keyToFocus ? activeDownloadCards.get(keyToFocus) : null;
          const dl = cd && cd.download;
          return !!dl && (dl.succeeded || dl.error);
        })();

        const shouldForceLayout = isNewOrSignificantUpdate || isFinalStateUpdateCandidate;
        const enoughTimeElapsedForLayout =
          (now - store.lastUIUpdateTime) >= store.MIN_UI_UPDATE_INTERVAL_MS;

        if (!shouldForceLayout && !enoughTimeElapsedForLayout) {
          debugLog(`[UIUPDATE_SKIP] Skipping UI update/layout for ${keyToFocus} to avoid layout storm.`);
          return;
        }

        store.lastUIUpdateTime = now;

        debugLog(`[UIUPDATE_TOP] updateUIForFocusedDownload called. keyToFocus: ${keyToFocus}, isNewOrSignificantUpdate: ${isNewOrSignificantUpdate}, current focused key: ${focusedKeyRef.current}`);
        
        const oldFocusedKey = focusedKeyRef.current;
        focusedKeyRef.current = keyToFocus; 
        debugLog(`[UIUPDATE_FOCUS_SET] focused key is NOW: ${focusedKeyRef.current}`);

        const cardDataToFocus = focusedKeyRef.current ? activeDownloadCards.get(focusedKeyRef.current) : null;

        if (!masterTooltipDOMElement) {
            debugLog("[UIUPDATE_ERROR] Master tooltip DOM element not found. Cannot update UI.");
            return; // Critical error, cannot proceed
        }

        const downloadCardsContainer = getDownloadCardsContainer();

        if (!cardDataToFocus || !cardDataToFocus.podElement) {
          debugLog(`[UIUPDATE_NO_CARD_DATA] No card data or podElement for key ${focusedKeyRef.current}. Hiding master tooltip. CardData:`, cardDataToFocus);
          store.masterRenameTooltipSuppressed = true;
          store.pileHoverBlockedByRenameTooltip = false;
          if (!store.masterTooltipFadeoutActive) {
            if (downloadCardsContainer) {
              downloadCardsContainer.style.display = "none";
              downloadCardsContainer.style.opacity = "0";
              downloadCardsContainer.style.visibility = "hidden";
              downloadCardsContainer.style.pointerEvents = "none";
            }
            masterTooltipDOMElement.style.display = "none";
            masterTooltipDOMElement.style.opacity = "0";
            masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
            masterTooltipDOMElement.style.pointerEvents = "none";
            masterTooltipDOMElement.style.visibility = "hidden";
          }
        } else {
          const download = cardDataToFocus.download;
          const showRenameTooltip = shouldShowMasterRenameTooltip(cardDataToFocus, download);

          if (!showRenameTooltip) {
            debugLog(
              `[UIUPDATE_TOOLTIP_SUPPRESSED] Master tooltip only after AI rename success; hidden for ${focusedKeyRef.current}.`,
              { hasDownload: !!download, aiName: !!download?.aiName, succeeded: download?.succeeded }
            );
            const cs = window.getComputedStyle(masterTooltipDOMElement);
            const tooltipIsPainted =
              cs.display !== "none" &&
              cs.visibility !== "hidden" &&
              parseFloat(cs.opacity) > 0.01;
            if (tooltipIsPainted && !store.masterTooltipFadeoutActive) {
              hideMasterTooltipChromeWithFade(masterTooltipDOMElement, downloadCardsContainer);
              updateDownloadCardsVisibility();
              window.setTimeout(() => {
                try {
                  updateDownloadCardsVisibility();
                } catch (_e) {
                  /* ignore */
                }
              }, MASTER_TOOLTIP_FADEOUT_MS);
            } else {
              hideMasterTooltipChrome(masterTooltipDOMElement, downloadCardsContainer);
            }
          } else if (download) {
            store.masterRenameTooltipSuppressed = false;
            if (downloadCardsContainer) {
              downloadCardsContainer.style.display = "flex";
              downloadCardsContainer.style.opacity = "1";
              downloadCardsContainer.style.visibility = "visible";
              /* Full-width wrapper sits above pods (z-index); must not capture pointer events. */
              downloadCardsContainer.style.pointerEvents = "none";
            }
            masterTooltipDOMElement.style.display = "flex";
            masterTooltipDOMElement.style.visibility = "visible";
            store.pileHoverBlockedByRenameTooltip = true;

            const needsRenameTooltipEntranceAnim =
              oldFocusedKey !== focusedKeyRef.current || isNewOrSignificantUpdate;
            if (needsRenameTooltipEntranceAnim) {
              debugLog(
                `[UIUPDATE_TOOLTIP_RESET] Focus changed or significant update. Resetting tooltip for animation for ${focusedKeyRef.current}. Old focus: ${oldFocusedKey}`
              );
              masterTooltipDOMElement.style.opacity = "0";
              masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
              masterTooltipDOMElement.style.pointerEvents = "none";
            } else {
              masterTooltipDOMElement.style.opacity = "1";
              masterTooltipDOMElement.style.transform = "scaleY(1) translateY(0)";
              masterTooltipDOMElement.style.pointerEvents = "auto";
            }

            const { titleEl, statusEl, progressEl, originalFilenameEl, undoBtnEl, sparkleLayer, fileSizeEl: cachedFileSizeEl } =
              getTooltipElements(masterTooltipDOMElement);

            let displayName = download.aiName || cardDataToFocus.originalFilename || "File";
            if (download.target?.path) {
              try {
                const pathSeparator = download.target.path.includes("\\") ? "\\" : "/";
                const actualFilename = download.target.path.split(pathSeparator).pop();
                if (actualFilename && actualFilename !== displayName) {
                  displayName = actualFilename;
                }
              } catch (_e) {
                /* ignore */
              }
            }

            if (titleEl) {
              titleEl.textContent = displayName;
              titleEl.title = displayName;
            }

            if (statusEl && originalFilenameEl && progressEl && undoBtnEl) {
              let finalSize = download.currentBytes;
              if (!(typeof finalSize === "number" && finalSize > 0)) finalSize = download.totalBytes;
              const fileSizeText = formatBytes(finalSize || 0);

              statusEl.textContent = "Download renamed to:";
              if (cachedFileSizeEl) {
                cachedFileSizeEl.textContent = fileSizeText;
                cachedFileSizeEl.style.display = "block";
              }
              statusEl.style.color = "#a0a0a0";

              originalFilenameEl.textContent = cardDataToFocus.originalFilename;
              originalFilenameEl.title = cardDataToFocus.originalFilename;
              originalFilenameEl.style.display = "block";

              progressEl.style.display = "none";
              undoBtnEl.style.display = "inline-flex";

              if (sparkleLayer) {
                sparkleLayer.classList.add("visible");
              }
            }

            masterTooltipDOMElement.style.width = "100%";

            debugLog(
              `[AI Rename Status] ${keyToFocus}: tooltip shown (rename success), hasAiName=${!!download.aiName}`
            );

            if (needsRenameTooltipEntranceAnim) {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (focusedKeyRef.current !== keyToFocus) return;
                  if (store.masterRenameTooltipSuppressed) return;
                  const cdNow = activeDownloadCards.get(keyToFocus);
                  const dlNow = cdNow?.download;
                  if (!shouldShowMasterRenameTooltip(cdNow, dlNow)) return;
                  masterTooltipDOMElement.style.opacity = "1";
                  masterTooltipDOMElement.style.transform = "scaleY(1) translateY(0)";
                  masterTooltipDOMElement.style.pointerEvents = "auto";
                });
              });
            }
          } else {
            hideMasterTooltipChrome(masterTooltipDOMElement, downloadCardsContainer);
          }
        } // End of valid 'cardDataToFocus' and 'podElement' check

        // 4. Call managePodVisibilityAndAnimations (always call to ensure layout is correct)
        // Use a small delay to ensure DOM updates are processed
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                managePodVisibilityAndAnimations();
            });
        });

        // 6. Update which pod appears "focused" visually (this iterates all cards, safe to be here)
        activeDownloadCards.forEach(cd => {
            if (cd.podElement) {
                if (cd.key === focusedKeyRef.current) {
                    cd.podElement.classList.add('focused-pod');
                    
                    // Use dominant color if available, otherwise default blue
                    const dominantColor = cd.podElement.dataset.dominantColor;
                    if (dominantColor) {
                  previewApi.updatePodGlowColor(cd.podElement, dominantColor);
                    }
                } else {
                    cd.podElement.classList.remove('focused-pod');
                }
            }
        });
      }

      return {
        updateUIForFocusedDownload,
        managePodVisibilityAndAnimations,
        dismissMasterRenameTooltip
      };

    }
  };
})();
