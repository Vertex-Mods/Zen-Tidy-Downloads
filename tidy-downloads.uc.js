// userChrome.js / download_preview_mistral_pixtral_rename.uc.js - FINAL FIXED VERSION
// AI-powered download preview and renaming with Mistral vision API support
(function () {
  "use strict";

  // Use Components for Firefox compatibility
  const { classes: Cc, interfaces: Ci } = Components;

  // Wait for browser window to be ready
  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  // --- Configuration ---
  const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
  const MISTRAL_MODEL = "pixtral-large-latest";
  let ENABLE_AI_RENAMING = true;
  const MISTRAL_API_KEY_PREF = "extensions.downloads.mistral_api_key";
  const DISABLE_AUTOHIDE_PREF = "extensions.downloads.disable_autohide";
  const AI_RENAMING_MAX_FILENAME_LENGTH = 70;
  const CARD_AUTOHIDE_DELAY_MS = 20000;
  const MAX_CARDS_DOM_LIMIT = 10;
  const CARD_INTERACTION_GRACE_PERIOD_MS = 5000;
  const PREVIEW_SIZE = "42px";
  const IMAGE_LOAD_ERROR_ICON = "🚫";
  const TEMP_LOADER_ICON = "⏳";
  const RENAMED_SUCCESS_ICON = "✓";
  const DEBUG_LOGGING = true;
  const MAX_FILE_SIZE_FOR_AI = 50 * 1024 * 1024; // 50MB limit
  const IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif",
    ".ico", ".tif", ".tiff", ".jfif"
  ]);

  // Platform-agnostic path separator detection
  const PATH_SEPARATOR = navigator.platform.includes("Win") ? "\\" : "/";

  // Global state variables
  let downloadCardsContainer;
  const activeDownloadCards = new Map();
  let renamedFiles = new Set();
  let aiRenamingPossible = false;
  let cardUpdateThrottle = new Map(); // Prevent rapid updates
  let currentZenSidebarWidth = '';
  let podsRowContainerElement = null; // Renamed back from podsStackContainerElement
  let masterTooltipDOMElement = null;
  let focusedDownloadKey = null;
  let orderedPodKeys = []; // Newest will be at the end
  let lastRotationDirection = null; // Track rotation direction: 'forward', 'backward', or null

  // Add debug logging function
  function debugLog(message, data = null) {
    if (!DEBUG_LOGGING) return;
    const timestamp = new Date().toISOString();
    if (data) {
      console.log(`[${timestamp}] Download Preview: ${message}`, data);
    } else {
      console.log(`[${timestamp}] Download Preview: ${message}`);
    }
  }

  // Improved key generation for downloads
  function getDownloadKey(download) {
    // Use target path as primary key since id is often undefined
    if (download?.target?.path) {
      return download.target.path;
    }
    if (download?.id) {
      return download.id;
    }
    // Generate a temporary key based on URL and timestamp
    const url = download?.source?.url || download?.url || "unknown";
    return `temp_${url}_${Date.now()}`;
  }

  // Get safe filename from download object
  function getSafeFilename(download) {
    // Try multiple sources for filename
    if (download.filename) return download.filename;
    if (download.target?.path) {
      return download.target.path.split(/[\\/]/).pop();
    }
    if (download.source?.url) {
      const url = download.source.url;
      const match = url.match(/\/([^\/\?]+)$/);
      if (match) return match[1];
    }
    return "Untitled";
  }

  // Robust initialization
  function init() {
    debugLog("Starting initialization");
    if (!window.Downloads?.getList) {
      console.error("Download Preview Mistral AI: Downloads API not available");
      aiRenamingPossible = false;
      ENABLE_AI_RENAMING = false;
      return;
    }
    try {
      window.Downloads.getList(window.Downloads.ALL)
        .then(async (list) => {
          if (list) {
            debugLog("Downloads API verified");
            await verifyMistralConnection();
            if (aiRenamingPossible) {
              debugLog("AI renaming enabled - all systems verified");
            } else {
              debugLog("AI renaming disabled - Mistral connection failed");
            }
            initDownloadManager();
            initSidebarWidthSync(); // <-- ADDED: Call to initialize sidebar width syncing
            debugLog("Initialization complete");
          }
        })
        .catch((e) => {
          console.error("Downloads API verification failed:", e);
          aiRenamingPossible = false;
          ENABLE_AI_RENAMING = false;
        });
    } catch (e) {
      console.error("Download Preview Mistral AI: Init failed", e);
      aiRenamingPossible = false;
      ENABLE_AI_RENAMING = false;
    }
  }

  // Wait for window load
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init, { once: true });
  }

  // Download manager UI and listeners
  function initDownloadManager() {
    try {
      // Create container if it doesn't exist
      downloadCardsContainer = document.getElementById("userchrome-download-cards-container");
      if (!downloadCardsContainer) {
        downloadCardsContainer = document.createElement("div");
        downloadCardsContainer.id = "userchrome-download-cards-container";
        downloadCardsContainer.setAttribute("style", `
          position: fixed !important;
          left: 0px !important; /* Align container to window left */
          bottom: 20px !important;
          z-index: 2147483647 !important;
          display: flex;
          flex-direction: column;
          align-items: flex-start; 
          gap: 0px; 
          pointer-events: auto;
        `);
        document.body.appendChild(downloadCardsContainer);

        // Create the single master tooltip element (fixed position at the top of the container)
        masterTooltipDOMElement = document.createElement("div");
        masterTooltipDOMElement.className = "details-tooltip master-tooltip";
        masterTooltipDOMElement.style.position = "relative"; 
        masterTooltipDOMElement.style.order = "0"; 
        masterTooltipDOMElement.style.marginLeft = "12px"; // Add this line
        masterTooltipDOMElement.style.width = "350px"; 
        masterTooltipDOMElement.style.minWidth = "176.3333282470703px";
        masterTooltipDOMElement.style.boxSizing = "border-box";
        masterTooltipDOMElement.style.background = "rgba(25,25,25,0.97)";
        masterTooltipDOMElement.style.borderRadius = "10px";
        masterTooltipDOMElement.style.boxShadow = "0 5px 15px rgba(0,0,0,0.35)";
        masterTooltipDOMElement.style.padding = "12px 15px 12px 10px"; // Adjusted padding: T, R, B, L
        masterTooltipDOMElement.style.color = "white";
        masterTooltipDOMElement.style.zIndex = "1001"; 
        masterTooltipDOMElement.style.display = "flex"; // Changed from "none"
        masterTooltipDOMElement.style.flexDirection = "column";
        masterTooltipDOMElement.style.gap = "5px";
        masterTooltipDOMElement.style.pointerEvents = "none";
        masterTooltipDOMElement.style.opacity = "0"; // Start hidden
        masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)"; // Start transformed
        masterTooltipDOMElement.style.transformOrigin = "bottom left"; // Origin for animation
        masterTooltipDOMElement.style.transition = "opacity 0.3s ease-out 0.15s, transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1.1) 0.15s, width 0.2s ease-out";
        masterTooltipDOMElement.style.marginBottom = "12px"; // Space between tooltip and pod row

        masterTooltipDOMElement.innerHTML = `
          <div class="card-status" style="font-size:12px; color:#a0a0a0; line-height:1.2;">Tooltip Status</div>
          <div class="card-title" style="font-size:15px; font-weight:600; line-height:1.3; color:#f0f0f0; /* white-space:nowrap; overflow:hidden; text-overflow:ellipsis; */ word-break: break-word; padding-right: 50px; box-sizing: border-box; margin-top: 2px; margin-bottom: 2px;">Tooltip Title</div>
          <div class="card-original-filename" style="font-size:12px; color:#888; text-decoration: line-through; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:none; margin-bottom: 2px;">Original Filename</div>
          <div class="card-progress" style="font-size:11px; color:#888;">Tooltip Progress</div>
          <div class="tooltip-buttons-container" style="position:absolute; top:6px; right:8px; display:flex; align-items:center;">
            <span class="card-undo-button" title="Undo Rename" tabindex="0" role="button" style="background:none; border:none; color:#aaa; cursor:pointer; padding: 0px 4px 0px 0px; line-height:1; display:none; pointer-events:auto; width: 16px; height: 16px; vertical-align: middle;">
              <!-- SVG will be injected here by script -->
            </span>
            <span class="card-close-button" title="Close" tabindex="0" role="button" style="background:none; border:none; color:#aaa; font-size:15px; font-weight: bold; cursor:pointer; padding:0px 0px 0px 4px; line-height:1; pointer-events:auto; vertical-align: middle;">✕</span>
          </div>
          <div class="tooltip-tail" style="position: absolute; width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-top: 8px solid rgba(25,25,25,0.97); bottom: -7px; left: 20px; /* Fixed tail, adjust if needed for general case */"></div>
        `;
        downloadCardsContainer.appendChild(masterTooltipDOMElement);

        // --- Inject SVG for Undo Button Programmatically ---
        const undoButtonSpan = masterTooltipDOMElement.querySelector(".card-undo-button");
        if (undoButtonSpan) {
            const svgNS = "http://www.w3.org/2000/svg";
            const svgIcon = document.createElementNS(svgNS, "svg");
            svgIcon.setAttribute("viewBox", "0 0 24 24");
            svgIcon.style.width = "100%";
            svgIcon.style.height = "100%";

            const pathIcon = document.createElementNS(svgNS, "path");
            pathIcon.setAttribute("d", "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C20.36 11.36 16.77 8 12.5 8z");
            pathIcon.setAttribute("fill", "#aaa");

            svgIcon.appendChild(pathIcon);
            undoButtonSpan.appendChild(svgIcon);
            debugLog("[SVG Inject] Programmatically created and appended SVG to undo button span.");
        } else {
            debugLog("[SVG Inject] Undo button span not found for SVG injection.");
        }
        // --- End SVG Injection ---

        // Create the container for HORIZONTAL pods row
        podsRowContainerElement = document.createElement("div"); 
        podsRowContainerElement.id = "userchrome-pods-row-container"; 
        podsRowContainerElement.setAttribute("style", `
          display: flex;
          flex-direction: row; 
          align-items: flex-end; 
          position: relative; 
          margin-left: 12px; /* Change from 20px to 10px */
          height: 0px; /* Start with 0 height, will be set by layout manager */
        `);
        podsRowContainerElement.style.order = "1";
        downloadCardsContainer.appendChild(podsRowContainerElement);

        // Add mouse wheel scroll listener to the pods container for changing focus
        podsRowContainerElement.addEventListener('wheel', handlePodScrollFocus, { passive: false });
        
        // Add close handler for the master tooltip's close button AFTER creating podsRowContainerElement
        const masterCloseBtn = masterTooltipDOMElement.querySelector(".card-close-button");
        if (masterCloseBtn) {
          const masterCloseHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            debugLog(`[MasterClose] Master close button clicked. FocusedDownloadKey: ${focusedDownloadKey}`);
            
            if (focusedDownloadKey) {
              const keyToRemove = focusedDownloadKey; // Capture the key
              const cardData = activeDownloadCards.get(keyToRemove);

              // Start tooltip hide animation immediately
              if (masterTooltipDOMElement) {
                masterTooltipDOMElement.style.opacity = "0";
                masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
                debugLog(`[MasterClose] Tooltip hide animation initiated for ${keyToRemove}`);
              }

              // Delay pod removal to allow tooltip to animate out
              setTimeout(() => {
                debugLog(`[MasterClose] Delayed action: proceeding to handle/remove card for ${keyToRemove}`);
                if (cardData && cardData.download && !cardData.download.succeeded && !cardData.download.error && !cardData.download.canceled) {
                  try {
                    cardData.download.cancel();
                    debugLog(`[MasterClose] Attempted to cancel download ${keyToRemove}`);
                  } catch (cancelError) {
                    debugLog(`[MasterClose] Error cancelling download ${keyToRemove}`, cancelError);
                    removeCard(keyToRemove, true); 
                  }
                } else if (cardData) {
                  debugLog(`[MasterClose] Download for ${keyToRemove} is not in progress or cardData.download is missing. Removing card.`);
                  removeCard(keyToRemove, true); 
                } else {
                  debugLog(`[MasterClose] No cardData found for ${keyToRemove} during delayed action. Cannot remove.`);
                }
              }, 300); // Corresponds to tooltip animation duration
            }
          };
          masterCloseBtn.addEventListener("click", masterCloseHandler);
          masterCloseBtn.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && focusedDownloadKey) {
              e.preventDefault();
              masterCloseHandler(e);
            }
          });
        }

        // Add undo handler for the master tooltip's undo button
        const masterUndoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");
        if (masterUndoBtn) {
            const masterUndoHandler = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                debugLog(`[MasterUndo] Master undo button clicked. FocusedDownloadKey: ${focusedDownloadKey}`);
                if (focusedDownloadKey) {
                    await undoRename(focusedDownloadKey);
                    // UI update is handled within undoRename via updateUIForFocusedDownload
                }
            };
            masterUndoBtn.addEventListener("click", masterUndoHandler);
            masterUndoBtn.addEventListener("keydown", async (e) => {
                if ((e.key === "Enter" || e.key === " ") && focusedDownloadKey) {
                    e.preventDefault();
                    await masterUndoHandler(e); // Make sure to await if handler is async
                }
            });
        }

      }

      // Attach listeners
      let downloadListener = {
        onDownloadAdded: (dl) => throttledCreateOrUpdateCard(dl),
        onDownloadChanged: (dl) => throttledCreateOrUpdateCard(dl),
        onDownloadRemoved: (dl) => removeCard(getDownloadKey(dl), false),
      };

      window.Downloads.getList(window.Downloads.ALL)
        .then((list) => {
          list.addView(downloadListener);
          list.getAll().then((all) =>
            all.forEach((dl) => {
              throttledCreateOrUpdateCard(dl, true);
            })
          );
        })
        .catch((e) => console.error("DL Preview Mistral AI: List error:", e));
    } catch (e) {
      console.error("DL Preview Mistral AI: Init error", e);
    }
  }

  // Throttled update to prevent rapid calls
  function throttledCreateOrUpdateCard(download, isNewCardOnInit = false) {
    const key = getDownloadKey(download);
    const now = Date.now();
    const lastUpdate = cardUpdateThrottle.get(key) || 0;
    
    if (now - lastUpdate < 100 && !download.succeeded && !download.error && !download.canceled) {
      return;
    }
    
    cardUpdateThrottle.set(key, now);
    debugLog(`[Throttle] Calling createOrUpdatePodElement for key: ${key}, isNewOnInit: ${isNewCardOnInit}`);
    const podElement = createOrUpdatePodElement(download, isNewCardOnInit);
    if (podElement) {
      debugLog(`[Throttle] Pod element created/updated for ${key}. Calling updateUIForFocusedDownload.`);
      updateUIForFocusedDownload(key, true); 
    }
  }

  // Function to create or update a download POD element
  function createOrUpdatePodElement(download, isNewCardOnInit = false) {
    const key = getDownloadKey(download);
    if (!key) {
      debugLog("Skipping download object without usable key", download);
      return null;
    }

    debugLog("[PodFUNC] createOrUpdatePodElement called", { key, state: download.state, currentBytes: download.currentBytes });

    let cardData = activeDownloadCards.get(key);
    const safeFilename = getSafeFilename(download);
    // const displayName = download.aiName || safeFilename; // Display name will be handled by master tooltip

    let podElement;
    let isNewPod = false;

    if (!cardData) {
      isNewPod = true;
      podElement = document.createElement("div");
      podElement.className = "download-pod"; 
      podElement.id = `download-pod-${key.replace(/[^a-zA-Z0-9_]/g, '-')}`;
      podElement.dataset.downloadKey = key;

      // Style podElement
      podElement.style.position = 'absolute'; // Use absolute positioning from the start for jukebox layout
      podElement.style.width = '56px'; 
      podElement.style.height = '56px';
      podElement.style.borderRadius = '12px';
      podElement.style.backgroundColor = 'rgba(40,40,40,0.9)';
      podElement.style.boxShadow = '0 3px 10px rgba(0,0,0,0.3)';
      podElement.style.display = 'flex';
      podElement.style.alignItems = 'center';
      podElement.style.justifyContent = 'center';
      podElement.style.padding = '8px'; 
      podElement.style.boxSizing = 'border-box';
      podElement.style.flexShrink = '0'; // Prevent pods from shrinking in the flex row

      // Initial styles for entrance animation (bounce for pod)
      podElement.style.opacity = '0';
      podElement.style.transform = 'scale(0.3) translateY(30px)';
      podElement.style.transition = 
          'opacity 0.4s ease-out, transform 0.5s cubic-bezier(0.68, -0.55, 0.27, 1.55), ' + 
          'z-index 0.3s ease-out';

      podElement.innerHTML = `
        <div class="card-preview-container" style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius:6px;">
          <!-- Preview content (image, text snippet, or icon) will go here -->
          </div>
        `;

      // Add event listeners to the pod itself (e.g., for hover to focus, click to open)
      // Commenting out the mouseenter listener to disable hover-to-focus
      /*
      podElement.addEventListener('mouseenter', () => {
        const keyFromPodHover = podElement.dataset.downloadKey; // Get key from dataset
        debugLog(`[PodHover] Mouseenter on pod. Key: ${keyFromPodHover}, Current Focused: ${focusedDownloadKey}`);
        
        const previewContainer = podElement.querySelector('.card-preview-container');
        if (previewContainer && previewContainer.style.pointerEvents === 'none') {
            debugLog(`[PodHover] Pointer events none on preview for ${keyFromPodHover}, not changing focus.`);
            return; 
        }
        
        if (focusedDownloadKey !== keyFromPodHover) {
            debugLog(`[PodHover] Focus will change from ${focusedDownloadKey} to ${keyFromPodHover}. Calling updateUIForFocusedDownload.`);
            updateUIForFocusedDownload(keyFromPodHover, false); // isNewOrSignificantUpdate is false for hover
        } else {
            debugLog(`[PodHover] Pod ${keyFromPodHover} is already focused. No UI update call needed from hover.`);
        }
      });
      */

      const previewContainer = podElement.querySelector(".card-preview-container");
      if (previewContainer) {
        setGenericIcon(previewContainer, download.contentType || "application/octet-stream");
        previewContainer.style.cursor = "pointer";
        previewContainer.title = "Click to open file";
        
        previewContainer.addEventListener("click", (e) => {
          e.stopPropagation(); 
          const currentCardData = activeDownloadCards.get(podElement.dataset.downloadKey);
          if (currentCardData && currentCardData.download) {
            openDownloadedFile(currentCardData.download);
            } else {
            debugLog("openDownloadedFile: Card data not found for pod, attempting with initial download object", { key: podElement.dataset.downloadKey });
            openDownloadedFile(download); 
            }
          });
        }

        cardData = {
        podElement, // Renamed from cardElement
          download,
          complete: false,
          key: key,
          originalFilename: safeFilename, // This is the filename as of pod creation/update
          trueOriginalPathBeforeAIRename: null, // Will store the full path before AI rename
          trueOriginalSimpleNameBeforeAIRename: null, // Will store just the simple filename before AI rename
        lastInteractionTime: Date.now(),
        isVisible: false, // Will be set by layout manager
        isWaitingForZenAnimation: false, // Default, will be set true if new and Zen sync is active
        domAppended: false, // New flag: has this pod been added to podsRowContainerElement?
        intendedTargetTransform: null, // For stable animation triggering
        intendedTargetOpacity: null,   // For stable animation triggering
        isBeingRemoved: false          // To prevent layout conflicts during removal
        };
        activeDownloadCards.set(key, cardData);

      // Add to ordered list (newest at the end)
      if (!orderedPodKeys.includes(key)) {
        orderedPodKeys.push(key);
        // Always set new pods as focused (natural stacking behavior)
        focusedDownloadKey = key;
        debugLog(`[PodFUNC] New pod created, setting as focused: ${key}`);
      }

      // If it's a truly new pod, set up Zen animation observation.
      // The actual appending to DOM and animation will be handled by managePodVisibilityAndAnimations
      // after Zen animation observer confirms or times out.
      if (isNewPod) { 
        // Check if the pod element for this key is already in the DOM (e.g. from a previous session / script reload)
        // This check helps avoid re-observing for an already existing element.
        let existingDOMPod = null;
        if (podsRowContainerElement) { // Renamed back
            existingDOMPod = podsRowContainerElement.querySelector(`#${podElement.id}`); // Renamed back
        }

        if (!existingDOMPod) {
            debugLog(`[PodFUNC] New pod ${key}, setting up Zen animation observer.`);
            cardData.isWaitingForZenAnimation = true;
            initZenAnimationObserver(key, podElement); // Pass podElement for eventual append
        } else {
            debugLog(`[PodFUNC] Pod ${key} DOM element already exists, skipping Zen observer setup. Will be laid out.`);
            cardData.domAppended = true; // It's already in the DOM
            // Ensure it starts invisible if it was an orphan, layout manager will reveal
            podElement.style.opacity = '0'; 
            cardData.isVisible = false;
        }
      } // else, it's an update to an existing pod, no need for Zen animation sync.

      // Append to the horizontal row container
      // The actual animation trigger will be handled by updateUIForFocusedDownload or Zen sync
      if (podsRowContainerElement && !podElement.parentNode) {
        podsRowContainerElement.appendChild(podElement);
        cardData.domAppended = true; // Mark as appended to DOM
      }

    } else {
      // Update existing pod data
      podElement = cardData.podElement;
      cardData.download = download; 
      cardData.lastInteractionTime = Date.now(); // Update interaction time on any change event
      if (safeFilename !== cardData.originalFilename && !download.aiName) {
         cardData.originalFilename = safeFilename; // Update if original name changes (e.g. server sent a different name later)
      }
    }

    // Update pod preview content based on download state (icon, image, text snippet)
    const previewElement = podElement.querySelector(".card-preview-container");
    if (previewElement) {
        if (download.succeeded) {
            if (!cardData.complete) { // Only set preview once on completion
                setCompletedFilePreview(previewElement, download)
                    .catch(e => debugLog("Error setting completed file preview (async) for pod", {error: e, download}));
            }
        } else if (download.error || download.canceled) {
            // Potentially set a different icon for error/cancel state on the pod itself
            setGenericIcon(previewElement, "application/octet-stream"); // Default or error specific icon
        } else {
            // In-progress, could have a spinner or animated icon on the pod
            // For now, generic icon remains until completion, set at creation.
        }
    }
    
    // Mark as complete internally
    if (download.succeeded && !cardData.complete) {
      cardData.complete = true;
      podElement.classList.add("completed"); // For potential styling
      // AI renaming logic will be triggered by updateUIForFocusedDownload if this is the focused item
      // scheduleCardRemoval is also deferred, potentially managed by a global max or user action
    }
    if (download.error) podElement.classList.add("error");
    if (download.canceled) podElement.classList.add("canceled");

    return podElement;
  }

  // This will be a new, complex function. For now, a placeholder.
  function updateUIForFocusedDownload(keyToFocus, isNewOrSignificantUpdate = false) {
    debugLog(`[UIUPDATE_TOP] updateUIForFocusedDownload called. keyToFocus: ${keyToFocus}, isNewOrSignificantUpdate: ${isNewOrSignificantUpdate}, current focusedDownloadKey: ${focusedDownloadKey}`);
    
    const oldFocusedKey = focusedDownloadKey;
    focusedDownloadKey = keyToFocus; 
    debugLog(`[UIUPDATE_FOCUS_SET] focusedDownloadKey is NOW: ${focusedDownloadKey}`);

    const cardDataToFocus = focusedDownloadKey ? activeDownloadCards.get(focusedDownloadKey) : null;

    if (!masterTooltipDOMElement) {
        debugLog("[UIUPDATE_ERROR] Master tooltip DOM element not found. Cannot update UI.");
        return; // Critical error, cannot proceed
    }

    if (!cardDataToFocus || !cardDataToFocus.podElement) {
      debugLog(`[UIUPDATE_NO_CARD_DATA] No card data or podElement for key ${focusedDownloadKey}. Hiding master tooltip. CardData:`, cardDataToFocus);
      masterTooltipDOMElement.style.opacity = "0";
      masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
    } else {
      // cardDataToFocus and podElement are valid, proceed with UI updates for tooltip and AI.
      masterTooltipDOMElement.style.display = "flex"; 

      if (oldFocusedKey !== focusedDownloadKey || isNewOrSignificantUpdate) {
          debugLog(`[UIUPDATE_TOOLTIP_RESET] Focus changed or significant update. Resetting tooltip for animation for ${focusedDownloadKey}. Old focus: ${oldFocusedKey}`);
          masterTooltipDOMElement.style.opacity = "0"; 
          masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
      }

      const download = cardDataToFocus.download; 
      const podElement = cardDataToFocus.podElement; 

      if (!download) {
        debugLog(`[UIUPDATE_ERROR] cardDataToFocus for key ${focusedDownloadKey} is valid, but its .download property is undefined. Cannot update tooltip content or AI.`);
        // Keep tooltip hidden or show a generic error if it was supposed to be visible
        if (masterTooltipDOMElement.style.opacity !== '0') {
             masterTooltipDOMElement.style.opacity = "0";
             masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
        }
      } else {
        // Both cardDataToFocus, podElement, AND download object are valid. Proceed with detailed updates.

        // 1. Update masterTooltipDOMElement content
        const titleEl = masterTooltipDOMElement.querySelector(".card-title");
        const statusEl = masterTooltipDOMElement.querySelector(".card-status");
        const progressEl = masterTooltipDOMElement.querySelector(".card-progress");
        const originalFilenameEl = masterTooltipDOMElement.querySelector(".card-original-filename");
        const undoBtnEl = masterTooltipDOMElement.querySelector(".card-undo-button"); // Get the undo button

        const displayName = download.aiName || cardDataToFocus.originalFilename || "File";
        
        if (titleEl) {
          titleEl.textContent = displayName;
          titleEl.title = displayName;
        }

        if (statusEl && originalFilenameEl && progressEl && undoBtnEl) { // Include undoBtnEl in the check
            if (download.aiName && download.succeeded) {
                // AI Renamed State
                statusEl.textContent = "Download renamed to:";
                statusEl.style.color = "#a0a0a0"; 

                originalFilenameEl.textContent = cardDataToFocus.originalFilename; 
                originalFilenameEl.title = cardDataToFocus.originalFilename;
                originalFilenameEl.style.display = "block";

                progressEl.style.display = "none"; 
                undoBtnEl.style.display = "inline-flex"; // Show undo button
            } else {
                // Default states (downloading, completed normally, error, canceled)
                originalFilenameEl.style.display = "none"; 
                progressEl.style.display = "block";    
                undoBtnEl.style.display = "none"; // Hide undo button

      if (download.error) {
                    statusEl.textContent = `Error: ${download.error.message || "Download failed"}`;
                    statusEl.style.color = "#ff6b6b";
      } else if (download.canceled) {
                    statusEl.textContent = "Download canceled";
                    statusEl.style.color = "#ff9f43";
      } else if (download.succeeded) {
                    statusEl.textContent = "Download completed";
                    statusEl.style.color = "#1dd1a1";
                } else if (typeof download.currentBytes === 'number' && download.totalBytes > 0 && download.hasProgress) {
                    const percent = Math.round((download.currentBytes / download.totalBytes) * 100);
                    statusEl.textContent = `Downloading... ${percent}%`;
                    statusEl.style.color = "#54a0ff";
                } else if (!download.succeeded && !download.error && !download.canceled) {
                    statusEl.textContent = "Downloading...";
                    statusEl.style.color = "#54a0ff";
                } else {
                    statusEl.textContent = "Starting download...";
                    statusEl.style.color = "#b5b5b5";
                }
            }
        }

        if (progressEl) { // This block handles the content of progressEl when it's visible
            if (progressEl.style.display !== 'none') { // Only update if visible
                if (download.succeeded) {
                    let finalSize = download.currentBytes;
                    if (!(typeof finalSize === 'number' && finalSize > 0)) finalSize = download.totalBytes;
                    progressEl.textContent = `${formatBytes(finalSize || 0)}`;
                } else if (typeof download.currentBytes === 'number' && download.totalBytes > 0) {
                    progressEl.textContent = `${formatBytes(download.currentBytes)} / ${formatBytes(download.totalBytes)}`;
                } else if (!download.succeeded && !download.error && !download.canceled) {
                    progressEl.textContent = "Processing...";
                } else {
                    progressEl.textContent = "Calculating size...";
                }
            }
        }
        
        if (currentZenSidebarWidth && currentZenSidebarWidth !== "0px" && !isNaN(parseFloat(currentZenSidebarWidth))) {
            masterTooltipDOMElement.style.width = `calc(${currentZenSidebarWidth} - 20px)`;
        } else {
            masterTooltipDOMElement.style.width = '350px'; // Default
          }

        // 5. Handle AI Renaming for the focused item if it just completed
        if (ENABLE_AI_RENAMING && aiRenamingPossible && download.succeeded && cardDataToFocus.complete &&
            download.target?.path && !renamedFiles.has(download.target.path) && !podElement.classList.contains('renaming-initiated')) {
          
          podElement.classList.add('renaming-initiated'); 
          debugLog(`[AI Rename] Triggering for focused item: ${focusedDownloadKey}`);
            
            // Show Analyzing / Renaming Status Immediately on Master Tooltip if this is focused
            if (focusedDownloadKey === keyToFocus && masterTooltipDOMElement) {
                const status = masterTooltipDOMElement.querySelector(".card-status");
                const undoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");
                if (status) status.textContent = "Analyzing for rename...";
                if (undoBtn) undoBtn.style.display = "none"; // Hide undo while analyzing
            }
            
            setTimeout(() => {
            processDownloadForAIRenaming(download, cardDataToFocus.originalFilename, focusedDownloadKey)
              .then(success => {
                  if (success && focusedDownloadKey === download.target.path && masterTooltipDOMElement) { // keyToFocus might be outdated if path changed
                      const undoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");
                      if (undoBtn) undoBtn.style.display = "inline-flex"; // Show after successful rename
                  }
              })
              .catch((e) => {
                console.error("Error in AI renaming for focused download:", e);
                podElement.classList.remove('renaming-initiated'); 
                // Restore status if needed
                if (focusedDownloadKey === keyToFocus && masterTooltipDOMElement) {
                    const status = masterTooltipDOMElement.querySelector(".card-status");
                    if (status && status.textContent === "Analyzing for rename...") {
                         // Re-run updateUI to restore correct status based on download object
                         updateUIForFocusedDownload(keyToFocus, false);
                    }
                }
              });
          }, 1500); 
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
            if (cd.key === focusedDownloadKey) {
                cd.podElement.classList.add('focused-pod');
                cd.podElement.style.boxShadow = '0 0 15px rgba(84, 160, 255, 0.7), 0 3px 10px rgba(0,0,0,0.3)';
            } else {
                cd.podElement.classList.remove('focused-pod');
                 cd.podElement.style.boxShadow = '0 3px 10px rgba(0,0,0,0.3)';
            }
        }
    });
          }

  // Placeholder for the layout manager function
  function managePodVisibilityAndAnimations() {
    if (!masterTooltipDOMElement || !podsRowContainerElement) return;
    debugLog("[LayoutManager] managePodVisibilityAndAnimations Natural Stacking Style called.");

    const tooltipWidth = masterTooltipDOMElement.offsetWidth;
    const podNominalWidth = 56; 
    const podOverlapAmount = 40; 
    const baseZIndex = 10;
    const maxVisiblePodsInPile = Math.floor((tooltipWidth - podNominalWidth) / (podNominalWidth - podOverlapAmount)) + 1; 

    if (orderedPodKeys.length === 0) {
        if (masterTooltipDOMElement.style.opacity !== "0") {
            debugLog("[LayoutManager] No pods, ensuring master tooltip is hidden.");
            masterTooltipDOMElement.style.opacity = "0";
            masterTooltipDOMElement.style.transform = "scaleY(0.8) translateY(10px)";
            setTimeout(() => { 
                if (masterTooltipDOMElement.style.opacity === "0") masterTooltipDOMElement.style.display = "none";
            }, 300);
        }
        debugLog(`[LayoutManager] Exiting: No OrderedPodKeys.`);
        podsRowContainerElement.style.gap = '0px'; // Reset gap just in case
        return;
    }

    if (tooltipWidth === 0 && orderedPodKeys.length > 0) {
        debugLog("[LayoutManager] Master tooltip width is 0. Cannot manage pod layout yet.");
        // Set a minimum height for the container to prevent layout collapse
        if (podsRowContainerElement.style.height === '0px') {
            podsRowContainerElement.style.height = '56px';
        }
        return; 
    }
    
    // Ensure focusedDownloadKey is valid and in orderedPodKeys, default to newest if not.
    if (!focusedDownloadKey || !orderedPodKeys.includes(focusedDownloadKey)) {
        if (orderedPodKeys.length > 0) {
            const newFocusKey = orderedPodKeys[orderedPodKeys.length -1]; // Default to newest
            if (focusedDownloadKey !== newFocusKey) {
                focusedDownloadKey = newFocusKey;
                debugLog(`[LayoutManager] Focused key was invalid or missing, defaulted to newest: ${focusedDownloadKey}`);
            }
        }
    }

    // Ensure all pods in orderedPodKeys are in the DOM and have initial styles for animation/layout.
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

    let visiblePodsLayoutData = []; // Stores {key, x, zIndex, isFocused}
    const focusedIndexInOrdered = orderedPodKeys.indexOf(focusedDownloadKey);

    if (focusedIndexInOrdered === -1 && orderedPodKeys.length > 0) {
        // This should not happen if the check above worked, but as a failsafe:
        debugLog(`[LayoutManager_ERROR] Focused key ${focusedDownloadKey} not in ordered keys after all! Defaulting again.`);
        focusedDownloadKey = orderedPodKeys[orderedPodKeys.length - 1];
        // updateUIForFocusedDownload(focusedDownloadKey, false); // This could cause a loop, be careful
        // return; // Might be better to just proceed with the default for this frame
    }
    
    if (!focusedDownloadKey) { // If still no focused key (e.g. orderedPodKeys became empty)
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
        key: focusedDownloadKey,
        x: currentX,
        zIndex: baseZIndex + orderedPodKeys.length + 1, // Highest Z
        isFocused: true
    });
    currentX += podNominalWidth - podOverlapAmount; // Next pod starts offset by (width - overlap)

    // 2. Position the pile pods to the right in reverse chronological order (natural stacking)
    // Create pile from newest to oldest, excluding the focused pod
    const pileKeys = orderedPodKeys.slice().reverse().filter(key => key !== focusedDownloadKey);
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

    debugLog(`[LayoutManager_NaturalStack] Calculated layout for ${visiblePodsLayoutData.length} pods. Focused: ${focusedDownloadKey}`, visiblePodsLayoutData);

    // 3. Apply styles and animations
    orderedPodKeys.forEach(key => {
        const cardData = activeDownloadCards.get(key);
        if (!cardData || !cardData.podElement || !cardData.domAppended || cardData.isWaitingForZenAnimation || cardData.isBeingRemoved) {
            debugLog(`[LayoutManager_Jukebox_Skip] Skipping pod ${key}. Conditions: cardData=${!!cardData}, podElement=${!!cardData?.podElement}, domAppended=${cardData?.domAppended}, waitingZen=${cardData?.isWaitingForZenAnimation}, beingRemoved=${cardData?.isBeingRemoved}`);
            return; // Skip pods that are not ready, waiting for Zen, or being removed
        }

        // Additional safety check: ensure pod is actually in the DOM
        if (!cardData.podElement.parentNode) {
            debugLog(`[LayoutManager_Jukebox_Skip] Pod ${key} not in DOM, skipping layout.`);
            return;
        }

        const podElement = cardData.podElement;
        const layoutData = visiblePodsLayoutData.find(p => p.key === key);

        if (layoutData) {
            // This pod should be visible
            podElement.style.display = 'flex';
            podElement.style.zIndex = `${layoutData.zIndex}`;
            const targetTransform = `translateX(${layoutData.x}px) scale(1) translateY(0)`;
            const targetOpacity = layoutData.isFocused ? '1' : '0.75';

            // Only animate if intended state changes or if it's becoming visible
            if (!cardData.isVisible || cardData.intendedTargetTransform !== targetTransform || cardData.intendedTargetOpacity !== targetOpacity) {
                debugLog(`[LayoutManager_Jukebox_Anim_Setup] Pod ${key}: Setting up IN/MOVE animation to X=${layoutData.x}, Opacity=${targetOpacity}. Prev IntendedTransform: ${cardData.intendedTargetTransform}, Prev Opacity: ${cardData.intendedTargetOpacity}, IsVisible: ${cardData.isVisible}`);
                
                // Apply directional entrance animation for newly focused pods during rotation
                if (layoutData.isFocused && !cardData.isVisible && lastRotationDirection) {
                    let entranceTransform;
                    if (lastRotationDirection === 'forward') {
                        // Forward rotation: new focused pod slides in from the right
                        entranceTransform = `translateX(${layoutData.x + 80}px) scale(0.8) translateY(0)`;
                    } else if (lastRotationDirection === 'backward') {
                        // Backward rotation: new focused pod slides in from the right (same as forward - reverse animation)
                        entranceTransform = `translateX(${layoutData.x + 80}px) scale(0.8) translateY(0)`;
                    } else {
                        entranceTransform = targetTransform;
                    }
                    
                    // Set initial position for entrance animation
                    podElement.style.transform = entranceTransform;
                    podElement.style.opacity = '0';
                    
                    debugLog(`[LayoutManager_DirectionalAnim] Pod ${key}: Starting ${lastRotationDirection} entrance from ${entranceTransform}`);
                    
                    // Animate to final position
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            podElement.style.opacity = targetOpacity;
                            podElement.style.transform = targetTransform;
                            debugLog(`[LayoutManager_DirectionalAnim] Pod ${key}: Animating to final position ${targetTransform}`);
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
                }, 100); 
            }
        } else {
            // This pod should be hidden or moved to pile
            if (cardData.isVisible || podElement.style.opacity !== '0') {
                debugLog(`[LayoutManager_Jukebox_Anim_OUT] Pod ${key}`);
                
                // Apply directional exit animation for previously focused pod during rotation
                let targetTransformOut;
                if (cardData.key === focusedDownloadKey && lastRotationDirection) {
                    // This shouldn't happen as focused pod should be visible, but safety check
                    targetTransformOut = 'scale(0.8) translateX(-30px)';
                } else if (lastRotationDirection === 'forward') {
                    // Forward rotation: previously focused pod slides left to join pile
                    targetTransformOut = 'scale(0.8) translateX(-60px)';
                } else if (lastRotationDirection === 'backward') {
                    // Backward rotation: previously focused pod slides left to join pile (same as forward - reverse animation)
                    targetTransformOut = 'scale(0.8) translateX(-60px)';
                } else {
                    // Default exit animation
                    targetTransformOut = 'scale(0.8) translateX(-30px)';
                }
                
                if (cardData.intendedTargetTransform !== targetTransformOut || cardData.intendedTargetOpacity !== '0') {
                    podElement.style.opacity = '0';
                    podElement.style.transform = targetTransformOut;
                    debugLog(`[LayoutManager_DirectionalExit] Pod ${key}: Exiting with ${lastRotationDirection || 'default'} animation: ${targetTransformOut}`);
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

    debugLog(`[LayoutManager_NaturalStack] Finished. Visible pods: ${visiblePodsLayoutData.map(p=>p.key).join(", ")}`);
    
    // Reset rotation direction after animations are set up
    if (lastRotationDirection) {
        setTimeout(() => {
            lastRotationDirection = null;
            debugLog(`[LayoutManager] Reset rotation direction after animation`);
        }, 100); // Small delay to ensure animations start before reset
    }
  }

  // --- Mouse Wheel Scroll Handler for Stack Rotation ---
  function handlePodScrollFocus(event) {
    if (!orderedPodKeys || orderedPodKeys.length <= 1) return; // Need at least 2 pods to rotate

    event.preventDefault(); // Prevent page scroll
    event.stopPropagation();

    if (!focusedDownloadKey || !orderedPodKeys.includes(focusedDownloadKey)) {
      debugLog("[StackRotation] No valid focused key, cannot rotate stack");
      return;
    }

    // Get current stack arrangement: focused pod + pile in reverse chronological order
    const currentFocused = focusedDownloadKey;
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
        lastRotationDirection = 'forward';
      } else {
        lastRotationDirection = 'backward';
      }

      // Update focus and refresh UI
      focusedDownloadKey = newFocusedKey;
      debugLog(`[StackRotation] Stack rotated ${lastRotationDirection}. New order:`, orderedPodKeys);
      debugLog(`[StackRotation] New focused: ${focusedDownloadKey}`);
      
      // Update UI with the new focus
      updateUIForFocusedDownload(newFocusedKey, false);
    }
  }

  // Improved card removal function
  function removeCard(downloadKey, force = false) {
    try {
      const cardData = activeDownloadCards.get(downloadKey);
      if (!cardData) {
        debugLog(`removeCard: No card data found for key: ${downloadKey}`);
        return false;
      }

      const podElement = cardData.podElement;
      if (!podElement) {
        debugLog(`removeCard: No pod element found for key: ${downloadKey}`);
        return false;
      }

      if (!force && cardData.lastInteractionTime && 
          Date.now() - cardData.lastInteractionTime < CARD_INTERACTION_GRACE_PERIOD_MS) {
        debugLog(`removeCard: Skipping removal due to recent interaction: ${downloadKey}`);
        return false;
      }

      cardData.isBeingRemoved = true; // Mark for exclusion from layout management
      debugLog(`[RemoveCard] Marked card ${downloadKey} as isBeingRemoved.`);

      // --- New Exit Animation for Pod: Slide Left & Fade --- 
      podElement.style.transition = "opacity 0.3s ease-out, transform 0.3s ease-in-out";
      podElement.style.opacity = "0";
      podElement.style.transform = "translateX(-60px) scale(0.8)"; // Slide left and slightly shrink
      // podElement.style.width = "0px"; // Optional: remove if translateX is enough
      debugLog(`[RemoveCard] Initiated slide-out animation for pod ${downloadKey}`);

      setTimeout(() => {
        if (podElement.parentNode) {
          podElement.parentNode.removeChild(podElement);
        }
        activeDownloadCards.delete(downloadKey);
        cardUpdateThrottle.delete(downloadKey);
        
        const removedPodIndex = orderedPodKeys.indexOf(downloadKey);
        if (removedPodIndex > -1) {
          orderedPodKeys.splice(removedPodIndex, 1);
        }

        debugLog(`Pod removed for download: ${downloadKey}, remaining ordered keys:`, orderedPodKeys);

        if (focusedDownloadKey === downloadKey) {
          focusedDownloadKey = null; // Clear focus first
          if (orderedPodKeys.length > 0) {
            // Try to focus an adjacent pod to the one removed.
            // orderedPodKeys is [oldest, ..., newest]
            // If removedPodIndex was valid, try to focus what's now at removedPodIndex (which was to its right)
            // or removedPodIndex - 1 (to its left).
            let newFocusKey = null;
            if (removedPodIndex < orderedPodKeys.length) { // Try focusing the pod that took its place (originally to the right)
                newFocusKey = orderedPodKeys[removedPodIndex];
            } else if (removedPodIndex > 0 && orderedPodKeys.length > 0) { // Try focusing the pod to the left
                newFocusKey = orderedPodKeys[removedPodIndex - 1];
            } else if (orderedPodKeys.length > 0) { // Fallback to newest if extremes were removed
                 newFocusKey = orderedPodKeys[orderedPodKeys.length - 1];
            }
            focusedDownloadKey = newFocusKey;
            debugLog(`[RemoveCard] Old focus ${downloadKey} removed. New focus attempt: ${focusedDownloadKey}`);
          }
        }
        
        // Update UI based on new focus (or lack thereof)
        // This will also hide the master tooltip if no pods are left or re-evaluate layout
        updateUIForFocusedDownload(focusedDownloadKey, false); 

      }, 300); // Corresponds to pod animation duration

      return true;
    } catch (e) {
      console.error("Error removing card:", e);
      return false;
    }
  }

  function scheduleCardRemoval(downloadKey) {
    try {
      const disableAutohide = getPref(DISABLE_AUTOHIDE_PREF, false);
      if (disableAutohide) return;

      setTimeout(() => {
        removeCard(downloadKey, false);
      }, CARD_AUTOHIDE_DELAY_MS);
    } catch (e) {
      console.error("Error scheduling card removal:", e);
    }
  }

  // Helper function to get preferences
  function getPref(prefName, defaultValue) {
    try {
      const prefService = Cc["@mozilla.org/preferences-service;1"]
        .getService(Ci.nsIPrefService);
      const branch = prefService.getBranch("");

      if (typeof defaultValue === "boolean") {
        return branch.getBoolPref(prefName, defaultValue);
      } else if (typeof defaultValue === "string") {
        return branch.getStringPref(prefName, defaultValue);
      } else if (typeof defaultValue === "number") {
        return branch.getIntPref(prefName, defaultValue);
      }
      return defaultValue;
    } catch (e) {
      console.error("Error getting preference:", e);
      return defaultValue;
    }
  }

  // Set generic icon for file type
  function setGenericIcon(previewElement, contentType) {
    if (!previewElement) return;
    try {
      let icon = "📄";
      if (typeof contentType === "string") {
        if (contentType.includes("image/")) icon = "🖼️";
        else if (contentType.includes("video/")) icon = "🎬";
        else if (contentType.includes("audio/")) icon = "🎵";
        else if (contentType.includes("text/")) icon = "📝";
        else if (contentType.includes("application/pdf")) icon = "📕";
        else if (contentType.includes("application/zip") || contentType.includes("application/x-rar")) icon = "🗜️";
        else if (contentType.includes("application/")) icon = "📦";
      }
      previewElement.innerHTML = `<span style="font-size: 24px;">${icon}</span>`;
    } catch (e) {
      debugLog("Error setting generic icon:", e);
      previewElement.innerHTML = `<span style="font-size: 24px;">📄</span>`;
    }
  }

  // Set preview for completed image file
  async function setCompletedFilePreview(previewElement, download) {
    if (!previewElement) return;

    debugLog("[setCompletedFilePreview] Called", { 
      contentType: download?.contentType, 
      targetPath: download?.target?.path,
      filename: download?.filename 
    });

    const textMimeTypes = new Set([
      "text/plain",
      "text/markdown",
      "application/javascript",
      "text/javascript",
      "text/css",
      "text/html",
      "application/json",
      "application/xml",
      "text/xml"
      // Add more as needed
    ]);

    try {
      if (download.target?.path && textMimeTypes.has(download.contentType?.toLowerCase())) {
        const snippet = await readTextFileSnippet(download.target.path);
        if (snippet) {
          previewElement.innerHTML = ""; // Clear previous content
          const pre = document.createElement("pre");
          pre.textContent = snippet;
          pre.style.fontSize = "9px";
          pre.style.lineHeight = "1.2";
          pre.style.fontFamily = "monospace";
          pre.style.color = "#ccc";
          pre.style.margin = "0";
          pre.style.padding = "4px";
          pre.style.overflow = "hidden";
          pre.style.maxWidth = PREVIEW_SIZE; 
          pre.style.maxHeight = PREVIEW_SIZE;
          pre.style.borderRadius = "4px";
          pre.style.backgroundColor = "rgba(255,255,255,0.05)";
          pre.style.whiteSpace = "pre-wrap"; // Allow wrapping
          pre.style.wordBreak = "break-all"; // Break long words if necessary
          previewElement.appendChild(pre);
          debugLog("[setCompletedFilePreview] Text snippet preview set", { path: download.target.path });
          return; // Snippet set, exit
        }
      } else if (download?.contentType?.startsWith("image/") && download.target?.path) {
        // Existing image preview logic (good first check)
        debugLog("[setCompletedFilePreview] Attempting image preview via contentType", { path: download.target.path, contentType: download.contentType });
        const img = document.createElement("img");
        const imgSrc = `file:///${download.target.path.replace(/\\/g, '/')}`;
        img.src = imgSrc;
        img.style.maxWidth = PREVIEW_SIZE;
        img.style.maxHeight = PREVIEW_SIZE;
        img.style.objectFit = "contain";
        img.style.borderRadius = "4px";
        img.style.transition = "all 0.3s ease";
        img.style.opacity = "0";
        
        img.onload = () => { 
          img.style.opacity = "1"; 
          debugLog("[setCompletedFilePreview] Image loaded successfully (by contentType)", { src: imgSrc });
        };
        img.onerror = () => {
          debugLog("[setCompletedFilePreview] Image failed to load (by contentType)", { src: imgSrc });
          // Fallback to generic icon if even contentType-based image load fails
          setGenericIcon(previewElement, "image/generic"); // Indicate it was thought to be an image
        };
        
        previewElement.innerHTML = "";
        previewElement.appendChild(img);
      } else if (download.target?.path) { // Fallback: Check extension if contentType is missing or not an image type
        const filePath = download.target.path.toLowerCase();
        let isImageTypeByExtension = false;
        for (const ext of IMAGE_EXTENSIONS) {
          if (filePath.endsWith(ext)) {
            isImageTypeByExtension = true;
            break;
          }
        }
        if (isImageTypeByExtension) {
          debugLog("[setCompletedFilePreview] Attempting image preview via file extension", { path: download.target.path });
          const img = document.createElement("img");
          const imgSrc = `file:///${download.target.path.replace(/\\/g, '/')}`;
          img.src = imgSrc;
          img.style.maxWidth = PREVIEW_SIZE;
          img.style.maxHeight = PREVIEW_SIZE;
          img.style.objectFit = "contain";
          img.style.borderRadius = "4px";
          img.style.transition = "all 0.3s ease";
          img.style.opacity = "0";
          
          img.onload = () => { 
            img.style.opacity = "1"; 
            debugLog("[setCompletedFilePreview] Image loaded successfully (by extension)", { src: imgSrc });
          };
          img.onerror = () => {
            debugLog("[setCompletedFilePreview] Image failed to load (by extension)", { src: imgSrc });
            // Fallback to generic icon if even extension-based image load fails
            setGenericIcon(previewElement, "image/generic"); // Indicate it was thought to be an image
        };
        
        previewElement.innerHTML = "";
        previewElement.appendChild(img);
      } else {
          debugLog("[setCompletedFilePreview] No specific preview (contentType or extension), setting generic icon", { contentType: download?.contentType, path: download.target.path });
        setGenericIcon(previewElement, download?.contentType);
        }
      } else {
        debugLog("[setCompletedFilePreview] No target path for preview, setting generic icon", { download });
        setGenericIcon(previewElement, null); // No path, no content type known
      }
    } catch (e) {
      debugLog("Error setting file preview:", e);
      previewElement.innerHTML = `<span style="font-size: 24px;">🚫</span>`;
    }
  }

  // Process download for AI renaming - with file size check
  async function processDownloadForAIRenaming(download, originalNameForUICard, keyOverride) {
    const key = keyOverride || getDownloadKey(download);
    const cardData = activeDownloadCards.get(key);
    // Ensure we are updating the MASTER tooltip if this is the focused download
    let statusElToUpdate;
    let titleElToUpdate; // For AI name
    let originalFilenameElToUpdate; // For the struck-through original name
    let progressElToHide; // To hide progress when renamed info is shown
    let podElementToStyle; // For .renaming class etc.

    if (focusedDownloadKey === key && masterTooltipDOMElement) {
        statusElToUpdate = masterTooltipDOMElement.querySelector(".card-status");
        titleElToUpdate = masterTooltipDOMElement.querySelector(".card-title");
        originalFilenameElToUpdate = masterTooltipDOMElement.querySelector(".card-original-filename");
        progressElToHide = masterTooltipDOMElement.querySelector(".card-progress");
    } else if (cardData && cardData.podElement) {
        // Fallback: if not focused, or master tooltip somehow not found,
        // we might want to log or have a small indicator on the pod itself.
        // For now, if it's not focused, AI renaming might not show progress directly on master tooltip.
        // This logic assumes AI rename is primarily for the *focused* element's display.
        // Let's assume if it's not focused, we might not update UI aggressively, or handle it differently.
        // For now, if not focused, we'll log and potentially skip aggressive UI updates.
        debugLog(`[AI Rename] processDownloadForAIRenaming called for non-focused item ${key}. UI updates will be minimal.`);
    }
    
    if (cardData && cardData.podElement) {
        podElementToStyle = cardData.podElement;
    }


    if (!cardData) {
      debugLog("AI Rename: Card data not found for download key:", key);
      return false;
    }
    // const cardElement = cardData.podElement; // Use podElement
    // const statusEl = cardElement.querySelector(".card-status"); // This would be on the individual card if it had one
    // if (!statusEl) return false; // No individual status on pod. Master tooltip is primary.

    const previewContainerOnPod = cardData.podElement ? cardData.podElement.querySelector(".card-preview-container") : null;
    let originalPreviewTitle = "";
    if (previewContainerOnPod) {
      originalPreviewTitle = previewContainerOnPod.title;
    }

    const downloadPath = download.target.path;
    if (!downloadPath) return false;

    // Capture the true original filename before any AI processing for this attempt
    const trueOriginalFilename = cardData.originalFilename; 

    if (renamedFiles.has(downloadPath)) {
      debugLog(`Skipping rename - already processed: ${downloadPath}`);
      return false;
    }

    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(downloadPath);
      if (file.fileSize > MAX_FILE_SIZE_FOR_AI) {
        debugLog(`Skipping AI rename - file too large: ${formatBytes(file.fileSize)}`);
        if (statusElToUpdate) statusElToUpdate.textContent = "File too large for AI analysis";
        return false;
      }
    } catch (e) {
      debugLog("Error checking file size:", e);
      return false;
    }

    // Store the original path and simple name in cardData *before* attempting rename
    // This is critical for the undo functionality.
    if (cardData) {
        cardData.trueOriginalPathBeforeAIRename = downloadPath; 
        cardData.trueOriginalSimpleNameBeforeAIRename = downloadPath.split(PATH_SEPARATOR).pop();
        debugLog("[AI Rename Prep] Stored for undo:", { 
            path: cardData.trueOriginalPathBeforeAIRename, 
            name: cardData.trueOriginalSimpleNameBeforeAIRename 
        });
    }

    renamedFiles.add(downloadPath);

    try {
      // cardElement.classList.add("renaming");
      if (podElementToStyle) podElementToStyle.classList.add("renaming-active");
      if (statusElToUpdate) statusElToUpdate.textContent = "Analyzing file...";
      
      if (previewContainerOnPod) {
        previewContainerOnPod.style.pointerEvents = "none";
        previewContainerOnPod.title = "Renaming in progress...";
      }

      const currentFilename = downloadPath.split(PATH_SEPARATOR).pop();
      const fileExtension = currentFilename.includes(".") 
        ? currentFilename.substring(currentFilename.lastIndexOf(".")).toLowerCase() 
        : "";

      const isImage = IMAGE_EXTENSIONS.has(fileExtension);
      debugLog(`Processing file for AI rename: ${currentFilename} (${isImage ? "Image" : "Non-image"})`);

      let suggestedName = null;

      if (isImage) {
        if (statusElToUpdate) statusElToUpdate.textContent = "Analyzing image...";
        const imagePrompt = `Create a specific, descriptive filename for this image.
Rules:
- Use 2-4 specific words describing the main subject or content
- Be specific about what's in the image (e.g. "mountain-lake-sunset" not just "landscape")
- Use hyphens between words
- No generic words like "image" or "photo"
- Keep extension "${fileExtension}"
- Maximum length: ${AI_RENAMING_MAX_FILENAME_LENGTH} characters
Respond with ONLY the filename.`;

        suggestedName = await callMistralAPI({
          prompt: imagePrompt,
          localPath: downloadPath,
          fileExtension: fileExtension,
        });
      }

      if (!suggestedName) {
        if (statusElToUpdate) statusElToUpdate.textContent = "Generating better name...";
        const sourceURL = download.source?.url || "unknown";
        const metadataPrompt = `Create a specific, descriptive filename for this ${isImage ? "image" : "file"}.
Original filename: "${currentFilename}"
Download URL: "${sourceURL}"
Rules:
- Use 2-5 specific words about the content or purpose
- Be more specific than the original name
- Use hyphens between words
- Keep extension "${fileExtension}"
- Maximum length: ${AI_RENAMING_MAX_FILENAME_LENGTH} characters
Respond with ONLY the filename.`;

        suggestedName = await callMistralAPI({
          prompt: metadataPrompt,
          localPath: null,
          fileExtension: fileExtension,
        });
      }

      if (!suggestedName || suggestedName === "rate-limited") {
        debugLog("No valid name suggestion received from AI");
        if (statusElToUpdate) {
            statusElToUpdate.textContent = suggestedName === "rate-limited" ? 
          "⚠️ API rate limit reached" : "Could not generate a better name";
        }
        renamedFiles.delete(downloadPath);
        if (podElementToStyle) podElementToStyle.classList.remove("renaming-active");
        if (podElementToStyle) podElementToStyle.classList.remove('renaming-initiated'); // Allow retry by focus change
        return false;
      }

      let cleanName = suggestedName
        .replace(/[^a-zA-Z0-9\-_\.]/g, "")
        .replace(/\s+/g, "-")
        .toLowerCase();

      if (cleanName.length > AI_RENAMING_MAX_FILENAME_LENGTH - fileExtension.length) {
        cleanName = cleanName.substring(0, AI_RENAMING_MAX_FILENAME_LENGTH - fileExtension.length);
      }
      if (fileExtension && !cleanName.toLowerCase().endsWith(fileExtension.toLowerCase())) {
        cleanName = cleanName + fileExtension;
      }

      if (cleanName.length <= 2 || cleanName.toLowerCase() === currentFilename.toLowerCase()) {
        debugLog("Skipping AI rename - name too short or same as original");
        if (statusElToUpdate) statusElToUpdate.textContent = "Original name is suitable"; // Or some other neutral message
        renamedFiles.delete(downloadPath);
        if (podElementToStyle) podElementToStyle.classList.remove("renaming-active");
        if (podElementToStyle) podElementToStyle.classList.remove('renaming-initiated');
        return false;
      }

      debugLog(`AI suggested renaming to: ${cleanName}`);
      if (statusElToUpdate) statusElToUpdate.textContent = `Renaming to: ${cleanName}`;

      // Pass key to ensure the correct cardData (and thus podElement) is found by rename function
      const success = await renameDownloadFileAndUpdateRecord(download, cleanName, key);

      if (success) {
        const newPath = download.target.path; // This is now the new path after rename
        download.aiName = cleanName; // Set the aiName property on the download object
        // cardData.originalFilename = cleanName; // NO! Keep cardData.originalFilename as the name before this specific AI op.
                                            // The titleEl will pick up download.aiName.
                                            // The originalFilenameEl will use the trueOriginalFilename captured above.


        if (titleElToUpdate) { 
          titleElToUpdate.textContent = cleanName;
          titleElToUpdate.title = cleanName;
        }

        if (statusElToUpdate) {
          statusElToUpdate.textContent = "Download renamed to:";
          statusElToUpdate.style.color = "#a0a0a0";
        }

        if (originalFilenameElToUpdate) {
            originalFilenameElToUpdate.textContent = trueOriginalFilename; // Use the captured true original name
            originalFilenameElToUpdate.title = trueOriginalFilename;
            originalFilenameElToUpdate.style.textDecoration = "line-through";
            originalFilenameElToUpdate.style.display = "block";
        }

        if (progressElToHide) {
            progressElToHide.style.display = "none";
        }
        
        if (podElementToStyle) {
            podElementToStyle.classList.remove("renaming-active");
            podElementToStyle.classList.add("renamed-by-ai");
        }
        
        // IMPORTANT: If the renamed item was focused, update focusedDownloadKey to the new path
        // and ensure the subsequent UI update uses this new key.
        let keyForFinalUIUpdate = key; // Original key passed to this function
        
        // Update activeDownloadCards with the new key (path) BUT preserve original cardData object reference
        // The cardData object itself should retain the *trueOriginalFilename* if needed for other contexts,
        // or rely on the fact that renameDownloadFileAndUpdateRecord updates the key in activeDownloadCards.
        // The critical part is that `download.aiName` is set, and `trueOriginalFilename` is available for this UI update.
        // The `cardData.originalFilename` will naturally become the `cleanName` if `createOrUpdatePodElement` runs again for this item
        // due to some other event, which is fine, as `download.aiName` would be preferred by `updateUIForFocusedDownload`.

        if (focusedDownloadKey === key) { // 'key' here is the *original* key before rename
            focusedDownloadKey = newPath; // Update global focus to the NEW path
            keyForFinalUIUpdate = newPath; // Use the NEW path for the upcoming UI update
            debugLog(`[AI Rename] Focused item ${key} renamed to ${newPath}. Updated focusedDownloadKey and keyForFinalUIUpdate.`);
        }

        // The call to updateUIForFocusedDownload will now correctly use download.aiName for the title,
        // and cardData.originalFilename (which should be the one prior to this AI attempt or the one from pod creation)
        // for the strikethrough, as per its own logic.
        // The direct update of tooltip elements within this function ensures immediate feedback.
        updateUIForFocusedDownload(keyForFinalUIUpdate, true); // Force a significant update as content structure changed

        debugLog(`Successfully AI-renamed to: ${cleanName}`);
        return true;
      } else {
        renamedFiles.delete(downloadPath);
        if (statusElToUpdate) statusElToUpdate.textContent = "Rename failed";
        if (podElementToStyle) {
            podElementToStyle.classList.remove("renaming-active");
            podElementToStyle.classList.remove('renaming-initiated');
        }
        return false;
      }
    } catch (e) {
      console.error("AI Rename process error:", e);
      renamedFiles.delete(downloadPath); // Ensure it can be retried if it was an unexpected error
      if (statusElToUpdate) statusElToUpdate.textContent = "Rename error";
      if (podElementToStyle) {
        podElementToStyle.classList.remove("renaming-active");
        podElementToStyle.classList.remove('renaming-initiated');
      }
      return false;
    } finally {
      if (previewContainerOnPod) {
        previewContainerOnPod.style.pointerEvents = "auto";
        previewContainerOnPod.title = originalPreviewTitle; // Restore original title or new name if successful? For now, original.
      }
       if (podElementToStyle) podElementToStyle.classList.remove("renaming-active"); // General cleanup
    }
  }

  // Improved file renaming function
  async function renameDownloadFileAndUpdateRecord(download, newName, key) {
    try {
      const oldPath = download.target.path;
      if (!oldPath) throw new Error("No file path available");

      const directory = oldPath.substring(0, oldPath.lastIndexOf(PATH_SEPARATOR));
      const oldFileName = oldPath.split(PATH_SEPARATOR).pop();
      const fileExt = oldFileName.includes(".") 
        ? oldFileName.substring(oldFileName.lastIndexOf(".")) 
        : "";

      let cleanNewName = newName.trim().replace(/[\\/:*?"<>|]/g, "");
      if (fileExt && !cleanNewName.endsWith(fileExt)) {
        cleanNewName += fileExt;
      }

      // Handle duplicate names
      let finalName = cleanNewName;
      let counter = 1;
      while (counter < 100) {
        const testPath = directory + PATH_SEPARATOR + finalName;
        let exists = false;
        try {
          const testFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          testFile.initWithPath(testPath);
          exists = testFile.exists();
        } catch (e) {
          // File doesn't exist or can't access - proceed
        }
        if (!exists) break;
        
        const baseName = cleanNewName.includes(".") 
          ? cleanNewName.substring(0, cleanNewName.lastIndexOf(".")) 
          : cleanNewName;
        finalName = `${baseName}-${counter}${fileExt}`;
        counter++;
      }

      const newPath = directory + PATH_SEPARATOR + finalName;
      debugLog("Rename paths", { oldPath, newPath });

      const oldFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      oldFile.initWithPath(oldPath);

      if (!oldFile.exists()) throw new Error("Source file does not exist");

      // Perform the rename
      oldFile.moveTo(null, finalName);

      // Update download record
      download.target.path = newPath;
      
      // Update card data key mapping
      const cardData = activeDownloadCards.get(key); // key is the OLD key here
      if (cardData) {
        activeDownloadCards.delete(key);
        activeDownloadCards.set(newPath, cardData);
        cardData.key = newPath; // Update the key stored in cardData itself
        if (cardData.podElement) { // Update dataset on the pod element itself
            cardData.podElement.dataset.downloadKey = newPath;
            debugLog(`[Rename] Updated podElement.dataset.downloadKey to ${newPath}`);
        }
        // Update the key in orderedPodKeys as well
        const oldKeyIndex = orderedPodKeys.indexOf(key);
        if (oldKeyIndex > -1) {
            orderedPodKeys.splice(oldKeyIndex, 1, newPath);
            debugLog(`[Rename] Updated key in orderedPodKeys from ${key} to ${newPath}`);
        } else {
            debugLog(`[Rename] Warning: Old key ${key} not found in orderedPodKeys during rename.`);
        }
        debugLog(`Updated card key mapping from ${key} to ${newPath}`);
      }

      debugLog("File renamed successfully");
      return true;
    } catch (e) {
      console.error("Rename failed:", e);
      return false;
    }
  }

  function formatBytes(b, d = 2) {
    if (b === 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${parseFloat((b / Math.pow(1024, i)).toFixed(d))} ${sizes[i]}`;
  }

  // Mistral API function - with better error handling
  async function callMistralAPI({ prompt, localPath, fileExtension }) {
    try {
      // Get API key
      let apiKey = "";
      try {
        const prefService = Cc["@mozilla.org/preferences-service;1"]
          .getService(Ci.nsIPrefService);
        const branch = prefService.getBranch("extensions.downloads.");
        apiKey = branch.getStringPref("mistral_api_key", "");
      } catch (e) {
        debugLog("Failed to get API key from preferences", e);
        return null;
      }

      if (!apiKey) {
        debugLog("No API key found");
        return null;
      }

      // Build message content
      let content = [{ type: "text", text: prompt }];

      // Add image data if provided
      if (localPath) {
        try {
          const imageBase64 = fileToBase64(localPath);
          if (imageBase64) {
            const mimeType = getMimeTypeFromExtension(fileExtension);
            content.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            });
          }
        } catch (e) {
          debugLog("Failed to encode image, proceeding without it", e);
        }
      }

      const payload = {
        model: MISTRAL_MODEL,
        messages: [{ role: "user", content: content }],
        max_tokens: 100,
        temperature: 0.2,
      };

      debugLog("Sending API request to Mistral");

      const response = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        if (response.status === 429) return "rate-limited";
        debugLog(`API error ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      debugLog("Raw API response:", data);

      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (error) {
      console.error("Mistral API error:", error);
      return null;
    }
  }

  function getMimeTypeFromExtension(ext) {
    switch (ext?.toLowerCase()) {
      case ".png": return "image/png";
      case ".gif": return "image/gif";
      case ".svg": return "image/svg+xml";
      case ".webp": return "image/webp";
      case ".bmp": return "image/bmp";
      case ".avif": return "image/avif";
      case ".ico": return "image/x-icon";
      case ".tif": return "image/tiff";
      case ".tiff": return "image/tiff";
      case ".jfif": return "image/jpeg";
      default: return "image/jpeg";
    }
  }

  function fileToBase64(path) {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      
      // Check file size
      if (file.fileSize > MAX_FILE_SIZE_FOR_AI) {
        debugLog("File too large for base64 conversion");
        return null;
      }

      const fstream = Cc["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Ci.nsIFileInputStream);
      fstream.init(file, -1, 0, 0);
      
      const bstream = Cc["@mozilla.org/binaryinputstream;1"]
        .createInstance(Ci.nsIBinaryInputStream);
      bstream.setInputStream(fstream);
      
      const bytes = bstream.readBytes(file.fileSize);
      fstream.close();
      bstream.close();

      // Convert to base64 in chunks to avoid memory issues
      const chunks = [];
      const CHUNK_SIZE = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        chunks.push(
          String.fromCharCode.apply(
            null,
            bytes.slice(i, i + CHUNK_SIZE).split("").map(c => c.charCodeAt(0))
          )
        );
      }
      
      return btoa(chunks.join(""));
    } catch (e) {
      debugLog("fileToBase64 error:", e);
      return null;
    }
  }

  // --- Helper Function to Read Text File Snippet ---
  async function readTextFileSnippet(filePath, maxLines = 5, maxLengthPerLine = 80) {
    let fstream = null;
    let scriptableStream = null;
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(filePath);

      if (!file.exists() || !file.isReadable()) {
        debugLog("readTextFileSnippet: File does not exist or is not readable", { filePath });
        return null;
      }

      if (file.fileSize === 0) {
        return "[Empty file]";
      }
      
      if (file.fileSize > 1 * 1024 * 1024) { // 1MB limit for snippet reading
        debugLog("readTextFileSnippet: File too large for snippet", { filePath, fileSize: file.fileSize });
        return "[File too large for preview]";
      }

      fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
      fstream.init(file, -1, 0, 0); 
      
      scriptableStream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      scriptableStream.init(fstream);

      const textDecoder = new TextDecoder("utf-8");
      let lineBuffer = ""; 
      let linesRead = 0;
      let outputLines = [];
      const bufferSize = 4096; // How much to read at a time
      let chunk = "";

      while (linesRead < maxLines) {
        // Read a chunk of data. scriptableStream.read returns a string of bytes here.
        let byteString = scriptableStream.read(bufferSize);
        if (byteString.length === 0) { // EOF
          if (lineBuffer.length > 0) { 
            let trimmedLine = lineBuffer.trimEnd();
            if (trimmedLine.length > maxLengthPerLine) {
              trimmedLine = trimmedLine.substring(0, maxLengthPerLine) + "...";
            }
            outputLines.push(trimmedLine);
            linesRead++;
          }
          break; // Exit while loop
        }
        
        // Decode the byte string to a proper UTF-8 string.
        // Need to be careful with characters split across chunks. Pass {stream: true} to decoder.
        lineBuffer += textDecoder.decode(Uint8Array.from(byteString, c => c.charCodeAt(0)), { stream: true });
        
        let eolIndex;
        // Process all complete lines found in the buffer
        while ((eolIndex = lineBuffer.indexOf('\n')) !== -1 && linesRead < maxLines) {
          let currentLine = lineBuffer.substring(0, eolIndex);
          let trimmedLine = currentLine.trimEnd();
          if (trimmedLine.length > maxLengthPerLine) {
            trimmedLine = trimmedLine.substring(0, maxLengthPerLine) + "...";
          }
          outputLines.push(trimmedLine);
          linesRead++;
          lineBuffer = lineBuffer.substring(eolIndex + 1);
        }
        
        // If we've read maxLines, but there's still unprocessed data in lineBuffer (without a newline)
        // and we still have capacity in outputLines (this check is mostly for safety, might be redundant)
        if (linesRead >= maxLines && lineBuffer.length > 0 && outputLines.length === maxLines) {
            // If the last processed line made us hit maxLines, and there's a remainder,
            // we might want to indicate truncation on the *last added line* if it wasn't already done.
            // For now, this will just mean the lineBuffer remainder is ignored if maxLines is hit.
        }
      }
      
      // After the loop, if maxLines was not reached and there's still data in lineBuffer (last line without newline)
      if (linesRead < maxLines && lineBuffer.length > 0) {
        let trimmedLine = lineBuffer.trimEnd();
        if (trimmedLine.length > maxLengthPerLine) {
          trimmedLine = trimmedLine.substring(0, maxLengthPerLine) + "...";
        }
        outputLines.push(trimmedLine);
      }

      if (outputLines.length === 0) {
        // This might happen if the file is very small and only newlines, or other edge cases.
        return "[Could not read snippet contents]"; 
      }

      return outputLines.join("\n");

    } catch (ex) {
      debugLog("readTextFileSnippet error:", { filePath, error: ex.message, stack: ex.stack });
      return "[Error reading file preview]"; 
    } finally {
      if (scriptableStream && typeof scriptableStream.close === 'function') {
        try { scriptableStream.close(); } catch (e) { debugLog("Error closing scriptableStream",{e}); }
      }
      if (fstream && typeof fstream.close === 'function') {
          try { fstream.close(); } catch (e) { debugLog("Error closing fstream in finally", {e}); }
      }
    }
  }

  // --- Function to Open Downloaded File ---
  function openDownloadedFile(download) {
    if (!download || !download.target || !download.target.path) {
      debugLog("openDownloadedFile: Invalid download object or path", { download });
      return;
    }

    const filePath = download.target.path;
    debugLog("openDownloadedFile: Attempting to open file", { filePath });

    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(filePath);

      if (file.exists() && file.isReadable()) {
        file.launch(); // Opens with default system application
      } else {
        debugLog("openDownloadedFile: File does not exist or is not readable", { filePath });
        // Optionally, notify the user via the card status or an alert
        // For now, just logging.
      }
    } catch (ex) {
      debugLog("openDownloadedFile: Error launching file", { filePath, error: ex.message, stack: ex.stack });
      // Optionally, notify the user
    }
  }

  // Verify Mistral API connection
  async function verifyMistralConnection() {
    try {
      let apiKey = "";
      try {
        const prefService = Cc["@mozilla.org/preferences-service;1"]
          .getService(Ci.nsIPrefService);
        const branch = prefService.getBranch("extensions.downloads.");
        apiKey = branch.getStringPref("mistral_api_key", "");
      } catch (e) {
        console.error("Failed to get API key from preferences", e);
        aiRenamingPossible = false;
        ENABLE_AI_RENAMING = false;
        return;
      }

      if (!apiKey) {
        debugLog("No Mistral API key found in preferences. AI renaming disabled.");
        aiRenamingPossible = false;
        ENABLE_AI_RENAMING = false;
        return;
      }

      const testResponse = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello, this is a test connection. Respond with 'ok'." },
          ],
          max_tokens: 5,
        }),
      });

      if (testResponse.ok) {
        debugLog("Mistral API connection successful!");
        aiRenamingPossible = true;
        ENABLE_AI_RENAMING = true;
      } else {
        console.error("Mistral API connection failed:", await testResponse.text());
        aiRenamingPossible = false;
        ENABLE_AI_RENAMING = false;
      }
    } catch (e) {
      console.error("Error verifying Mistral API connection:", e);
      aiRenamingPossible = false;
      ENABLE_AI_RENAMING = false;
    }
  }

  console.log("Download Preview Mistral AI Script (FINAL FIXED): Execution finished, initialization scheduled/complete.");

// --- Sidebar Width Synchronization Logic ---
function updateCurrentZenSidebarWidth() {
  const mainWindow = document.getElementById('main-window');
  const toolbox = document.getElementById('navigator-toolbox');

  if (!toolbox) {
    debugLog('[SidebarWidthSync] #navigator-toolbox not found. Cannot read --zen-sidebar-width.');
    // currentZenSidebarWidth = ''; // Let it retain its value if toolbox temporarily disappears? Or clear?
                                 // For now, if toolbox isn't there, we can't update, so we do nothing to the existing value.
    return;
  }

  // Log compact mode for context, but don't block the read based on it.
  if (mainWindow) {
    const isCompact = mainWindow.getAttribute('zen-compact-mode') === 'true';
    debugLog(`[SidebarWidthSync] #main-window zen-compact-mode is currently: ${isCompact}. Attempting to read from #navigator-toolbox.`);
  } else {
    debugLog('[SidebarWidthSync] #main-window not found. Attempting to read from #navigator-toolbox.');
  }
  
  const value = getComputedStyle(toolbox).getPropertyValue('--zen-sidebar-width').trim();
  
  if (value && value !== "0px" && value !== "") {
    if (currentZenSidebarWidth !== value) {
      currentZenSidebarWidth = value;
      debugLog('[SidebarWidthSync] Updated currentZenSidebarWidth from #navigator-toolbox to:', value);
      applyGlobalWidthToAllTooltips(); // Apply to existing tooltips
    } else {
      debugLog('[SidebarWidthSync] --zen-sidebar-width from #navigator-toolbox is unchanged (' + value + '). No update to tooltips needed.');
    }
  } else {
    // If the value is empty, "0px", or not set, it implies the sidebar isn't in a state where this var is active.
    // Clear our global var so the tooltip uses its own default width.
    if (currentZenSidebarWidth !== '') { // Only update if it actually changes to empty
      currentZenSidebarWidth = ''; 
      debugLog(`[SidebarWidthSync] --zen-sidebar-width on #navigator-toolbox is '${value}'. Cleared currentZenSidebarWidth. Tooltip will use default width.`);
      applyGlobalWidthToAllTooltips(); // Apply default width logic to existing tooltips
    } else {
      debugLog(`[SidebarWidthSync] --zen-sidebar-width on #navigator-toolbox is '${value}' and currentZenSidebarWidth is already empty. No update needed.`);
    }
  }
}

function initSidebarWidthSync() {
  const mainWindow = document.getElementById('main-window');
  const navigatorToolbox = document.getElementById('navigator-toolbox');
  let resizeTimeoutId = null;

  if (mainWindow) {
    // Set up a MutationObserver to watch attribute changes on #main-window for zen-compact-mode
    const mutationObserver = new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'zen-compact-mode'
        ) {
          debugLog('[SidebarWidthSync] zen-compact-mode attribute changed. Updating sidebar width.');
          updateCurrentZenSidebarWidth();
        }
      }
    });
    mutationObserver.observe(mainWindow, {
      attributes: true,
      attributeFilter: ['zen-compact-mode']
    });
  } else {
    debugLog('[SidebarWidthSync] initSidebarWidthSync: #main-window not found. Cannot set up MutationObserver for compact mode.');
  }

  if (navigatorToolbox) {
    // Set up a ResizeObserver to watch for size changes on #navigator-toolbox
    const resizeObserver = new ResizeObserver(entries => {
      // Debounce the resize event
      clearTimeout(resizeTimeoutId);
      resizeTimeoutId = setTimeout(() => {
        for (let entry of entries) {
          // We don't strictly need to check entry.contentRect here as getComputedStyle will get the current var value
          debugLog('[SidebarWidthSync] #navigator-toolbox resized. Updating sidebar width.');
          updateCurrentZenSidebarWidth();
        }
      }, 250); // 250ms debounce period
    });
    resizeObserver.observe(navigatorToolbox);
    debugLog('[SidebarWidthSync] ResizeObserver started on #navigator-toolbox.');
  } else {
    debugLog('[SidebarWidthSync] initSidebarWidthSync: #navigator-toolbox not found. Cannot set up ResizeObserver.');
  }

  // Run it once at init in case the attribute/size is already set at load
  debugLog('[SidebarWidthSync] Initial call to update sidebar width.');
  updateCurrentZenSidebarWidth();
}

function applyGlobalWidthToAllTooltips() {
  debugLog('[TooltipWidth] Attempting to apply global width to master tooltip.');
  if (!masterTooltipDOMElement) {
    debugLog('[TooltipWidth] Master tooltip DOM element not found.');
    return;
  }

  if (currentZenSidebarWidth && currentZenSidebarWidth !== "0px" && !isNaN(parseFloat(currentZenSidebarWidth))) {
    const newWidth = `calc(${currentZenSidebarWidth} - 20px)`; 
    masterTooltipDOMElement.style.width = newWidth;
    debugLog(`[TooltipWidth] Applied new width to master tooltip: ${newWidth}`);
  } else {
    // Fallback to default width if currentZenSidebarWidth is invalid or not set
    masterTooltipDOMElement.style.width = '350px'; // Default width
    debugLog('[TooltipWidth] Applied default width (350px) to master tooltip as currentZenSidebarWidth is invalid or empty.');
  }
}

// --- Zen Animation Synchronization Logic ---
function triggerCardEntrance(downloadKeyToTrigger) {
  const cardData = activeDownloadCards.get(downloadKeyToTrigger);
  if (!cardData) {
    debugLog(`[ZenSync] triggerCardEntrance: No cardData for key ${downloadKeyToTrigger}`);
    return;
  }

  // This function is now primarily a signal that Zen animation (if any) is complete.
  // It no longer appends or directly animates the pod here.
  // It marks the pod as ready for layout and calls updateUIForFocusedDownload.
  
  if (cardData.isWaitingForZenAnimation) {
    debugLog(`[ZenSync] triggerCardEntrance: Zen animation completed or fallback for ${downloadKeyToTrigger}. Pod is ready for layout.`);
    cardData.isWaitingForZenAnimation = false;
    
    // Ensure the pod is appended to DOM if it hasn't been already
    if (!cardData.domAppended && podsRowContainerElement && cardData.podElement) {
        podsRowContainerElement.appendChild(cardData.podElement);
        cardData.domAppended = true;
        debugLog(`[ZenSync] Appended pod ${downloadKeyToTrigger} to DOM after Zen animation.`);
    }
    
    // Call updateUI which will call managePodVisibilityAndAnimations
    // If this download is the new focus, it makes sense to update everything.
    // If not, we still need to re-evaluate layout for all pods.
    updateUIForFocusedDownload(focusedDownloadKey || downloadKeyToTrigger, false); 
  } else {
    debugLog(`[ZenSync] triggerCardEntrance: Called for ${downloadKeyToTrigger} but it was not waiting for Zen animation. Ignoring.`);
  }
}

function initZenAnimationObserver(downloadKey, podElementToMonitor) { // podElement is passed for context, not direct manipulation here
  debugLog("[ZenSync] Initializing observer for key:", downloadKey);
  let observer = null;
  let fallbackTimeoutId = null;

  const zenAnimationHost = document.querySelector('zen-download-animation');

  if (zenAnimationHost && zenAnimationHost.shadowRoot) {
    debugLog("[ZenSync] Found zen-download-animation host and shadowRoot.");

    observer = new MutationObserver((mutationsList, obs) => {
      for (const mutation of mutationsList) {
        if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
          for (const removedNode of mutation.removedNodes) {
            if (removedNode.nodeType === Node.ELEMENT_NODE && removedNode.classList.contains('zen-download-arc-animation')) {
              debugLog("[ZenSync] Detected .zen-download-arc-animation removal. Triggering pod entrance.", { key: downloadKey });
              clearTimeout(fallbackTimeoutId); // Clear the safety fallback
              triggerCardEntrance(downloadKey, podElementToMonitor);
              obs.disconnect(); // Stop observing
              observer = null; // Clean up observer reference
              return; // Exit once detected
            }
          }
        }
      }
    });

    observer.observe(zenAnimationHost.shadowRoot, { childList: true });
    debugLog("[ZenSync] Observer started on shadowRoot.");

    // Safety fallback timeout
    fallbackTimeoutId = setTimeout(() => {
      debugLog("[ZenSync] Fallback timeout reached. Triggering card entrance signal.", { key: downloadKey });
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      triggerCardEntrance(downloadKey); 
      // CardData fallbackTriggered is not strictly needed now as triggerCardEntrance is just a signal
    }, 3000); // 3-second fallback

  } else {
    debugLog("[ZenSync] zen-download-animation host or shadowRoot not found. Triggering card entrance signal immediately.", { key: downloadKey });
    triggerCardEntrance(downloadKey);
    // CardData fallbackTriggered not strictly needed
  }
}

// --- Function to Undo AI Rename ---
async function undoRename(keyOfAIRenamedFile) {
  debugLog("[UndoRename] Attempting to undo rename for key:", keyOfAIRenamedFile);
  const cardData = activeDownloadCards.get(keyOfAIRenamedFile);

  if (!cardData || !cardData.download) {
      debugLog("[UndoRename] No cardData or download object found for key:", keyOfAIRenamedFile);
      return false;
  }

  const currentAIRenamedPath = cardData.download.target.path; // Current path (after AI rename)
  const originalSimpleName = cardData.trueOriginalSimpleNameBeforeAIRename;
  const originalFullPath = cardData.trueOriginalPathBeforeAIRename; // The full path before AI rename

  if (!currentAIRenamedPath || !originalSimpleName || !originalFullPath) {
      debugLog("[UndoRename] Missing path/name information for undo:", 
          { currentAIRenamedPath, originalSimpleName, originalFullPath });
      // Maybe update status to indicate error?
      return false;
  }
  
  // Ensure originalSimpleName is what we expect if originalFullPath is the key to the past state
  // For safety, we reconstruct the target directory from the *current* path if the original was just a simple name.
  const targetDirectory = currentAIRenamedPath.substring(0, currentAIRenamedPath.lastIndexOf(PATH_SEPARATOR));
  const targetOriginalPath = targetDirectory + PATH_SEPARATOR + originalSimpleName;

  debugLog("[UndoRename] Details:", {
      currentPath: currentAIRenamedPath,
      originalSimple: originalSimpleName,
      originalFullPathStored: originalFullPath, // The key to what it *was*
      targetOriginalPathForRename: targetOriginalPath // The path we want to rename *to*
  });

  // Use a modified version of rename logic. 
  // We are renaming from currentAIRenamedPath to targetOriginalPath (which uses originalSimpleName)
  try {
      const fileToUndo = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      fileToUndo.initWithPath(currentAIRenamedPath);

      if (!fileToUndo.exists()) {
          debugLog("[UndoRename] File to undo does not exist at current path:", currentAIRenamedPath);
          // Perhaps it was moved or deleted by the user? Clean up UI.
          if (masterTooltipDOMElement) {
              const undoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");
              if (undoBtn) undoBtn.style.display = "none";
          }
          // Consider removing the card or updating status more drastically.
          return false;
      }

      // Perform the rename back to originalSimpleName in the current directory
      fileToUndo.moveTo(null, originalSimpleName); 
      debugLog(`[UndoRename] File moved from ${currentAIRenamedPath} to ${targetOriginalPath} (using simple name ${originalSimpleName})`);

      // Update download object and cardData
      cardData.download.target.path = targetOriginalPath;
      cardData.download.aiName = null; // Clear the AI name
      // cardData.originalFilename should revert to originalSimpleName (or be updated by next UI refresh)
      cardData.originalFilename = originalSimpleName; 

      // Update the key in activeDownloadCards map
      if (keyOfAIRenamedFile !== targetOriginalPath) {
          activeDownloadCards.delete(keyOfAIRenamedFile);
          activeDownloadCards.set(targetOriginalPath, cardData);
          cardData.key = targetOriginalPath;
          if (cardData.podElement) cardData.podElement.dataset.downloadKey = targetOriginalPath;
          
          // Update orderedPodKeys
          const oldKeyIndex = orderedPodKeys.indexOf(keyOfAIRenamedFile);
          if (oldKeyIndex > -1) {
              orderedPodKeys.splice(oldKeyIndex, 1, targetOriginalPath);
          }

          // If this was the focused key, update focusedDownloadKey
          if (focusedDownloadKey === keyOfAIRenamedFile) {
              focusedDownloadKey = targetOriginalPath;
          }
          debugLog(`[UndoRename] Updated activeDownloadCards map key from ${keyOfAIRenamedFile} to ${targetOriginalPath}`);
      }
      
      renamedFiles.delete(originalFullPath); // Allow AI re-rename if user downloads it again or wants to retry
      renamedFiles.delete(currentAIRenamedPath); // Remove the AI-renamed path from the set too

      // Update UI immediately for the focused item
      if (focusedDownloadKey === targetOriginalPath && masterTooltipDOMElement) {
          const titleEl = masterTooltipDOMElement.querySelector(".card-title");
          const statusEl = masterTooltipDOMElement.querySelector(".card-status");
          const originalFilenameEl = masterTooltipDOMElement.querySelector(".card-original-filename");
          const progressEl = masterTooltipDOMElement.querySelector(".card-progress");
          const undoBtn = masterTooltipDOMElement.querySelector(".card-undo-button");

          if (titleEl) titleEl.textContent = originalSimpleName;
          if (statusEl) {
              statusEl.textContent = "Download completed"; // Or original status if stored
              statusEl.style.color = "#1dd1a1";
          }
          if (originalFilenameEl) originalFilenameEl.style.display = "none";
          if (progressEl) progressEl.style.display = "block"; // Show progress/size again
          if (undoBtn) undoBtn.style.display = "none";
      }

      // Trigger a full UI update
      updateUIForFocusedDownload(focusedDownloadKey || targetOriginalPath, true); 

      debugLog("[UndoRename] Rename undone successfully.");
      return true;

  } catch (e) {
      debugLog("[UndoRename] Error during undo rename process:", e);
      // Update status to show error?
      if (masterTooltipDOMElement && focusedDownloadKey === keyOfAIRenamedFile) {
           const statusEl = masterTooltipDOMElement.querySelector(".card-status");
           if (statusEl) {
              statusEl.textContent = "Undo rename failed";
              statusEl.style.color = "#ff6b6b";
           }
      }
      return false;
  }
}

})(); 