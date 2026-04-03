// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-tooltip-layout.uc.js
// Master tooltip content + jukebox pod layout + wheel focus rotation
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
     * @param {function} [ctx.getAiRenamingPossible] - unused, kept for caller compat
     * @param {function} [ctx.addToAIRenameQueue] - unused, kept for caller compat
     * @param {function} [ctx.scheduleCardRemoval] - unused, kept for caller compat
     * @param {function} ctx.isInQueue
     * @param {function} ctx.updateQueueStatusInUI
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
        isInQueue,
        updateQueueStatusInUI,
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

      function managePodVisibilityAndAnimations() {
            const masterTooltipDOMElement = getMasterTooltip();
            const podsRowContainerElement = getPodsRowContainer();
            const downloadCardsContainer = getDownloadCardsContainer();
        if (!masterTooltipDOMElement || !podsRowContainerElement) return;
        debugLog("[LayoutManager] managePodVisibilityAndAnimations Natural Stacking Style called.");
        debugLog(`[LayoutManager] Current state: orderedPodKeys=${orderedPodKeys.length}, focusedKey=${focusedKeyRef.current}, activeDownloadCards=${activeDownloadCards.size}`);

        if (orderedPodKeys.length === 0) {
            // Hide the entire container when no pods exist
            if (downloadCardsContainer) {
                downloadCardsContainer.style.display = "none";
                downloadCardsContainer.style.opacity = "0";
                downloadCardsContainer.style.visibility = "hidden";
            }
            
            if (masterTooltipDOMElement.style.opacity !== "0") {
                debugLog("[LayoutManager] No pods, ensuring master tooltip is hidden.");
                masterTooltipDOMElement.style.opacity = "0";
                masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
                masterTooltipDOMElement.style.pointerEvents = "none";
                setTimeout(() => { 
                    if (masterTooltipDOMElement.style.opacity === "0") masterTooltipDOMElement.style.display = "none";
                }, 300);
            }
            debugLog(`[LayoutManager] Exiting: No OrderedPodKeys.`);
            podsRowContainerElement.style.gap = '0px'; // Reset gap just in case
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

        const podNominalWidth = 56;

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

        const tooltipWidth = masterTooltipDOMElement.offsetWidth;
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

            if (!cardData.podElement.parentNode) {
                debugLog(`[LayoutManager_Jukebox_Skip] Pod ${key} not in DOM, skipping layout.`);
                return;
            }

            const podElement = cardData.podElement;
            const layoutData = layoutMap.get(key);

            if (layoutData) {
                // This pod should be visible
                podElement.style.display = 'flex';
                podElement.style.zIndex = `${layoutData.zIndex}`;
                const targetTransform = `translateX(${layoutData.x}px) scale(1) translateY(0)`;
                const targetOpacity = layoutData.isFocused ? '1' : '0.75';
                const forceStickyEntrance =
                  layoutData.isFocused && cardData.needsStickyEntranceReveal === true;

                // Only animate if intended state changes or if it's becoming visible
                if (
                    !cardData.isVisible ||
                    cardData.intendedTargetTransform !== targetTransform ||
                    cardData.intendedTargetOpacity !== targetOpacity ||
                    forceStickyEntrance
                ) {
                    debugLog(`[LayoutManager_Jukebox_Anim_Setup] Pod ${key}: Setting up IN/MOVE animation to X=${layoutData.x}, Opacity=${targetOpacity}. Prev IntendedTransform: ${cardData.intendedTargetTransform}, Prev Opacity: ${cardData.intendedTargetOpacity}, IsVisible: ${cardData.isVisible}, forceStickyEntrance: ${forceStickyEntrance}`);
                    
                    // Apply directional entrance animation for newly focused pods during rotation
                    if (layoutData.isFocused && !cardData.isVisible && store.lastRotationDirection) {
                        const entranceTransform = `translateX(${layoutData.x + 80}px) scale(0.8) translateY(0)`;
                        
                        // Set initial position for entrance animation
                        podElement.style.transform = entranceTransform;
                        podElement.style.opacity = '0';
                        
                        debugLog(`[LayoutManager_DirectionalAnim] Pod ${key}: Starting ${store.lastRotationDirection} entrance from ${entranceTransform}`);
                        
                        // Animate to final position
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                podElement.style.opacity = targetOpacity;
                                podElement.style.transform = targetTransform;
                                debugLog(`[LayoutManager_DirectionalAnim] Pod ${key}: Animating to final position ${targetTransform}`);
                            });
                        });
                    } else if (forceStickyEntrance) {
                        // Download finished while this pod was already laid out during progress — target matches so the
                        // branch above would skip; replay a proper entrance (same motion as pile rotation).
                        cardData.needsStickyEntranceReveal = false;
                        const entranceTransform = `translateX(${layoutData.x + 80}px) scale(0.8) translateY(0)`;
                        if (!podElement.style.transition) {
                            podElement.style.transition =
                                "opacity 0.4s ease-out, transform 0.5s cubic-bezier(0.68, -0.55, 0.27, 1.55), z-index 0.3s ease-out";
                        }
                        podElement.style.willChange = "opacity, transform";
                        podElement.style.transform = entranceTransform;
                        podElement.style.opacity = "0";
                        // Force the entrance frame to commit before we animate to final state.
                        // Without this, first-startup completion can batch styles and skip the transition.
                        void podElement.offsetWidth;
                        debugLog(`[LayoutManager_StickyEntrance] Pod ${key}: Completion entrance from ${entranceTransform}`);
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                podElement.style.opacity = targetOpacity;
                                podElement.style.transform = targetTransform;
                                debugLog(`[LayoutManager_StickyEntrance] Pod ${key}: Animating to ${targetTransform}`);
                                setTimeout(() => {
                                    if (podElement && podElement.isConnected) {
                                        podElement.style.willChange = "";
                                    }
                                }, 500);
                            });
                        });
                    } else {
                        // Normal animation for non-focused pods or non-rotation scenarios
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

                // Tooltip animation for focused pod
                if (layoutData.isFocused && masterTooltipDOMElement && masterTooltipDOMElement.style.opacity === '0') {
                     // Pod is focused and tooltip is currently hidden, animate tooltip IN.
                     // This relies on updateUIForFocusedDownload having set the initial opacity/transform if focus changed.
                     debugLog(`[LayoutManager_Jukebox_Tooltip] Focused pod ${key} is visible/animating, and tooltip is hidden. Animating tooltip IN.`);
                     setTimeout(() => { 
                        masterTooltipDOMElement.style.opacity = "1";
                        masterTooltipDOMElement.style.transform = "scaleY(1) translateY(0)";
                        masterTooltipDOMElement.style.pointerEvents = "auto"; // Enable interactions when visible
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
        
        // Set container height dynamically based on whether any pods are visible
        // This is important as pods are position:absolute now.
        if (visiblePodsLayoutData.length > 0) {
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

        if (!cardDataToFocus || !cardDataToFocus.podElement) {
          debugLog(`[UIUPDATE_NO_CARD_DATA] No card data or podElement for key ${focusedKeyRef.current}. Hiding master tooltip. CardData:`, cardDataToFocus);
          masterTooltipDOMElement.style.opacity = "0";
          masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
          masterTooltipDOMElement.style.pointerEvents = "none";
        } else {
          // cardDataToFocus and podElement are valid, proceed with UI updates for tooltip and AI.
          masterTooltipDOMElement.style.display = "flex"; 

          if (oldFocusedKey !== focusedKeyRef.current || isNewOrSignificantUpdate) {
              debugLog(`[UIUPDATE_TOOLTIP_RESET] Focus changed or significant update. Resetting tooltip for animation for ${focusedKeyRef.current}. Old focus: ${oldFocusedKey}`);
              masterTooltipDOMElement.style.opacity = "0"; 
              masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
              masterTooltipDOMElement.style.pointerEvents = "none";
          }

          const download = cardDataToFocus.download; 
          const podElement = cardDataToFocus.podElement; 

          if (!download) {
            debugLog(`[UIUPDATE_ERROR] cardDataToFocus for key ${focusedKeyRef.current} is valid, but its .download property is undefined. Cannot update tooltip content or AI.`);
            // Keep tooltip hidden or show a generic error if it was supposed to be visible
            if (masterTooltipDOMElement.style.opacity !== '0') {
                 masterTooltipDOMElement.style.opacity = "0";
                 masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
                 masterTooltipDOMElement.style.pointerEvents = "none";
            }
          } else {
            // Both cardDataToFocus, podElement, AND download object are valid. Proceed with detailed updates.
            // Completion side effects (AI queue, scheduleCardRemoval, preview) are handled by
            // tidy-downloads-pods.uc.js — this module only updates the tooltip display state.

            // 1. Update masterTooltipDOMElement content
            const { titleEl, statusEl, progressEl, originalFilenameEl, undoBtnEl, sparkleLayer, fileSizeEl: cachedFileSizeEl } =
              getTooltipElements(masterTooltipDOMElement);

            // Derive display name from actual file path if possible to catch OS renames (e.g. file(1).jpg)
            let displayName = download.aiName || cardDataToFocus.originalFilename || "File";
            // Always attempt to get the actual filename from disk, even if AI renamed it.
            // If AI renamed it to "foo.jpg" but OS made it "foo(1).jpg", we want "foo(1).jpg".
            if (download.target?.path) {
                try {
                    const pathSeparator = download.target.path.includes('\\') ? '\\' : '/';
                    const actualFilename = download.target.path.split(pathSeparator).pop();
                    // We prefer the actual filename if it exists and differs from what we thought
                    if (actualFilename && actualFilename !== displayName) {
                         // If it was AI renamed, we might want to check if the actual filename contains the AI name
                         // But generally, the file on disk is the ultimate truth.
                        displayName = actualFilename;
                    }
                } catch (e) {
                    // Fallback
                }
            }
            
            if (titleEl) {
              titleEl.textContent = displayName;
              titleEl.title = displayName;
            }

            if (statusEl && originalFilenameEl && progressEl && undoBtnEl) { // Include undoBtnEl in the check
                if (download.aiName && download.succeeded) {
                    // AI Renamed State
                    let finalSize = download.currentBytes;
                    if (!(typeof finalSize === 'number' && finalSize > 0)) finalSize = download.totalBytes;
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
                    undoBtnEl.style.display = "inline-flex"; // Show undo button
                    
                    // Show sparkles
                    if (sparkleLayer) {
                      sparkleLayer.classList.add("visible");
                    }
                } else {
                    // Default states (completed, error) - tooltip only shows after completion
                    originalFilenameEl.style.display = "none"; 
                    progressEl.style.display = "block";    
                    undoBtnEl.style.display = "none"; // Hide undo button
                    
                    // Hide sparkles
                    if (sparkleLayer) {
                      sparkleLayer.classList.remove("visible");
                    }
                    
                    if (cachedFileSizeEl) cachedFileSizeEl.style.display = "none";
                    
                    // Reset undo button to original undo icon and title
                    undoBtnEl.title = "Undo Rename";
                    const svgIcon = undoBtnEl.querySelector("svg");
                    if (svgIcon) {
                        const pathIcon = svgIcon.querySelector("path");
                        if (pathIcon) {
                            pathIcon.setAttribute("d", "M30.3,12.6c10.4,0,18.9,8.4,18.9,18.9s-8.5,18.9-18.9,18.9h-8.2c-0.8,0-1.3-0.6-1.3-1.4v-3.2c0-0.8,0.6-1.5,1.4-1.5h8.1c7.1,0,12.8-5.7,12.8-12.8s-5.7-12.8-12.8-12.8H16.4c0,0-0.8,0-1.1,0.1c-0.8,0.4-0.6,1,0.1,1.7l4.9,4.9c0.6,0.6,0.5,1.5-0.1,2.1L18,29.7c-0.6,0.6-1.3,0.6-1.9,0.1l-13-13c-0.5-0.5-0.5-1.3,0-1.8L16,2.1c0.6-0.6,1.6-0.6,2.1,0l2.1,2.1c0.6,0.6,0.6,1.6,0,2.1l-4.9,4.9c-0.6,0.6-0.6,1.3,0.4,1.3c0.3,0,0.7,0,0.7,0L30.3,12.6z");
                        }
                    }

                    if (download.error) {
                        statusEl.textContent = `Error: ${download.error.message || "Download failed"}`;
                        statusEl.style.color = "#ff6b6b";
                    } else {
                        statusEl.textContent = "Download completed";
                        statusEl.style.color = "#1dd1a1";
                    }
                }
            }

            if (progressEl) { // This block handles the content of progressEl when it's visible (completed states only)
                if (progressEl.style.display !== 'none') {
                    if (download.succeeded) {
                        let finalSize = download.currentBytes;
                        if (!(typeof finalSize === 'number' && finalSize > 0)) finalSize = download.totalBytes;
                        progressEl.textContent = `${formatBytes(finalSize || 0)}`;
                    } else {
                        let size = download.currentBytes || download.totalBytes;
                        progressEl.textContent = typeof size === 'number' && size > 0 ? formatBytes(size) : "";
                    }
                }
            }
            
            // Use 100% width - container already has padding
            masterTooltipDOMElement.style.width = '100%';

            // 5. Handle AI Renaming UI status - queue addition is handled in tidy-downloads-pods
            //    Here we just update the UI to reflect queue status
              const inQueueOrProcessing = isInQueue(keyToFocus);
            
              debugLog(`[AI Rename Status] ${keyToFocus}: inQueueOrProcessing=${inQueueOrProcessing}, succeeded=${download.succeeded}, hasAiName=${!!download.aiName}`);
            
            // Update UI to show queue status
              if (inQueueOrProcessing) {
              updateQueueStatusInUI(keyToFocus);
            }
          } // End of a valid 'download' object check
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

      function handlePodScrollFocus(event) {
        if (!orderedPodKeys || orderedPodKeys.length <= 1) return; // Need at least 2 pods to rotate

        event.preventDefault(); // Prevent page scroll
        event.stopPropagation();

        if (!focusedKeyRef.current || !orderedPodKeys.includes(focusedKeyRef.current)) {
          debugLog("[StackRotation] No valid focused key, cannot rotate stack");
          return;
        }

        // Get current stack arrangement: focused pod + pile in reverse chronological order
        const currentFocused = focusedKeyRef.current;
        const pileKeys = orderedPodKeys.slice().reverse().filter(key => key !== currentFocused);
        
        let newFocusedKey;

        if (event.deltaY > 0) {
          // Scroll DOWN: Current focused goes to END of pile, FIRST in pile becomes focused
          // Current: Pod D (focused) + [Pod C, Pod B, Pod A] (pile)
          // Result:  Pod C (focused) + [Pod B, Pod A, Pod D] (pile)
          
          if (pileKeys.length > 0) {
            newFocusedKey = pileKeys[0]; // First in pile becomes focused
            debugLog(`[StackRotation] Scroll DOWN: ${currentFocused} → end of pile, ${newFocusedKey} → focused`);
          }
          
        } else if (event.deltaY < 0) {
          // Scroll UP: Current focused goes to FRONT of pile, LAST in pile becomes focused  
          // Current: Pod D (focused) + [Pod C, Pod B, Pod A] (pile)
          // Result:  Pod A (focused) + [Pod D, Pod C, Pod B] (pile)
          
          if (pileKeys.length > 0) {
            newFocusedKey = pileKeys[pileKeys.length - 1]; // Last in pile becomes focused
            debugLog(`[StackRotation] Scroll UP: ${currentFocused} → front of pile, ${newFocusedKey} → focused`);
          }
        }

        // Apply the rotation by updating the orderedPodKeys array and focus
        if (newFocusedKey && newFocusedKey !== currentFocused) {
          // Remove the new focused key from its current position in orderedPodKeys
          const newFocusedIndex = orderedPodKeys.indexOf(newFocusedKey);
          if (newFocusedIndex > -1) {
            orderedPodKeys.splice(newFocusedIndex, 1);
          }
          
          // Remove the current focused key from its position
          const currentFocusedIndex = orderedPodKeys.indexOf(currentFocused);
          if (currentFocusedIndex > -1) {
            orderedPodKeys.splice(currentFocusedIndex, 1);
          }

          if (event.deltaY > 0) {
            // Scroll DOWN: new focused goes to end (newest position), current focused goes to beginning (oldest position)
            orderedPodKeys.unshift(currentFocused); // Add current focused to beginning (oldest)
            orderedPodKeys.push(newFocusedKey);     // Add new focused to end (newest)
          } else {
            // Scroll UP: new focused goes to end (newest position), current focused goes to second-to-last
            orderedPodKeys.push(newFocusedKey);     // Add new focused to end (newest)
            orderedPodKeys.splice(-1, 0, currentFocused); // Insert current focused before the last element
          }

          // Track rotation direction for animation purposes
          if (event.deltaY > 0) {
            store.lastRotationDirection = 'forward';
          } else {
            store.lastRotationDirection = 'backward';
          }

          // Update focus and refresh UI
          focusedKeyRef.current = newFocusedKey;
          debugLog(`[StackRotation] Stack rotated ${store.lastRotationDirection}. New order:`, orderedPodKeys);
          debugLog(`[StackRotation] New focused: ${focusedKeyRef.current}`);
          
          // Update UI with the new focus
          updateUIForFocusedDownload(newFocusedKey, false);
        }
      }

      return {
        updateUIForFocusedDownload,
        managePodVisibilityAndAnimations,
        handlePodScrollFocus
      };
    }
  };
})();
