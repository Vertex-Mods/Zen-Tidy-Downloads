// ==UserScript==
// @include   main
// @loadOrder 99999999999998
// @ignorecache
// ==/UserScript==

// zen-dismissed-downloads-pile.uc.js
// Dismissed downloads pile with messy-to-grid transition
(function () {
    "use strict";
  
    // Wait for browser window to be ready
    if (location.href !== "chrome://browser/content/browser.xhtml") return;
  
    // Configuration
    const CONFIG = {
      maxPileSize: 20, // Maximum pods to keep in pile
      pileDisplayCount: 4, // Pods visible in messy pile
      gridAnimationDelay: 50, // ms between pod animations
      hoverDebounceMs: 150, // Hover debounce delay
      pileRotationRange: 8, // degrees ±
      pileOffsetRange: 8, // pixels ±
      gridPadding: 12, // pixels between grid items
      minPodSize: 45, // minimum pod size in grid
      animationDuration: 400, // pod transition duration
      containerAnimationDuration: 100, // container height/padding transition duration
    };
  
    // State management
    let downloadButton = null;
    let pileContainer = null;
    let dynamicSizer = null; // <-- Add new state for the sizer
    let isGridMode = false;
    let hoverTimeout = null;
    let dismissedPods = new Map(); // Local copy with layout data
    let isInitialized = false;
  
    // Animation state tracking
    const podElements = new Map(); // podKey -> DOM element
    const pilePositions = new Map(); // podKey -> {x, y, rotation, zIndex}
    const gridPositions = new Map(); // podKey -> {x, y, row, col}
  
    let currentZenSidebarWidthForPile = ''; // For pile's own width sync
  
    // Debug logging
    function debugLog(message, data = null) {
      try {
        console.log(`[Dismissed Pile] ${message}`, data || '');
      } catch (e) {
        console.log(`[Dismissed Pile] ${message}`);
      }
    }
  
    // Initialize the pile system
    async function init() {
      debugLog("Initializing dismissed downloads pile system");
      
      // Wait for the main download script to be available
      if (!window.zenTidyDownloads) {
        debugLog("Main download script not ready, retrying in 500ms");
        setTimeout(init, 500);
        return;
      }
  
      try {
        await findDownloadButton();
        await createPileContainer(); // This now creates dynamicSizer too
        setupEventListeners();
        loadExistingDismissedPods();
        
        isInitialized = true;
        debugLog("Dismissed downloads pile system initialized successfully");
      } catch (error) {
        debugLog("Error initializing pile system:", error);
        setTimeout(init, 1000); // Retry on error
      }
    }
  
    // Find the Firefox downloads button
    async function findDownloadButton() {
      const selectors = [
        '#downloads-button',
        '[data-l10n-id="downloads-button"]',
        '#downloads-indicator',
        '.toolbarbutton-1[command="Tools:Downloads"]'
      ];
  
      for (const selector of selectors) {
        downloadButton = document.querySelector(selector);
        if (downloadButton) {
          debugLog(`Found download button using selector: ${selector}`);
          return;
        }
      }
  
      // Fallback: look for any element with downloads-related attributes
      const fallbackElements = document.querySelectorAll('[id*="download"], [class*="download"]');
      for (const element of fallbackElements) {
        if (element.getAttribute('command')?.includes('Downloads') || 
            element.textContent?.toLowerCase().includes('download')) {
          downloadButton = element;
          debugLog("Found download button using fallback method", element);
          return;
        }
      }
  
      throw new Error("Download button not found");
    }
  
    // Create the pile container
    async function createPileContainer() {
      if (!downloadButton) throw new Error("Download button not available");
  
      // Create the dynamic sizer element
      dynamicSizer = document.createElement("div");
      dynamicSizer.id = "zen-dismissed-pile-dynamic-sizer";
      dynamicSizer.style.cssText = `
        position: fixed;
        overflow: hidden;
        height: 0px;
        bottom: 30px;
        left: 0px;
        background: light-dark(rgba(255, 255, 255, 0.8), rgba(0, 0, 0, 0.8));
        mask: linear-gradient(to top, transparent 0%, black 5%, black 80%, transparent 100%);
        -webkit-mask: linear-gradient(to top, transparent 0%, black 5%, black 80%, transparent 100%);
        box-sizing: border-box;
        transition: height ${CONFIG.containerAnimationDuration}ms ease, padding-bottom ${CONFIG.containerAnimationDuration}ms ease, padding-left ${CONFIG.containerAnimationDuration}ms ease;
        display: flex;
        align-items: flex-end;
        justify-content: flex-start;
        padding-bottom: 0px;
        padding-left: 0px;
        z-index: 4;
        /* Width will be set by sync logic */
      `;
  
      pileContainer = document.createElement("div");
      pileContainer.id = "zen-dismissed-pile-container";
      pileContainer.className = "zen-dismissed-pile";
      
      // Adjusted styles for pileContainer (now relative within sizer)
      pileContainer.style.cssText = `
        position: relative; /* Changed from fixed */
        z-index: 1; /* Lower z-index as it's contained */
        /* top, left, bottom, right removed */
        /* opacity, display, and their transitions removed - parent handles visibility */
        /* pointer-events will be set on dynamicSizer when shown */
      `;
  
      // Create floating downloads button
      const downloadsButton = document.createElement("button");
      downloadsButton.id = "zen-pile-downloads-button";
      downloadsButton.innerHTML = "Full list";
      downloadsButton.title = "Open Firefox Downloads";
      downloadsButton.style.cssText = `
        position: absolute;
        top: 5px;
        left: 5px;
        width: 50px;
        height: 20px;
        border: none;
        border-radius: 4px;
        background: light-dark(rgba(0, 0, 0, 1), rgba(255, 255, 255, 0.3));
        color: light-dark(rgb(255,255,255), rgb(0,0,0));
        font-size: 10px;
        cursor: pointer;
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 10;
        transition: background 0.2s ease;
        margin-top: 30px;
      `;
  
      // Add hover effect
      downloadsButton.addEventListener('mouseenter', () => {
        downloadsButton.style.background = 'light-dark(rgba(0, 0, 0, 0.8), rgba(255, 255, 255, 0.2))';
      });
      downloadsButton.addEventListener('mouseleave', () => {
        downloadsButton.style.background = 'light-dark(rgba(0, 0, 0, 1), rgba(255, 255, 255, 0.3))';
      });
  
      // Add click handler to open downloads
      downloadsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
          // Try to open the downloads panel
          if (window.DownloadsPanel) {
            window.DownloadsPanel.showDownloadsHistory();
          } else if (window.PlacesCommandHook) {
            window.PlacesCommandHook.showPlacesOrganizer('Downloads');
          } else {
            // Fallback: open downloads page
            window.openTrustedLinkIn('about:downloads', 'tab');
          }
          debugLog("Opened Firefox downloads");
        } catch (error) {
          debugLog("Error opening downloads:", error);
        }
      });
  
      // Append button to dynamicSizer (not pileContainer so it stays at top)
      dynamicSizer.appendChild(downloadsButton);
  
      // Append pileContainer to dynamicSizer
      dynamicSizer.appendChild(pileContainer);
  
      // Always append to document.body for maximum z-index control
      document.body.appendChild(dynamicSizer);
      debugLog("Created pile container and dynamic sizer, appended to document.body");
    }
  
    // Setup event listeners
    function setupEventListeners() {
      // Listen for pod dismissals from main script
      window.zenTidyDownloads.onPodDismissed((podData) => {
        debugLog("Received pod dismissal:", podData);
        addPodToPile(podData);
      });
  
      // Download button hover events
      if (downloadButton) {
        downloadButton.addEventListener('mouseenter', handleDownloadButtonHover);
        downloadButton.addEventListener('mouseleave', handleDownloadButtonLeave);
      }
  
      // Also listen for hover on the main download cards container area
      const mainDownloadContainer = document.getElementById('userchrome-download-cards-container');
      if (mainDownloadContainer) {
        mainDownloadContainer.addEventListener('mouseenter', handleDownloadButtonHover);
        mainDownloadContainer.addEventListener('mouseleave', handleDownloadButtonLeave);
        debugLog("Added hover listeners to main download cards container");
      }
  
      // Dynamic sizer hover events (keep container open when cursor is inside)
      if (dynamicSizer) {
        dynamicSizer.addEventListener('mouseenter', handleDynamicSizerHover);
        dynamicSizer.addEventListener('mouseleave', handleDynamicSizerLeave);
        debugLog("Added hover listeners to dynamic sizer");
      }
  
      // Pile container hover events
      pileContainer.addEventListener('mouseenter', handlePileHover);
      pileContainer.addEventListener('mouseleave', handlePileLeave);
  
      // Window resize handler
      window.addEventListener('resize', debounce(recalculateLayout, 250));
  
      // Listen for actual download removals from Firefox list (via main script)
      if (window.zenTidyDownloads && typeof window.zenTidyDownloads.onActualDownloadRemoved === 'function') {
        window.zenTidyDownloads.onActualDownloadRemoved((removedKey) => {
          debugLog(`[PileSync] Received actual download removal notification for key: ${removedKey}`);
          if (dismissedPods.has(removedKey)) {
            removePodFromPile(removedKey);
            debugLog(`[PileSync] Removed pod ${removedKey} from pile as it was cleared from Firefox list.`);
          }
        });
        debugLog("[PileSync] Registered listener for actual download removals.");
      } else {
        debugLog("[PileSync] Could not register listener for actual download removals - API not found on main script.");
      }
  
      debugLog("Event listeners setup complete");
    }
  
    // Load any existing dismissed pods from main script
    function loadExistingDismissedPods() {
      const existingPods = window.zenTidyDownloads.dismissedPods.getAll();
      existingPods.forEach((podData, key) => {
        addPodToPile(podData, false); // Don't animate existing pods
      });
      debugLog(`Loaded ${existingPods.size} existing dismissed pods`);
    }
  
    // Add a pod to the pile
    function addPodToPile(podData, animate = true) {
      if (!podData || !podData.key) {
        debugLog("Invalid pod data for pile addition");
        return;
      }
  
      // Limit pile size
      if (dismissedPods.size >= CONFIG.maxPileSize) {
        const oldestKey = Array.from(dismissedPods.keys())[0];
        removePodFromPile(oldestKey);
      }
  
      // Store pod data
      dismissedPods.set(podData.key, podData);
  
      // Create DOM element
      const podElement = createPodElement(podData);
      podElements.set(podData.key, podElement);
      pileContainer.appendChild(podElement);
  
      // Generate pile position
      generatePilePosition(podData.key);
  
      // Generate grid position
      generateGridPosition(podData.key);
  
      // Apply initial pile position
      applyPilePosition(podData.key, animate);
  
      // Update pile visibility
      updatePileVisibility();
  
      // Update downloads button visibility
      updateDownloadsButtonVisibility();
  
      debugLog(`Added pod to pile: ${podData.filename}`);
    }
  
    // Create a DOM element for a dismissed pod
    function createPodElement(podData) {
      const pod = document.createElement("div");
      pod.className = "dismissed-pod";
      pod.dataset.podKey = podData.key;
      pod.title = `${podData.filename}\nClick: Open file\nDouble-click: Restore to downloads\nRight-click: Delete permanently`;
      
      pod.style.cssText = `
        position: absolute;
        width: 45px;
        height: 45px;
        border-radius: 8px;
        overflow: hidden;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        transition: transform ${CONFIG.animationDuration}ms cubic-bezier(0.4, 0, 0.2, 1);
        will-change: transform;
      `;
  
      // Create preview content
      const preview = document.createElement("div");
      preview.className = "dismissed-pod-preview";
      preview.style.cssText = `
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #2a2a2a;
        color: white;
        font-size: 20px;
      `;
  
      // Set preview content
      if (podData.previewData) {
        if (podData.previewData.type === 'image' && podData.previewData.src) {
          const img = document.createElement("img");
          img.src = podData.previewData.src;
          img.style.cssText = `
            width: 100%;
            height: 100%;
            object-fit: cover;
          `;
          img.onerror = () => {
            preview.innerHTML = getFileIcon(podData.contentType);
          };
          preview.appendChild(img);
        } else if (podData.previewData.html) {
          preview.innerHTML = podData.previewData.html;
        } else {
          preview.innerHTML = getFileIcon(podData.contentType);
        }
      } else {
        preview.innerHTML = getFileIcon(podData.contentType);
      }
  
      pod.appendChild(preview);
  
      // Add click handler for opening in file explorer
      pod.addEventListener('click', () => {
        debugLog(`Attempting to open file in explorer: ${podData.key}`);
        if (podData.targetPath) {
          try {
            const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
            file.initWithPath(podData.targetPath);
            
            if (file.exists()) {
              // Open file with default application
              file.launch();
              debugLog(`Successfully opened file: ${podData.filename}`);
            } else {
              // File doesn't exist, try to open the containing folder
              const parentDir = file.parent;
              if (parentDir && parentDir.exists()) {
                parentDir.launch();
                debugLog(`File not found, opened containing folder: ${podData.filename}`);
              } else {
                debugLog(`File and folder not found: ${podData.filename}`);
              }
            }
          } catch (error) {
            debugLog(`Error opening file in explorer: ${podData.filename}`, error);
          }
        } else {
          debugLog(`No file path available for: ${podData.filename}`);
        }
      });
  
      // Add double-click handler for restoration
      pod.addEventListener('dblclick', () => {
        debugLog(`Attempting to restore pod: ${podData.key}`);
        window.zenTidyDownloads.restorePod(podData.key).then(success => {
          if (success) {
            removePodFromPile(podData.key);
            debugLog(`Successfully restored pod: ${podData.filename}`);
          } else {
            debugLog(`Failed to restore pod: ${podData.filename}`);
          }
        });
      });
  
      // Add right-click handler for permanent deletion
      pod.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (confirm(`Permanently delete "${podData.filename}" from pile?`)) {
          window.zenTidyDownloads.permanentDelete(podData.key);
          removePodFromPile(podData.key);
          debugLog(`Permanently deleted pod: ${podData.filename}`);
        }
      });
  
      return pod;
    }
  
    // Get file icon based on content type
    function getFileIcon(contentType) {
      if (!contentType) return "📄";
      
      if (contentType.includes("image/")) return "🖼️";
      if (contentType.includes("video/")) return "🎬";
      if (contentType.includes("audio/")) return "🎵";
      if (contentType.includes("text/")) return "📝";
      if (contentType.includes("application/pdf")) return "📕";
      if (contentType.includes("application/zip") || contentType.includes("application/x-rar")) return "🗜️";
      if (contentType.includes("application/")) return "📦";
      
      return "📄";
    }
  
    // Generate random pile position for a pod
    function generatePilePosition(podKey) {
      const angle = (Math.random() - 0.5) * CONFIG.pileRotationRange * 2;
      const offsetX = (Math.random() - 0.5) * CONFIG.pileOffsetRange * 2;
      const offsetY = (Math.random() - 0.5) * CONFIG.pileOffsetRange * 2;
      
      // Newer pods should have higher z-index to appear on top
      // Get the order of this pod in the dismissedPods map (newer = higher index)
      const pods = Array.from(dismissedPods.keys());
      const podIndex = pods.indexOf(podKey);
      const zIndex = podIndex + 1; // Start from 1, newer pods get higher z-index
  
      pilePositions.set(podKey, {
        x: offsetX,
        y: offsetY,
        rotation: angle,
        zIndex: zIndex
      });
      
      debugLog(`Generated pile position for ${podKey}:`, {
        index: podIndex,
        zIndex,
        angle,
        offsetX,
        offsetY
      });
    }
  
    // Generate grid position for a pod
    function generateGridPosition(podKey) {
      const pods = Array.from(dismissedPods.keys());
      const index = pods.indexOf(podKey);
      if (index === -1) return;
  
      // 2x3 grid: 2 rows, 3 columns
      // First pod (index 0) stays at (0,0) - becomes the anchor
      // Other pods position relative to the first pod
      const cols = 3;
      const maxRows = 2;
      
      const col = index % cols; // Column: 0, 1, 2, 0, 1, 2, ...
      const logicalRow = Math.floor(index / cols); // Which row logically: 0, 0, 0, 1, 1, 1, ...
      const visualRow = logicalRow % maxRows; // 0 = bottom row, 1 = top row
      
      const podSize = CONFIG.minPodSize;
      const spacing = CONFIG.gridPadding;
      
      // First pod stays at origin (0,0) - this is our anchor
      // Other pods position relative to it
      let x, y;
      
      if (index === 0) {
        // First pod stays at pile position
        x = 0;
        y = 0;
      } else {
        // Other pods arrange in grid pattern relative to first pod
        x = col * (podSize + spacing);
        y = -visualRow * (podSize + spacing); // Negative Y grows upward
      }
  
      gridPositions.set(podKey, { x, y, row: logicalRow, col });
      
      debugLog(`Anchor-based Grid position for ${podKey}:`, {
        index,
        col,
        logicalRow,
        visualRow,
        x,
        y,
        isAnchor: index === 0,
        description: visualRow === 0 ? 'bottom row' : 'top row'
      });
    }
  
    // Apply pile position to a pod
    function applyPilePosition(podKey, animate = true) {
      const podElement = podElements.get(podKey);
      const position = pilePositions.get(podKey);
      if (!podElement || !position) return;
  
      const transform = `translate3d(${position.x}px, ${position.y}px, 0) rotate(${position.rotation}deg)`;
      
      if (!animate) {
        podElement.style.transition = 'none';
      }
      
      podElement.style.transform = transform;
      podElement.style.zIndex = position.zIndex;
      
      if (!animate) {
        // Re-enable transitions after position is set
        requestAnimationFrame(() => {
          podElement.style.transition = `transform ${CONFIG.animationDuration}ms cubic-bezier(0.4, 0, 0.2, 1)`;
        });
      }
    }
  
    // Apply grid position to a pod
    function applyGridPosition(podKey, delay = 0) {
      const podElement = podElements.get(podKey);
      const position = gridPositions.get(podKey);
      if (!podElement || !position) return;
  
      setTimeout(() => {
        const transform = `translate3d(${position.x}px, ${position.y}px, 0) rotate(0deg)`;
        podElement.style.transform = transform;
        podElement.style.zIndex = 10; // Normalize z-index in grid
      }, delay);
    }
  
    // Remove a pod from the pile
    function removePodFromPile(podKey) {
      const podElement = podElements.get(podKey);
      if (podElement) {
        podElement.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        podElement.style.opacity = '0';
        podElement.style.transform += ' scale(0.8)';
        
        setTimeout(() => {
          if (podElement.parentNode) {
            podElement.parentNode.removeChild(podElement);
          }
        }, 300);
      }
  
      dismissedPods.delete(podKey);
      podElements.delete(podKey);
      pilePositions.delete(podKey);
      gridPositions.delete(podKey);
  
      // Recalculate grid positions for remaining pods
      dismissedPods.forEach((_, key) => generateGridPosition(key));
      
      // updatePileVisibility will handle sizer height if needed
      updatePileVisibility(); // This will now call showPile/hidePile which adjust sizer
  
      // Update downloads button visibility
      updateDownloadsButtonVisibility();
    }
  
    // Update pile visibility based on pod count
    function updatePileVisibility() {
      if (dismissedPods.size === 0) {
        // If pile becomes empty, hide it (will set sizer height to 0)
        if (dynamicSizer.style.height !== '0px') { // only if not already hidden
            hidePile(); 
        }
      } else {
        // If pile has items, ensure it's "shown" (height will be set)
        // showPile() will be called on hover, this just ensures initial state if pods loaded
        // updatePilePosition(); // This function will be revised/removed
        
        // Show only the top few pods in pile mode
        let visibleCount = 0;
        const sortedPods = Array.from(dismissedPods.keys()).reverse(); // Newest first
        
        sortedPods.forEach(podKey => {
          const podElement = podElements.get(podKey);
          if (!podElement) return;
          
          if (visibleCount < CONFIG.pileDisplayCount) {
            podElement.style.display = 'block';
            visibleCount++;
          } else if (!isGridMode) {
            podElement.style.display = 'none';
          } else {
            podElement.style.display = 'block'; // Show all in grid mode
          }
        });
        // If it's not already visible (e.g. initial load with pods), and it's supposed to be hovered to show,
        // this function shouldn't force it open. showPile handles that.
        // However, if it *is* already open (sizer height > 0) and a pod is added/removed,
        // we might need to re-evaluate the sizer height if it's dynamic.
        // For now, showPile/hidePile will manage sizer height.
      }
    }
  
    // Update pile position relative to download button
    function updatePilePosition() {
      // This function is largely obsolete as the pile is now in-flow within dynamicSizer.
      // Width will be handled by updatePileContainerWidth.
      // Height will be handled by showPile/hidePile.
      debugLog("updatePilePosition called, but largely obsolete now.");
      // If dynamicSizer exists and we need to ensure its width is up-to-date:
      if (typeof updatePileContainerWidth === 'function') {
          // updatePileContainerWidth(); // Call this if needed, but it's called on showPile
      }
    }
  
    // Download button hover handler
    function handleDownloadButtonHover() {
      if (dismissedPods.size === 0) return;
      
      // Check if main download script has active pods and disable hover if so
      if (shouldDisableHover()) {
        debugLog("[HoverDisabled] Pile hover disabled - main download script has active pods");
        return;
      }
  
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => {
        showPile();
      }, CONFIG.hoverDebounceMs);
    }
  
    // Download button leave handler
    function handleDownloadButtonLeave() {
      if (shouldDisableHover()) {
        return; // Don't process leave events if hover is disabled
      }
      
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => {
        const mainDownloadContainer = document.getElementById('userchrome-download-cards-container');
        const isHoveringDownloadArea = downloadButton?.matches(':hover') || mainDownloadContainer?.matches(':hover');
        
        // Only hide if cursor is not over download area AND not over pile components
        if (!isHoveringDownloadArea && !pileContainer.matches(':hover') && !dynamicSizer.matches(':hover')) {
          hidePile();
        }
      }, CONFIG.hoverDebounceMs);
    }
  
    // Dynamic sizer hover handler  
    function handleDynamicSizerHover() {
      clearTimeout(hoverTimeout);
      if (dismissedPods.size > 0) {
        showPile(); // Ensure pile stays open when hovering the sizer
      }
    }
  
    // Dynamic sizer leave handler
    function handleDynamicSizerLeave() {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => {
        const mainDownloadContainer = document.getElementById('userchrome-download-cards-container');
        const isHoveringDownloadArea = downloadButton?.matches(':hover') || mainDownloadContainer?.matches(':hover');
        
        // Only hide if not hovering download area AND not hovering pile container
        if (!isHoveringDownloadArea && !pileContainer.matches(':hover')) {
          hidePile();
        }
      }, CONFIG.hoverDebounceMs);
    }
  
    // Pile hover handler
    function handlePileHover() {
      clearTimeout(hoverTimeout);
      if (!isGridMode) {
        transitionToGrid();
      }
    }
  
    // Pile leave handler
    function handlePileLeave() {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => {
        const mainDownloadContainer = document.getElementById('userchrome-download-cards-container');
        const isHoveringDownloadArea = downloadButton?.matches(':hover') || mainDownloadContainer?.matches(':hover');
        
        // Only hide if not hovering download area AND not hovering dynamic sizer
        if (!isHoveringDownloadArea && !dynamicSizer.matches(':hover')) {
          hidePile();
        }
      }, CONFIG.hoverDebounceMs);
    }
  
    // Show the pile
    function showPile() {
      if (dismissedPods.size === 0 || !dynamicSizer) return;
      
      // Ensure width is set before calculating positions
      if (typeof updatePileContainerWidth === 'function') {
          updatePileContainerWidth();
      }
  
      // Calculate exact position based on sidebar location
      const navigatorToolbox = document.getElementById('navigator-toolbox');
      if (navigatorToolbox) {
        const rect = navigatorToolbox.getBoundingClientRect();
        const isRightSide = document.documentElement.getAttribute('zen-right-side') === 'true';
        
        if (isRightSide) {
          // Position on the right side
          const containerWidth = parseFloat(currentZenSidebarWidthForPile) || 300;
          dynamicSizer.style.left = `${rect.right - containerWidth}px`;
        } else {
          // Position on the left side
          dynamicSizer.style.left = `${rect.left}px`;
        }
        
        debugLog("Positioned pile based on sidebar location", {
          sidebarRect: rect,
          isRightSide,
          finalLeft: dynamicSizer.style.left
        });
      }
  
      // Calculate smart left padding so the GRID will be centered when it forms
      const containerWidth = parseFloat(currentZenSidebarWidthForPile) || 300;
      const cols = 3;
      const podSize = CONFIG.minPodSize;
      const spacing = CONFIG.gridPadding;
      
      // Calculate total grid dimensions
      const gridWidth = (cols * podSize) + ((cols - 1) * spacing);
      
      // Calculate where the grid should be positioned to be centered
      const gridCenterX = containerWidth / 2;
      const gridLeftEdge = gridCenterX - (gridWidth / 2);
      
      // The first pod (index 0) will be at the bottom-left of the grid
      // So position the pile so the first pod ends up at the grid's left edge
      // Divide by 4 to correct for excessive padding
      const smartLeftPadding = Math.max(gridLeftEdge / 4, 10) + 10; // minimum 10px padding + 10px extra
      
      dynamicSizer.style.pointerEvents = 'auto';
      dynamicSizer.style.paddingBottom = '60px';
      dynamicSizer.style.paddingLeft = `${smartLeftPadding}px`;
      
      // Set container height
      const gridHeight = (CONFIG.minPodSize * 2) + 100;
      dynamicSizer.style.height = `${gridHeight}px`; 
      
      debugLog("Showing pile positioned for centered grid", {
        containerWidth,
        gridWidth,
        gridCenterX,
        gridLeftEdge,
        smartLeftPadding,
        note: "First pod will be at grid's left edge"
      });
    }
  
    // Hide the pile
    function hidePile() {
      if (!dynamicSizer) return;
  
      dynamicSizer.style.pointerEvents = 'none';
      dynamicSizer.style.height = '0px';
      dynamicSizer.style.paddingBottom = '0px'; // Remove padding when hiding
      dynamicSizer.style.paddingLeft = '0px'; // Remove left padding when hiding
      
      if (isGridMode) {
        transitionToPile(); // Transition back to pile state if in grid
      }
      
      debugLog("Hiding dismissed downloads pile by collapsing sizer");
    }
  
    // Transition from pile to grid
    function transitionToGrid() {
      if (isGridMode) return;
      
      isGridMode = true;
      debugLog("Transitioning to grid mode");
  
      // No need to change justify-content - positioning handled by padding
  
      // Get only the last 6 pods (most recent)
      const allPods = Array.from(dismissedPods.keys());
      const lastSixPods = allPods.slice(-6); // Get the last 6 pods
      
      debugLog(`Showing ${lastSixPods.length} of ${allPods.length} pods in grid`, lastSixPods);
  
      // Show only the last 6 pods, hide the rest
      dismissedPods.forEach((_, podKey) => {
        const podElement = podElements.get(podKey);
        if (!podElement) return;
        
        if (lastSixPods.includes(podKey)) {
          // This pod should be shown in the grid
          podElement.style.display = 'block';
        } else {
          // This pod should be hidden in grid mode
          podElement.style.display = 'none';
        }
      });
  
      // Regenerate grid positions for only the last 6 pods using anchor-based approach
      lastSixPods.forEach((podKey, index) => {
        const cols = 3;
        const maxRows = 2;
        
        const col = index % cols;
        const logicalRow = Math.floor(index / cols);
        const visualRow = logicalRow % maxRows;
        
        const podSize = CONFIG.minPodSize;
        const spacing = CONFIG.gridPadding;
        
        // First pod (index 0) stays at anchor position (0,0)
        // Other pods arrange relative to it
        let x, y;
        
        if (index === 0) {
          // First pod stays at anchor
          x = 0;
          y = 0;
        } else {
          // Other pods in grid pattern
          x = col * (podSize + spacing);
          y = -visualRow * (podSize + spacing);
        }
  
        gridPositions.set(podKey, { x, y, row: logicalRow, col });
      });
  
      // Animate pods to grid positions with staggered timing
      let delay = 0;
      lastSixPods.forEach(podKey => {
        applyGridPosition(podKey, delay);
        delay += CONFIG.gridAnimationDelay;
      });
    }
  
    // Transition from grid to pile
    function transitionToPile() {
      if (!isGridMode) return;
      
      isGridMode = false;
      debugLog("Transitioning to pile mode");
  
      // No need to change justify-content - positioning handled by padding
  
      // Animate pods back to pile positions
      dismissedPods.forEach((_, podKey) => {
        applyPilePosition(podKey, true);
      });
  
      // Hide excess pods after animation
      setTimeout(() => {
        updatePileVisibility();
      }, CONFIG.animationDuration);
    }
  
    // Recalculate layout on window resize
    function recalculateLayout() {
      if (dismissedPods.size === 0) return;
  
      // Regenerate grid positions
      dismissedPods.forEach((_, podKey) => {
        generateGridPosition(podKey);
      });
  
      // Recalculate fixed position if pile is currently shown
      if (dynamicSizer && dynamicSizer.style.height !== '0px') {
        const navigatorToolbox = document.getElementById('navigator-toolbox');
        if (navigatorToolbox) {
          const rect = navigatorToolbox.getBoundingClientRect();
          const isRightSide = document.documentElement.getAttribute('zen-right-side') === 'true';
          
          if (isRightSide) {
            const containerWidth = parseFloat(currentZenSidebarWidthForPile) || 300;
            dynamicSizer.style.left = `${rect.right - containerWidth}px`;
          } else {
            dynamicSizer.style.left = `${rect.left}px`;
          }
          
          debugLog("Recalculated pile position on resize", {
            newLeft: dynamicSizer.style.left
          });
        }
      }
  
      // Apply current mode positions
      if (isGridMode) {
        dismissedPods.forEach((_, podKey) => {
          applyGridPosition(podKey, 0);
        });
      }
    }
  
    // Utility: Debounce function
    function debounce(func, wait) {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    }
  
    // --- Pile Container Width Synchronization Logic ---
    function updatePileContainerWidth() {
      if (!dynamicSizer) {
        debugLog('[PileWidthSync] dynamicSizer not found. Cannot set width.');
        return;
      }
  
      const navigatorToolbox = document.getElementById('navigator-toolbox');
      let newWidth = '';
  
      if (navigatorToolbox) {
        const value = getComputedStyle(navigatorToolbox).getPropertyValue('--zen-sidebar-width').trim();
        if (value && value !== "0px" && value !== "") {
          newWidth = value;
          debugLog('[PileWidthSync] Using --zen-sidebar-width from #navigator-toolbox:', newWidth);
        }
      }
  
      if (!newWidth) {
        const sidebarBox = document.getElementById('sidebar-box');
        if (sidebarBox && sidebarBox.clientWidth > 0) {
          newWidth = `${sidebarBox.clientWidth}px`;
          debugLog('[PileWidthSync] Using #sidebar-box.clientWidth as fallback:', newWidth);
        } else {
          newWidth = '300px'; // Last resort default
          debugLog('[PileWidthSync] Using default width (300px) as final fallback.');
        }
      }
  
      // Update the global variable and set the width (not max-width since we're fixed positioned)
      currentZenSidebarWidthForPile = newWidth;
      
      // Subtract 5px to prevent protruding beyond sidebar
      const numericWidth = parseFloat(newWidth);
      const adjustedWidth = `${numericWidth + 5}px`;
      dynamicSizer.style.width = adjustedWidth;
      debugLog('[PileWidthSync] Set dynamicSizer width to:', adjustedWidth, '(original:', newWidth, ')');
    }
  
    function initPileSidebarWidthSync() {
      // This function is now unused - width is only read on-demand in showPile()
      debugLog('[PileWidthSync] initPileSidebarWidthSync called but automatic sync is disabled to prevent feedback loops.');
    }
    // --- End Pile Container Width Synchronization Logic ---
  
    // Helper function to capture pod data for dismissal
    function capturePodDataForDismissal(downloadKey) {
      const cardData = activeDownloadCards.get(downloadKey);
      if (!cardData || !cardData.download) {
        debugLog(`[Dismiss] No card data found for capturing: ${downloadKey}`);
        return null;
      }
      
      const download = cardData.download;
      const podElement = cardData.podElement;
      
      // Capture essential data for pile reconstruction
      const dismissedData = {
        key: downloadKey,
        filename: download.aiName || cardData.originalFilename || getSafeFilename(download),
        originalFilename: cardData.originalFilename,
        fileSize: download.currentBytes || download.totalBytes || 0,
        contentType: download.contentType,
        targetPath: download.target?.path,
        sourceUrl: download.source?.url,
        startTime: download.startTime,
        endTime: download.endTime,
        dismissTime: Date.now(),
        wasRenamed: !!download.aiName,
        // Capture preview data
        previewData: null,
        dominantColor: podElement?.dataset?.dominantColor || null
      };
      
      // Try to capture preview image data
      if (podElement) {
        const previewContainer = podElement.querySelector('.card-preview-container');
        if (previewContainer) {
          const img = previewContainer.querySelector('img');
          if (img && img.src) {
            dismissedData.previewData = {
              type: 'image',
              src: img.src
            };
          } else {
            // Capture icon/text preview
            dismissedData.previewData = {
              type: 'icon',
              html: previewContainer.innerHTML
            };
          }
        }
      }
      
      debugLog(`[Dismiss] Captured pod data for pile:`, dismissedData);
      return dismissedData;
    }
  
    // Update downloads button visibility based on number of dismissed pods
    function updateDownloadsButtonVisibility() {
      const downloadsButton = document.getElementById("zen-pile-downloads-button");
      if (!downloadsButton) return;
      
      if (dismissedPods.size > 6) {
        downloadsButton.style.display = "flex";
        debugLog(`[DownloadsButton] Showing button - ${dismissedPods.size} dismissed pods`);
      } else {
        downloadsButton.style.display = "none";
        debugLog(`[DownloadsButton] Hiding button - only ${dismissedPods.size} dismissed pods`);
      }
    }
  
    // Check if main download script has active pods to disable hover
    function shouldDisableHover() {
      try {
        // Check if main download script is available and has active cards
        if (window.zenTidyDownloads?.activeDownloadCards?.size > 0) {
          debugLog(`[HoverCheck] Main script has ${window.zenTidyDownloads.activeDownloadCards.size} active pods - disabling pile hover`);
          return true;
        }
        
        // Alternative check: look for visible download pods in the DOM
        const mainContainer = document.getElementById('userchrome-download-cards-container');
        if (mainContainer && mainContainer.style.display !== 'none' && mainContainer.style.opacity !== '0') {
          const visiblePods = mainContainer.querySelectorAll('.download-pod:not([style*="opacity: 0"])');
          if (visiblePods.length > 0) {
            debugLog(`[HoverCheck] Found ${visiblePods.length} visible pods in main container - disabling pile hover`);
            return true;
          }
        }
        
        return false;
      } catch (error) {
        debugLog(`[HoverCheck] Error checking main script state:`, error);
        return false;
      }
    }
  
    // Initialize when DOM is ready
    if (document.readyState === "complete") {
      init();
    } else {
      window.addEventListener("load", init, { once: true });
    }
  
    debugLog("Dismissed downloads pile script loaded");
  
  })(); 