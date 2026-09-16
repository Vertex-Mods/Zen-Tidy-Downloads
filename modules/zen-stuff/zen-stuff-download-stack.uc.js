// ==UserScript==
// @include   main
// @loadOrder 99999999999998
// @ignorecache
// ==/UserScript==

// zen-stuff-download-stack.uc.js
// Native-aligned download stack implementation (matches ZenLibraryDownloadStack)
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  // Single flight pattern
  if (window.__zenStuffDownloadStackExecuted) {
    return;
  }
  window.__zenStuffDownloadStackExecuted = true;

  const ENTRIES = 4;
  const CLOSE_DELAY_MS = 200;

  // Wait for required APIs
  if (!window.Downloads || !window.Downloads.getList) {
    setTimeout(arguments.callee, 100);
    return;
  }

  // Get the Zen Library button
  function getLibraryButton() {
    const button = document.getElementById("zen-library-button");
    if (button) return button;
    // Fallback: find by attribute
    const buttons = document.querySelectorAll("toolbarbutton[command='cmd_zenToggleLibrary']");
    return buttons[0] || null;
  }

  // Create the download stack container (matches native: appended to #zen-sidebar-foot-buttons)
  function createStackContainer() {
    const footButtons = document.getElementById("zen-sidebar-foot-buttons");
    if (!footButtons) return null;

    const list = document.createElement("box");
    list.id = "zen-library-download-list";
    list.setAttribute("skipintoolbarset", "true");
    
    // Build 4 entries
    for (let i = 0; i < ENTRIES; i++) {
      const entry = document.createElement("div");
      entry.className = "zen-library-download-list-download";
      
      // Badge (matches native structure)
      const badge = document.createElement("span");
      badge.className = "zen-library-download-badge no-squircles";
      badge.innerHTML = '<span class="zen-library-download-progress"></span>';
      badge.id = i === ENTRIES - 1 ? "library-button-badge" : "";
      
      // Title container
      const titleContainer = document.createElement("vbox");
      titleContainer.className = "zen-library-download-list-title-container";
      
      const title = document.createElement("span");
      title.className = "zen-library-download-list-title";
      
      const subtitle = document.createElement("span");
      subtitle.className = "zen-library-download-list-subtitle";
      
      titleContainer.appendChild(title);
      titleContainer.appendChild(subtitle);
      
      // Action button
      const action = document.createElement("toolbarbutton");
      action.className = "toolbarbutton-1 zen-library-download-action no-squircles";
      
      entry.appendChild(badge);
      entry.appendChild(titleContainer);
      entry.appendChild(action);
      list.appendChild(entry);
    }

    footButtons.appendChild(list);
    return list;
  }

  // Initialize the stack
  function initStack() {
    const button = getLibraryButton();
    if (!button) {
      setTimeout(initStack, 100);
      return;
    }

    const list = createStackContainer();
    if (!list) {
      setTimeout(initStack, 100);
      return;
    }

    const entries = [...list.children];
    let downloads = [];
    let closeTimer = null;
    let contextMenuOpen = false;

    // Add badge to button (matches native: toolbarbutton-badge-stack-host)
    button.classList.add("toolbarbutton-badge-stack-host");
    const badgeStack = document.createElement("box");
    badgeStack.className = "toolbarbutton-badge-stack";
    badgeStack.innerHTML = '<span class="zen-library-download-badge no-squircles"><span class="zen-library-download-progress"></span></span>';
    button.appendChild(badgeStack);

    // Get badge reference
    const buttonBadge = button.querySelector(".zen-library-download-badge");
    if (buttonBadge) {
      buttonBadge.id = "library-button-badge";
    }

    // Downloads API integration (matches native: DownloadsCommon.getData)
    let downloadList = null;
    
    function getDownloadList() {
      if (downloadList) return downloadList;
      try {
        downloadList = window.Downloads.getList(window.Downloads.ALL);
      } catch (e) {
        console.error("[ZenStuff Stack] Error getting download list:", e);
      }
      return downloadList;
    }

    // Update the stack with current downloads
    function updateList() {
      const dl = getDownloadList();
      if (!dl) return;

      dl.getAll().then(allDownloads => {
        downloads = allDownloads || [];
        updateUI();
      });
    }

    // Update UI with downloads
    function updateUI() {
      const shown = downloads.slice(-ENTRIES);
      const unused = ENTRIES - shown.length;

      entries.forEach((entry, i) => {
        const download = shown[i - unused];
        entry.hidden = !download;
        entry.download = download ?? null;
        
        if (!download) return;

        updateBadge(entry.querySelector(".zen-library-download-badge"), download);
        entry.querySelector(".zen-library-download-list-title").textContent = 
          download.target?.path ? 
            download.target.path.split(/[\\/]/).pop() : 
            download.source?.url || "Untitled";
        entry.querySelector(".zen-library-download-list-subtitle").textContent = 
          getStatusText(download);
        
        entry.toggleAttribute("downloading", !download.stopped);
      });

      // Update button badge with newest download
      if (downloads.length > 0) {
        updateBadge(buttonBadge, downloads[downloads.length - 1]);
      }

      // Update badge showing state
      updateBadgeShowing();
    }

    // Update badge (matches native implementation)
    function updateBadge(badge, download) {
      if (!badge) return;
      
      const pending = download && !download.stopped || (download.canceled && download.hasPartialData);
      badge.toggleAttribute("downloading", pending);
      
      if (badge.parentElement && badge.parentElement.classList.contains("toolbarbutton-badge-stack")) {
        badge.parentElement.toggleAttribute("downloading", pending);
      }

      if (download) {
        const iconUrl = getIconUrl(download);
        badge.style.setProperty("--download-image", `url('${iconUrl}')`);
      }

      const progressEl = badge.querySelector(".zen-library-download-progress");
      if (progressEl) {
        progressEl.style.setProperty("--value", download?.hasProgress ? download.progress : 0);
      }
    }

    // Update whether badge is shown on button
    function updateBadgeShowing() {
      const footButtons = document.getElementById("zen-sidebar-foot-buttons");
      if (!footButtons) return;

      const newest = downloads[downloads.length - 1];
      const isPending = newest && (!newest.stopped || (newest.canceled && newest.hasPartialData));
      
      footButtons.toggleAttribute("zen-library-stack-open", false);
      footButtons.toggleAttribute("zen-library-badge", isPending);
    }

    // Status text (matches native)
    function getStatusText(download) {
      if (!download.stopped) {
        if (download.hasProgress) {
          const progress = Math.round(download.progress);
          const total = download.totalBytes || 0;
          const current = download.currentBytes || 0;
          const speed = download.speed || 0;
          
          if (speed > 0 && total > 0) {
            const remaining = Math.ceil((total - current) / speed / 1000);
            return `${formatBytes(current)} of ${formatBytes(total)} (${remaining}s left)`;
          }
          return `${progress}%`;
        }
        return "Starting...";
      }

      if (download.deleted) {
        return "File deleted";
      }

      if (download.succeeded) {
        if (!download.target?.exists) {
          return "File moved or missing";
        }
        const size = formatBytes(download.totalBytes || 0);
        const url = download.source?.url || "";
        const host = getHost(url);
        const date = formatDate(download.endTime);
        return [size, host, date].filter(Boolean).join(" · ");
      }

      if (download.canceled && download.hasPartialData) {
        return `Paused · ${formatBytes(download.currentBytes || 0)}`;
      }

      if (download.error?.becauseBlockedByParentalControls) {
        return "Blocked by parental controls";
      }

      if (download.error?.becauseBlockedByReputationCheck) {
        return "Blocked (malware)";
      }

      return download.canceled ? "Canceled" : "Failed";
    }

    // Icon URL (matches native)
    function getIconUrl(download) {
      if (!download.target?.path) {
        return "moz-icon://.unknown?size=32";
      }
      return `moz-icon://${download.target.path}?size=32${download.succeeded ? "&state=normal" : ""}`;
    }

    // Host extraction
    function getHost(url) {
      try {
        const uri = new URL(url);
        return uri.hostname.replace(/^www\./, "");
      } catch (e) {
        return "";
      }
    }

    // Date formatting
    function formatDate(timestamp) {
      if (!timestamp) return "";
      const date = new Date(timestamp);
      const now = new Date();
      const diffMs = now - date;
      const diffDays = Math.floor(diffMs / 86400000);
      
      if (diffDays === 0) {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else if (diffDays === 1) {
        return "Yesterday";
      } else if (diffDays < 7) {
        return date.toLocaleDateString([], { weekday: "short" });
      } else {
        return date.toLocaleDateString([], { month: "short", day: "numeric" });
      }
    }

    // Byte formatting
    function formatBytes(bytes) {
      if (bytes === undefined || bytes === null) return "";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // Open stack on button hover
    function open() {
      const footButtons = document.getElementById("zen-sidebar-foot-buttons");
      const tabs = document.getElementById("tabbrowser-tabs");
      
      if (!footButtons) return;

      clearTimeout(closeTimer);
      
      if (footButtons.hasAttribute("zen-library-stack-open")) {
        return;
      }

      // Aim badge (fly from button to newest entry)
      aimBadge();
      
      if (tabs) {
        tabs.removeAttribute("zen-library-stack-closing");
      }
      
      footButtons.setAttribute("zen-library-stack-open", "true");
      if (tabs) {
        tabs.setAttribute("zen-library-stack-open", "true");
      }
    }

    // Close stack
    function scheduleClose() {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!contextMenuOpen) {
          close();
        }
      }, CLOSE_DELAY_MS);
    }

    function close() {
      const footButtons = document.getElementById("zen-sidebar-foot-buttons");
      const tabs = document.getElementById("tabbrowser-tabs");
      
      if (!footButtons || footButtons.hasAttribute("zen-library-stack-open") === false) {
        return;
      }

      footButtons.removeAttribute("zen-library-stack-open");
      if (tabs) {
        tabs.removeAttribute("zen-library-stack-open");
        tabs.setAttribute("zen-library-stack-closing", "true");
        
        tabs.addEventListener("transitionend", function onEnd(event) {
          if (event.propertyName === "--zen-library-progress") {
            tabs.removeEventListener("transitionend", onEnd);
            tabs.removeAttribute("zen-library-stack-closing");
          }
        }, { once: true });
      }

      updateBadgeShowing();
    }

    // Aim badge animation (matches native)
    function aimBadge() {
      const newestEntry = entries[entries.length - 1];
      if (!newestEntry || newestEntry.hidden) return;

      const targetBadge = newestEntry.querySelector(".zen-library-download-badge");
      if (!targetBadge) return;

      const buttonBadge = document.getElementById("library-button-badge");
      if (!buttonBadge) return;

      const from = buttonBadge.getBoundingClientRect();
      const to = targetBadge.getBoundingClientRect();
      
      const style = window.getComputedStyle(buttonBadge);
      const entryTransform = window.getComputedStyle(newestEntry).transform;
      const rise = entryTransform === "none" ? 0 : 
        new window.DOMMatrixReadOnly(entryTransform).f;

      buttonBadge.style.setProperty(
        "--zen-library-badge-to-x",
        `${parseFloat(style.left) + to.left - from.left}px`
      );
      buttonBadge.style.setProperty(
        "--zen-library-badge-to-y",
        `${parseFloat(style.top) + to.top - from.top - rise}px`
      );
    }

    // Event listeners
    button.addEventListener("mouseenter", open);
    button.addEventListener("mouseleave", scheduleClose);
    list.addEventListener("mouseenter", () => clearTimeout(closeTimer));
    list.addEventListener("mouseleave", scheduleClose);

    // Click handlers for entries
    entries.forEach((entry, i) => {
      entry.addEventListener("click", (event) => {
        if (event.button === 0 && entry.download) {
          openDownload(entry.download);
        }
      });

      entry.addEventListener("contextmenu", (event) => {
        if (entry.download) {
          showContextMenu(event, entry.download);
          event.preventDefault();
          event.stopPropagation();
        }
      });

      const action = entry.querySelector(".zen-library-download-action");
      if (action) {
        action.addEventListener("click", (event) => event.stopPropagation());
        action.addEventListener("command", () => {
          if (entry.download) {
            cancelDownload(entry.download);
          }
        });
      }
    });

    // Context menu (matches native)
    function showContextMenu(event, download) {
      contextMenuOpen = true;
      event.preventDefault();
      event.stopPropagation();

      const popup = document.createXULElement("menupopup");
      popup.className = "zen-library-downloads-menu";

      const items = getContextMenuItems(download);
      for (const item of items) {
        if (item.separator) {
          if (popup.lastChild && popup.lastChild.tagName !== "menuseparator") {
            popup.appendChild(document.createXULElement("menuseparator"));
          }
          continue;
        }

        const menuitem = document.createXULElement("menuitem");
        menuitem.setAttribute("data-l10n-id", item.l10nId || item.label);
        if (item.label) {
          menuitem.setAttribute("label", item.label);
        }
        menuitem.disabled = item.disabled || false;

        menuitem.addEventListener("command", () => {
          try {
            item.onClick();
          } catch (ex) {
            console.error(ex);
          }
        }, { once: true });

        popup.appendChild(menuitem);
      }

      if (popup.lastChild?.tagName === "menuseparator") {
        popup.lastChild.remove();
      }

      if (!popup.childElementCount) {
        contextMenuOpen = false;
        return;
      }

      popup.addEventListener("popuphidden", () => {
        contextMenuOpen = false;
        popup.remove();
        scheduleClose();
      }, { once: true });

      document.getElementById("mainPopupSet").appendChild(popup);
      popup.openPopupAtScreen(event.screenX, event.screenY, true, event);
    }

    function getContextMenuItems(download) {
      const items = [];
      const isActive = !download.stopped || (download.canceled && download.hasPartialData);
      const fileExists = download.succeeded && download.target?.exists !== false && !download.deleted;
      const sourceUrl = download.source?.originalUrl || download.source?.url;

      if (!download.stopped) {
        items.push({
          l10nId: "downloads-cmd-pause",
          onClick: () => cancelDownload(download)
        });
      } else if (download.canceled && download.hasPartialData) {
        items.push({
          l10nId: "downloads-cmd-resume",
          onClick: () => download.start?.().catch(() => {})
        });
      }

      if (fileExists) {
        items.push({
          l10nId: "downloads-cmd-show-menuitem-2",
          onClick: () => showDownloadedFile(download)
        });
      }

      if (sourceUrl) {
        items.push({
          l10nId: "downloads-cmd-go-to-download-page",
          onClick: () => window.openTrustedLinkIn(sourceUrl, "tab")
        });
        items.push({
          l10nId: "downloads-cmd-copy-download-link",
          onClick: () => copyDownloadLink(download)
        });
      }

      items.push({ separator: true });

      if (fileExists) {
        items.push({
          l10nId: "downloads-cmd-delete-file",
          onClick: () => deleteDownloadFiles(download)
        });
      }

      if (!isActive) {
        items.push({
          l10nId: "downloads-cmd-remove-from-history",
          onClick: () => deleteDownload(download)
        });
      }

      return items;
    }

    // Download actions
    function openDownload(download) {
      if (download.succeeded) {
        openDownloadedFile(download).catch(console.error);
      } else if (download.source?.url) {
        window.openTrustedLinkIn(download.source.url, "tab");
      }
    }

    function cancelDownload(download) {
      if (!download || download.stopped) return;
      download.cancel().catch(() => {});
      download.removePartialData().catch(console.error).finally(() => {
        if (download.target) download.target.refresh();
      });
    }

    function showDownloadedFile(download) {
      if (!download.target?.path) return;
      try {
        const file = new FileUtils.File(download.target.path);
        if (file.exists()) {
          file.launch();
        }
      } catch (e) {
        console.error("Error showing file:", e);
      }
    }

    function openDownloadedFile(download) {
      if (!download.target?.path) return Promise.resolve();
      try {
        const file = new FileUtils.File(download.target.path);
        return file.launch();
      } catch (e) {
        console.error("Error opening file:", e);
        return Promise.resolve();
      }
    }

    function copyDownloadLink(download) {
      const url = download.source?.originalUrl || download.source?.url || "";
      if (!url) return;
      try {
        const clipboard = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Components.interfaces.nsIClipboardHelper);
        clipboard.copyString(url);
      } catch (e) {
        console.error("Error copying link:", e);
      }
    }

    function deleteDownloadFiles(download) {
      if (!download.target?.path) return Promise.resolve();
      try {
        const file = new FileUtils.File(download.target.path);
        return file.remove(false);
      } catch (e) {
        console.error("Error deleting file:", e);
        return Promise.resolve();
      }
    }

    function deleteDownload(download) {
      // Remove from history only
      if (window.Downloads && window.Downloads.getList) {
        const list = window.Downloads.getList(window.Downloads.ALL);
        return list.then(dl => dl.remove(download));
      }
      return Promise.resolve();
    }

    // Set up list height
    function updateListHeight() {
      const footButtons = document.getElementById("zen-sidebar-foot-buttons");
      const tabs = document.getElementById("tabbrowser-tabs");
      if (!footButtons || !tabs) return;

      const height = list.getBoundingClientRect().height;
      tabs.style.setProperty("--zen-library-stack-height", `${height}px`);
    }

    // Initialize Downloads listener
    function initDownloadsListener() {
      const dl = getDownloadList();
      if (!dl) return;

      // Set up view
      dl.addView({
        onDownloadAdded: (download) => {
          downloads.push(download);
          updateUI();
          updateListHeight();
        },
        onDownloadChanged: (download) => {
          updateUI();
        },
        onDownloadRemoved: (download) => {
          const index = downloads.indexOf(download);
          if (index !== -1) {
            downloads.splice(index, 1);
          }
          updateUI();
          updateListHeight();
        }
      });

      // Initial load
      dl.getAll().then(allDownloads => {
        downloads = allDownloads || [];
        updateUI();
        updateListHeight();
      });
    }

    // Initialize
    initDownloadsListener();
    
    // Observe list for height changes
    const resizeObserver = new ResizeObserver(updateListHeight);
    resizeObserver.observe(list);

    // Cleanup
    window.addEventListener("beforeunload", () => {
      resizeObserver.disconnect();
      clearTimeout(closeTimer);
    });

    // Expose for tidy-downloads integration
    window.zenStuffDownloadStack = {
      open: open,
      close: close,
      isOpen: () => {
        const footButtons = document.getElementById("zen-sidebar-foot-buttons");
        return footButtons ? footButtons.hasAttribute("zen-library-stack-open") : false;
      }
    };
  }

  // Initialize when DOM is ready
  if (document.readyState === "complete") {
    initStack();
  } else {
    window.addEventListener("load", initStack, { once: true });
  }
})();
