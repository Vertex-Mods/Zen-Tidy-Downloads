// ==UserScript==
// @include   main
// @loadOrder 99999999999999
// @ignorecache
// ==/UserScript==

// zen-stuff-core.uc.js
// PileState model, ErrorHandler, FileSystem helpers, EventManager (listener registry + cleanup).
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  class PileState {
    constructor() {
      this.downloadButton = null;
      this.pileContainer = null;
      this.dynamicSizer = null;
      this.hoverBridge = null;
      this.hoverTimeout = null;
      this.dismissedPods = new Map();
      this.podElements = new Map();
      this.pilePositions = new Map();
      this.gridPositions = new Map();
      this.isInitialized = false;
      this.isTransitioning = false;
      this.isAltPressed = false;
      this.currentZenSidebarWidthForPile = "";
      this.retryCount = 0;
      this.eventListeners = new Map();
      this.prefObserver = null;
      this.pendingPileClose = false;
      this.gridScrollIndex = 0;
      this.visibleGridOrder = [];
      this.carouselStartIndex = 0;
      this.isGridAnimating = false;
      this.workspaceScrollboxStyle = null;
      this.isEditing = false;
      this.recentlyRemoved = false;
      this.mediaToolbarMaskRemovalTimeout = null;
      this.pileContextMenuActive = false;
      this.pileRepairDebounceId = null;
      this.lastPileRepairAt = 0;
      this.pileLayoutRepairIntervalId = null;
    }

    getPodData(key) {
      return this.dismissedPods.get(key) || null;
    }

    getPodElement(key) {
      return this.podElements.get(key) || null;
    }

    getPilePosition(key) {
      return this.pilePositions.get(key) || null;
    }

    getGridPosition(key) {
      return this.gridPositions.get(key) || null;
    }

    setPodData(key, data) {
      if (key && data) {
        this.dismissedPods.set(key, data);
      }
    }

    setPodElement(key, element) {
      if (key && element) {
        this.podElements.set(key, element);
      }
    }

    removePod(key) {
      this.dismissedPods.delete(key);
      this.podElements.delete(key);
      this.pilePositions.delete(key);
      this.gridPositions.delete(key);
    }

    clearAll() {
      this.dismissedPods.clear();
      this.podElements.clear();
      this.pilePositions.clear();
      this.gridPositions.clear();
    }
  }

  class ErrorHandler {
    static handleError(error, context, fallback = null) {
      console.error(`[Dismissed Pile] Error in ${context}:`, error);
      return fallback;
    }

    static async withRetry(operation, maxAttempts = 3, delay = 1000) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await operation();
        } catch (error) {
          if (attempt === maxAttempts) {
            throw error;
          }
          console.warn(`[Dismissed Pile] Attempt ${attempt} failed, retrying in ${delay}ms:`, error);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  /**
   * @param {{ validateFilePathOrThrow: function(string): string }} ctx
   */
  function createFileSystemApi(ctx) {
    const { validateFilePathOrThrow } = ctx;

    return {
      async createFileInstance(path) {
        try {
          const validatedPath = validateFilePathOrThrow(path);
          const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
          file.initWithPath(validatedPath);
          return file;
        } catch (error) {
          throw new Error(`Failed to create file instance: ${error.message}`);
        }
      },

      async fileExists(path) {
        try {
          const file = await this.createFileInstance(path);
          return file.exists();
        } catch (error) {
          console.warn(`[FileSystem] Error checking file existence: ${error.message}`);
          return false;
        }
      },

      async getParentDirectory(path) {
        try {
          const file = await this.createFileInstance(path);
          return file.parent;
        } catch (error) {
          throw new Error(`Failed to get parent directory: ${error.message}`);
        }
      },

      async getAvailableFilename(parentDir, baseName, ext) {
        let candidate = baseName + ext;
        let counter = 1;
        let file = parentDir.clone();
        file.append(candidate);
        while (file.exists()) {
          candidate = `${baseName} (${counter})${ext}`;
          file = parentDir.clone();
          file.append(candidate);
          counter++;
        }
        return candidate;
      },

      async renameFile(oldPath, newFilename) {
        try {
          const oldFile = await this.createFileInstance(oldPath);
          if (!oldFile.exists()) {
            throw new Error("Source file does not exist");
          }

          const parentDir = oldFile.parent;
          const dotIdx = newFilename.lastIndexOf(".");
          let baseName = newFilename;
          let ext = "";
          if (dotIdx > 0) {
            baseName = newFilename.substring(0, dotIdx);
            ext = newFilename.substring(dotIdx);
          }
          const availableName = await this.getAvailableFilename(parentDir, baseName, ext);
          const newFile = parentDir.clone();
          newFile.append(availableName);
          oldFile.moveTo(parentDir, availableName);
          return newFile.path;
        } catch (error) {
          throw new Error(`Failed to rename file: ${error.message}`);
        }
      },

      async deleteFile(path) {
        try {
          const file = await this.createFileInstance(path);
          if (file.exists()) {
            file.remove(false);
            return true;
          }
          return false;
        } catch (error) {
          throw new Error(`Failed to delete file: ${error.message}`);
        }
      }
    };
  }

  /**
   * @param {{ state: { eventListeners: Map } }} ctx
   */
  function createEventManagerApi(ctx) {
    const { state } = ctx;

    return {
      addEventListener(element, event, handler, options = {}) {
        if (!element || !handler) {
          console.warn("[EventManager] Invalid element or handler for event listener");
          return;
        }

        element.addEventListener(event, handler, options);

        const key = `${element.id || "unknown"}-${event}`;
        if (!state.eventListeners.has(key)) {
          state.eventListeners.set(key, []);
        }
        state.eventListeners.get(key).push({ element, event, handler, options });
      },

      removeEventListener(element, event, handler) {
        if (!element || !handler) return;

        element.removeEventListener(event, handler);

        const key = `${element.id || "unknown"}-${event}`;
        const listeners = state.eventListeners.get(key);
        if (listeners) {
          const index = listeners.findIndex((l) => l.handler === handler);
          if (index !== -1) {
            listeners.splice(index, 1);
          }
        }
      },

      cleanupAll() {
        for (const [, listeners] of state.eventListeners) {
          for (const { element, event, handler } of listeners) {
            try {
              element.removeEventListener(event, handler);
            } catch (error) {
              console.warn(`[EventManager] Error removing event listener: ${error.message}`);
            }
          }
        }
        state.eventListeners.clear();
      }
    };
  }

  window.zenStuffCore = {
    PileState,
    ErrorHandler,
    createFileSystemApi,
    createEventManagerApi
  };
})();
