// ==UserScript==
// @include   main
// @loadOrder    99999999999999
// @ignorecache
// ==/UserScript==

// tidy-downloads-ai-rename.uc.js
// AI-powered download renaming module (Mistral API, queue, process)
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  /**
   * Initialize the AI rename module. Called by tidy-downloads.uc.js after main script setup.
   * @param {Object} ctx
   * @param {Object} ctx.store - zenTidyDownloadsStore.createStore() (uses activeDownloadCards, focusedKeyRef, renamedFiles)
   * @param {Object} ctx.deps - callbacks and utils from main (tidyDeps + rename + AI-specific fields)
   * @returns {{ addToAIRenameQueue, removeFromAIRenameQueue, cancelAIProcessForDownload, isInQueue, getQueuePosition, updateQueueStatusInUI, migrateAIRenameKeys }}
   */
  window.zenTidyDownloadsAIRename = {
    init(ctx) {
      const { store, deps } = ctx;
      const {
        renameDownloadFileAndUpdateRecord,
        scheduleCardRemoval,
        performAutohideSequence,
        getMasterTooltip,
        updateUIForFocusedDownload,
        debugLog,
        getPref,
        SecurityUtils,
        RateLimiter,
        redactSensitiveData,
        sanitizeFilename,
        formatBytes,
        getContentTypeFromFilename,
        MISTRAL_API_KEY_PREF,
        IMAGE_EXTENSIONS,
        PATH_SEPARATOR,
        previewApi,
        showRenameToast,
        showSimpleToast,
        getDownloadKey,
        Cc,
        Ci
      } = deps;

      const { activeDownloadCards, focusedKeyRef, renamedFiles } = store;

      /** @param {string} [p] */
      function normalizePathForAiDedupe(p) {
        return typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "";
      }

      // AI Process Management
      const activeAIProcesses = new Map();
      const aiRenameQueue = [];
      let isProcessingAIQueue = false;
      let currentlyProcessingKey = null;

      /**
       * Call Mistral AI API with rate limiting and security measures
       * @param {Object} params - API call parameters
       * @param {string} params.systemPrompt - System prompt for the AI
       * @param {string} params.userPrompt - User prompt for the AI
       * @param {AbortSignal} params.abortSignal - Signal to abort the request
       * @returns {Promise<string|null>} AI-generated filename or null
       */
      async function callMistralAI({ systemPrompt, userPrompt, abortSignal }) {
        if (abortSignal?.aborted) return null;

        const rateLimitCheck = RateLimiter.canMakeRequest();
        if (!rateLimitCheck.allowed) {
          debugLog(`Mistral AI rate limit exceeded: ${rateLimitCheck.reason}`, {
            waitTime: rateLimitCheck.waitTime,
            stats: RateLimiter.getStats()
          });
          console.warn(`API rate limit exceeded. Please wait ${rateLimitCheck.waitTime} seconds.`);
          return null;
        }

        const apiKey = getPref(MISTRAL_API_KEY_PREF, "");
        if (!apiKey) {
          console.warn("Mistral API key not found in preferences");
          return null;
        }

        if (apiKey.length < 10) {
          console.warn("Mistral API key appears to be invalid (too short)");
          return null;
        }

        try {
          RateLimiter.recordRequest();
          debugLog("Sending request to Mistral AI", { rateLimitStats: RateLimiter.getStats() });

          const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: "mistral-small-latest",
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
              ],
              temperature: 0.1,
              max_tokens: 50
            }),
            signal: abortSignal
          });

          if (!response.ok) {
            const errorText = await response.text();
            const safeErrorText = redactSensitiveData(errorText);
            throw new Error(`HTTP error! status: ${response.status} - ${safeErrorText}`);
          }

          const data = await response.json();
          let name = data.choices[0]?.message?.content?.trim();

          if (name) {
            name = name.replace(/^["']|["']$/g, '');
            const chattyPrefixes = [
              "based on", "here is", "i have", "the filename", "new filename", "renamed file", "unknown", "file name"
            ];
            const lowerName = name.toLowerCase();
            if (chattyPrefixes.some(prefix => lowerName.startsWith(prefix))) {
              debugLog("Mistral AI returned conversational text or unknown, rejecting:", name);
              return null;
            }
          }

          debugLog("Mistral AI response:", name);
          return name || null;
        } catch (error) {
          const safeError = error.message ? redactSensitiveData(error.message) : 'Unknown error';
          console.error("Mistral AI error:", safeError);
          return null;
        }
      }

      function addToAIRenameQueue(downloadKey, download, originalFilename) {
        debugLog(`[AI Queue] addToAIRenameQueue called for ${downloadKey}`, {
          downloadKey,
          hasDownload: !!download,
          downloadPath: download?.target?.path,
          originalFilename,
          queueLength: aiRenameQueue.length,
          isProcessing: isProcessingAIQueue,
          currentlyProcessing: currentlyProcessingKey
        });

        if (!download || !download.target?.path) {
          debugLog(`[AI Queue] Download ${downloadKey} missing download object or path, skipping`);
          return false;
        }

        const targetPath = download.target.path;

        if (renamedFiles.has(targetPath)) {
          debugLog(`[AI Queue] Download ${downloadKey} already renamed (path: ${targetPath}), skipping`);
          return false;
        }

        const pathNorm = normalizePathForAiDedupe(targetPath);
        if (pathNorm) {
          if (aiRenameQueue.some(item => normalizePathForAiDedupe(item.download?.target?.path) === pathNorm)) {
            debugLog(`[AI Queue] Same file path already queued under another key, skipping`, {
              downloadKey,
              pathNorm
            });
            return false;
          }
          if (currentlyProcessingKey) {
            const curDl = activeDownloadCards.get(currentlyProcessingKey)?.download;
            if (normalizePathForAiDedupe(curDl?.target?.path) === pathNorm) {
              debugLog(`[AI Queue] Same file path currently being processed, skipping`, {
                downloadKey,
                pathNorm
              });
              return false;
            }
          }
          for (const procKey of activeAIProcesses.keys()) {
            const dl = activeDownloadCards.get(procKey)?.download;
            if (normalizePathForAiDedupe(dl?.target?.path) === pathNorm) {
              debugLog(`[AI Queue] Same file path already in active AI process, skipping`, {
                downloadKey,
                pathNorm,
                procKey
              });
              return false;
            }
          }
        }

        if (aiRenameQueue.some(item => item.downloadKey === downloadKey)) {
          debugLog(`[AI Queue] Download ${downloadKey} already in queue, skipping`);
          return false;
        }

        if (currentlyProcessingKey === downloadKey) {
          debugLog(`[AI Queue] Download ${downloadKey} is currently being processed, skipping`);
          return false;
        }

        const queueItem = { downloadKey, download, originalFilename, queuedAt: Date.now() };
        aiRenameQueue.push(queueItem);
        debugLog(`[AI Queue] ✅ Successfully added ${downloadKey} to queue. Queue length: ${aiRenameQueue.length}`, {
          position: aiRenameQueue.length,
          originalFilename,
          path: download.target.path
        });

        updateQueueStatusInUI(downloadKey);

        if (!isProcessingAIQueue) {
          debugLog(`[AI Queue] Starting queue processor (was not running)`);
          processAIRenameQueue();
        } else {
          debugLog(`[AI Queue] Queue processor already running, will process this item when ready`);
        }

        return true;
      }

      function removeFromAIRenameQueue(downloadKey) {
        const index = aiRenameQueue.findIndex(item => item.downloadKey === downloadKey);
        if (index !== -1) {
          aiRenameQueue.splice(index, 1);
          debugLog(`[AI Queue] Removed ${downloadKey} from queue. Queue length: ${aiRenameQueue.length}`);
          return true;
        }
        return false;
      }

      function getQueuePosition(downloadKey) {
        if (currentlyProcessingKey === downloadKey) return 0;
        const index = aiRenameQueue.findIndex(item => item.downloadKey === downloadKey);
        return index === -1 ? -1 : index + 1;
      }

      function isInQueue(downloadKey) {
        return getQueuePosition(downloadKey) !== -1;
      }

      function updateQueueStatusInUI(downloadKey) {
        if (downloadKey !== focusedKeyRef.current || !getMasterTooltip()) return;

        const masterTooltipDOMElement = getMasterTooltip();
        const statusEl = masterTooltipDOMElement.querySelector(".card-status");
        if (!statusEl) return;

        const position = getQueuePosition(downloadKey);
        const cardData = activeDownloadCards.get(downloadKey);

        if (position > 0) {
          statusEl.textContent = `Waiting for AI rename (${position} in queue)...`;
          statusEl.style.color = "#f39c12";
        } else if (currentlyProcessingKey === downloadKey) {
          // processDownloadForAIRenaming handles its own status updates
        } else if (cardData?.download?.aiName) {
          statusEl.textContent = "Download renamed to:";
          statusEl.style.color = "#a0a0a0";
        } else if (cardData?.download?.succeeded) {
          statusEl.textContent = "Download completed";
          statusEl.style.color = "#1dd1a1";
        }
      }

      async function processDownloadForAIRenaming(download, originalNameForUICard, keyOverride) {
        const key = keyOverride || getDownloadKey(download);
        const cardData = activeDownloadCards.get(key);

        const abortController = new AbortController();
        const processState = { phase: 'initializing', startTime: Date.now() };

        activeAIProcesses.set(key, { abortController, processState, startTime: Date.now() });
        debugLog(`[AI Process] Started AI renaming process for ${key}`, processState);

        let statusElToUpdate;
        let titleElToUpdate;
        let originalFilenameElToUpdate;
        let progressElToHide;
        let podElementToStyle;

        const masterTooltipDOMElement = getMasterTooltip();
        const focusedKey = focusedKeyRef.current;

        if (focusedKey === key && masterTooltipDOMElement) {
          statusElToUpdate = masterTooltipDOMElement.querySelector(".card-status");
          titleElToUpdate = masterTooltipDOMElement.querySelector(".card-title");
          originalFilenameElToUpdate = masterTooltipDOMElement.querySelector(".card-original-filename");
          progressElToHide = masterTooltipDOMElement.querySelector(".card-progress");
        } else if (cardData && cardData.podElement) {
          debugLog(`[AI Rename] processDownloadForAIRenaming called for non-focused item ${key}. UI updates will be minimal.`);
        }

        if (cardData && cardData.podElement) {
          podElementToStyle = cardData.podElement;
        }

        if (!cardData) {
          debugLog("AI Rename: Card data not found for download key:", key);
          return false;
        }

        const previewContainerOnPod = cardData.podElement ? cardData.podElement.querySelector(".card-preview-container") : null;
        let originalPreviewTitle = "";
        if (previewContainerOnPod) originalPreviewTitle = previewContainerOnPod.title;

        const downloadPath = download.target.path;
        if (!downloadPath) return false;

        const trueOriginalFilename = cardData.originalFilename;

        if (renamedFiles.has(downloadPath)) {
          debugLog(`Skipping rename - already processed: ${downloadPath}`);
          activeAIProcesses.delete(key);
          return false;
        }

        if (abortController.signal.aborted) {
          debugLog(`[AI Process] Process aborted before file size check: ${key}`);
          activeAIProcesses.delete(key);
          throw new DOMException('AI process was aborted', 'AbortError');
        }

        try {
          const validation = SecurityUtils.validateFilePath(downloadPath, { strict: false });
          if (!validation.valid) {
            debugLog(`Path validation warning (continuing anyway): ${validation.error}`, { path: downloadPath, code: validation.code });
          }

          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(downloadPath);

          if (!file.exists()) {
            debugLog(`File does not exist for AI rename: ${downloadPath}`);
            activeAIProcesses.delete(key);
            return false;
          }
        } catch (e) {
          const errorMessage = e.message || e.toString() || 'Unknown error';
          debugLog(`Error checking file size: ${errorMessage}`, { path: downloadPath, error: errorMessage });
          activeAIProcesses.delete(key);
          return false;
        }

        if (cardData) {
          cardData.trueOriginalPathBeforeAIRename = downloadPath;
          cardData.trueOriginalSimpleNameBeforeAIRename = downloadPath.split(PATH_SEPARATOR).pop();
          debugLog("[AI Rename Prep] Stored for undo:", {
            path: cardData.trueOriginalPathBeforeAIRename,
            name: cardData.trueOriginalSimpleNameBeforeAIRename
          });
        }

        try {
          processState.phase = 'analyzing';
          if (abortController.signal.aborted) {
            debugLog(`[AI Process] Process aborted during setup: ${key}`);
            activeAIProcesses.delete(key);
            throw new DOMException('AI process was aborted', 'AbortError');
          }

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

          if (abortController.signal.aborted) {
            debugLog(`[AI Process] Process aborted before analysis: ${key}`);
            renamedFiles.delete(downloadPath);
            activeAIProcesses.delete(key);
            throw new DOMException('AI process was aborted', 'AbortError');
          }

          processState.phase = 'metadata-analysis';
          if (statusElToUpdate) statusElToUpdate.textContent = "Generating better name...";

          const sourceURL = download.source?.url || "unknown";
          let tabTitle = "unknown";
          let pageHeader = "unknown";
          let pageDescription = "unknown";

          try {
            if (typeof gBrowser !== "undefined" && gBrowser.tabs) {
              let foundTab = null;
              for (const tab of gBrowser.tabs) {
                if (tab.linkedBrowser?.currentURI?.spec === sourceURL) {
                  foundTab = tab;
                  break;
                }
              }
              if (!foundTab && download.source?.referrer) {
                const referrerSpec = download.source.referrer;
                for (const tab of gBrowser.tabs) {
                  if (tab.linkedBrowser?.currentURI?.spec === referrerSpec) {
                    foundTab = tab;
                    break;
                  }
                }
              }
              if (foundTab) {
                tabTitle = foundTab.label || foundTab.title || "unknown";
                try {
                  const doc = foundTab.linkedBrowser.contentDocument;
                  if (doc) {
                    const h1 = doc.querySelector('h1');
                    if (h1) {
                      const h1Text = h1.textContent.trim();
                      if (h1Text) pageHeader = h1Text;
                    }
                    const metaDesc = doc.querySelector('meta[name="description"]');
                    if (metaDesc) {
                      const descContent = metaDesc.content.trim();
                      if (descContent) pageDescription = descContent;
                    }
                  }
                } catch (e) {
                  console.error("Error extracting tab context:", e);
                }
              }
            }
          } catch (e) {
            console.error("Error finding tab title:", e);
          }

          const systemPrompt = `I am downloading a file. Rewrite its filename to be helpful, concise and readable. 2-4 words.
- IMPORTANT: Return ONLY the new filename. Do not provide explanations, conversational text, or "based on the information provided".
- Keep informative names mostly the same. For non-informative names, add information from the tab title or website.
- Remove machine-generated cruft, like IDs, (1), (copy), etc.
- Clean up messy text, especially dates. Make timestamps concise, human readable, and remove seconds.
- Clean up text casing and letter spacing to make it easier to read.

Some examples, in the form "original name, tab title, domain -> new name"
- 'Arc-1.6.0-41215.dmg', 'Arc from The Browser Company', 'arc.net' -> 'Arc 1.6.0 41215.dmg'
- 'swift-chat-main.zip', 'huggingface/swift-chat: Mac app to demonstrate swift-transformers', 'github.com' -> 'swift-chat main.zip'
- 'folio_option3_6691488.PDF', 'Your Guest Stay Folio from the LINE LA 08-14-23', 'mail.google.com' -> 'Line LA Folio, Aug 14.pdf'
- 'image.png', 'Feedback: Card border radius - nateparro2t@gmail.com - Gmail', 'mail.google.com' -> 'Card border radius feedback.png'
- 'Brooklyn_Bridge_September_2022_008.jpg', 'nyc bridges - Google Images', 'images.google.com' -> 'Brooklyn Bridge Sept 2022.jpg'
- 'AdobeStock_184679416.jpg', 'ladybug - Google Images', 'images.google.com' -> 'Ladybug.jpg'
- 'CleanShot 2023-08-17 at 19.51.05@2x.png', 'dogfooding - The Browser Company - Slack', 'app.slack.com' -> 'CleanShot Aug 17 from dogfooding.png'
- 'Screenshot 2023-09-26 at 11.12.18 PM', 'DM with Nate - Twitter', 'twitter.com' -> 'Sept 26 Screenshot from Nate.png'
- 'image0.png', 'Nate - Slack', 'files.slack.com' -> 'Slack Image from Nate.png'`;

          let domain = "unknown";
          try {
            domain = new URL(sourceURL).hostname;
          } catch (e) { }

          const isSearchEngine = domain.includes('google') || domain.includes('duckduckgo') || domain.includes('bing') || domain.includes('yahoo') || domain.includes('yandex');
          if (isSearchEngine) {
            try {
              const urlStrings = [
                download.source?.referrer,
                sourceURL,
                (typeof gBrowser !== "undefined" && gBrowser.selectedBrowser?.currentURI?.spec)
              ].filter(Boolean);
              debugLog("Checking URLs for search query:", urlStrings);
              for (const urlStr of urlStrings) {
                try {
                  const urlObj = new URL(urlStr);
                  const q = urlObj.searchParams.get('q') || urlObj.searchParams.get('p') || urlObj.searchParams.get('text');
                  if (q) {
                    pageHeader = `Search Query: ${q}`;
                    if (tabTitle.toLowerCase().includes('search') || tabTitle.toLowerCase().includes('images') || tabTitle === 'unknown') {
                      tabTitle = `${q} - Search`;
                    }
                    debugLog("Extracted search query for context", { fromUrl: urlStr, query: q, newTabTitle: tabTitle });
                    break;
                  }
                } catch (e) { }
              }
            } catch (e) {
              debugLog("Failed to extract search query:", e);
            }
          }

          const userContent = `Original filename: '${currentFilename}'
Source domain: '${domain}'
Source tab title: '${tabTitle}'
Page Header: '${pageHeader}'
Page Description: '${pageDescription}'

Instructions:
1. First, check if the "Original filename" is already descriptive (contains real words, e.g., "viper-gaming-valorant-hd..."). If so, prioritize cleaning it up (remove random strings, IDs, dates) rather than rewriting it completely from the context.
2. ONLY if the "Original filename" is meaningless gibberish (e.g., "wp13801370.jpg", "OIP.jpg", "image.png"), rename it based on the "Source tab title" or "Page Header".
3. Return ONLY the new filename.`;

          const suggestedName = await callMistralAI({
            systemPrompt,
            userPrompt: userContent,
            abortSignal: abortController.signal
          });

          if (!suggestedName) {
            debugLog("No valid name suggestion received from AI");
            if (statusElToUpdate) statusElToUpdate.textContent = "Could not generate a better name";
            renamedFiles.delete(downloadPath);
            if (podElementToStyle) {
              podElementToStyle.classList.remove("renaming-active");
              podElementToStyle.classList.remove('renaming-initiated');
            }
            activeAIProcesses.delete(key);
            return false;
          }

          if (abortController.signal.aborted) {
            debugLog(`[AI Process] Process aborted before file rename: ${key}`);
            renamedFiles.delete(downloadPath);
            activeAIProcesses.delete(key);
            throw new DOMException('AI process was aborted', 'AbortError');
          }

          processState.phase = 'renaming';
          let cleanName = suggestedName
            .replace(/[^a-zA-Z0-9\-_\.\s]/g, "")
            .trim()
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .toLowerCase();

          if (/^[\-_.]+$/.test(cleanName) || cleanName.replace(/[\-_.]/g, "").length < 2) {
            debugLog("AI suggested invalid name (separators only):", cleanName);
            cleanName = "";
          }

          if (cleanName.length > getPref("extensions.downloads.max_filename_length", 70) - fileExtension.length) {
            cleanName = cleanName.substring(0, getPref("extensions.downloads.max_filename_length", 70) - fileExtension.length);
          }
          if (fileExtension && !cleanName.toLowerCase().endsWith(fileExtension.toLowerCase())) {
            cleanName = cleanName + fileExtension;
          }

          if (cleanName.length <= 2 || cleanName.toLowerCase() === currentFilename.toLowerCase()) {
            debugLog("Skipping AI rename - name too short or same as original");
            if (statusElToUpdate) statusElToUpdate.textContent = "Original name is suitable";
            renamedFiles.delete(downloadPath);
            if (podElementToStyle) {
              podElementToStyle.classList.remove("renaming-active");
              podElementToStyle.classList.remove('renaming-initiated');
            }
            activeAIProcesses.delete(key);
            return false;
          }

          debugLog(`AI suggested renaming to: ${cleanName}`);
          if (statusElToUpdate) statusElToUpdate.textContent = `Renaming to: ${cleanName}`;

          const success = await renameDownloadFileAndUpdateRecord(download, cleanName, key);

          if (success) {
            const newPath = download.target.path;
            const pathSeparator = newPath.includes('\\') ? '\\' : '/';
            const actualFilename = newPath.split(pathSeparator).pop() || cleanName;

            download.aiName = actualFilename;
            renamedFiles.add(downloadPath);
            renamedFiles.add(newPath);
            debugLog(`[AI Rename] Added paths to renamedFiles: ${downloadPath} and ${newPath}`);

            if (titleElToUpdate) {
              titleElToUpdate.textContent = actualFilename;
              titleElToUpdate.title = actualFilename;
            }

            if (statusElToUpdate) {
              let finalSize = download.currentBytes;
              if (!(typeof finalSize === 'number' && finalSize > 0)) finalSize = download.totalBytes;
              const fileSizeText = formatBytes(finalSize || 0);
              const fileSizeEl = masterTooltipDOMElement.querySelector(".card-filesize");
              statusElToUpdate.textContent = "Download renamed to:";
              if (fileSizeEl) {
                fileSizeEl.textContent = fileSizeText;
                fileSizeEl.style.display = "block";
              }
              statusElToUpdate.style.color = "#a0a0a0";
            }

            if (originalFilenameElToUpdate) {
              originalFilenameElToUpdate.textContent = trueOriginalFilename;
              originalFilenameElToUpdate.title = trueOriginalFilename;
              originalFilenameElToUpdate.style.textDecoration = "line-through";
              originalFilenameElToUpdate.style.display = "block";
            }

            if (progressElToHide) progressElToHide.style.display = "none";
            if (podElementToStyle) {
              podElementToStyle.classList.remove("renaming-active");
              podElementToStyle.classList.add("renamed-by-ai");
            }

            let keyForFinalUIUpdate = key;
            if (focusedKeyRef.current === key) {
              focusedKeyRef.current = newPath;
              keyForFinalUIUpdate = newPath;
              debugLog(`[AI Rename] Focused item ${key} renamed to ${newPath}. Updated focusedKeyRef and keyForFinalUIUpdate.`);
            }

            updateUIForFocusedDownload(keyForFinalUIUpdate, true);
            debugLog(`Successfully AI-renamed to: ${actualFilename}`);

            if (document.documentElement.getAttribute('zen-compact-mode') === 'true') {
              const currentAIPath = newPath;
              showRenameToast(actualFilename, trueOriginalFilename, async (dismissPreviousToast) => {
                if (dismissPreviousToast) dismissPreviousToast();
                debugLog(`[Undo] Reverting rename for ${cleanName}`);

                const success = await renameDownloadFileAndUpdateRecord(download, trueOriginalFilename, currentAIPath);

                if (success) {
                  const revertedPath = download.target.path;
                  download.aiName = null;

                  if (focusedKeyRef.current === currentAIPath) {
                    focusedKeyRef.current = revertedPath;
                    debugLog(`[Undo] Updated focusedKeyRef to ${revertedPath}`);
                  }

                  updateUIForFocusedDownload(revertedPath, true);

                  const revertedCardData = activeDownloadCards.get(revertedPath);
                  if (revertedCardData && revertedCardData.podElement) {
                    revertedCardData.podElement.classList.remove("renamed-by-ai");
                  }

                  if (revertedCardData) {
                    if (revertedCardData.autohideTimeoutId) {
                      clearTimeout(revertedCardData.autohideTimeoutId);
                      revertedCardData.autohideTimeoutId = null;
                    }
                    const shortDelay = 2000;
                    debugLog(`[UndoRename] Scheduling immediate dismissal in ${shortDelay}ms`);
                    revertedCardData.autohideTimeoutId = setTimeout(() => {
                      performAutohideSequence(revertedPath);
                    }, shortDelay);
                  } else {
                    scheduleCardRemoval(revertedPath);
                  }

                  window.dispatchEvent(new CustomEvent('pod-renamed-reverted', {
                    detail: { podKey: currentAIPath, newPath: revertedPath, originalName: trueOriginalFilename }
                  }));

                  showSimpleToast("Rename reverted");
                } else {
                  showSimpleToast("Undo failed");
                }
              });
            }

            activeAIProcesses.delete(key);
            return true;
          } else {
            renamedFiles.delete(downloadPath);
            if (statusElToUpdate) statusElToUpdate.textContent = "Rename failed";
            if (podElementToStyle) {
              podElementToStyle.classList.remove("renaming-active");
              podElementToStyle.classList.remove('renaming-initiated');
            }
            activeAIProcesses.delete(key);
            return false;
          }
        } catch (e) {
          if (e.name === 'AbortError') {
            debugLog(`[AI Process] AI rename process was aborted for ${key}`);
          } else {
            console.error("AI Rename process error:", e);
          }
          renamedFiles.delete(downloadPath);
          if (statusElToUpdate && e.name !== 'AbortError') statusElToUpdate.textContent = "Rename error";
          if (podElementToStyle) {
            podElementToStyle.classList.remove("renaming-active");
            podElementToStyle.classList.remove('renaming-initiated');
          }
          activeAIProcesses.delete(key);
          throw e;
        } finally {
          if (previewContainerOnPod) {
            previewContainerOnPod.style.pointerEvents = "auto";
            previewContainerOnPod.title = originalPreviewTitle;
          }
          if (podElementToStyle) podElementToStyle.classList.remove("renaming-active");
        }
      }

      async function processAIRenameQueue() {
        debugLog(`[AI Queue] processAIRenameQueue called`, {
          isProcessingAIQueue,
          queueLength: aiRenameQueue.length,
          currentlyProcessing: currentlyProcessingKey
        });

        if (isProcessingAIQueue) {
          debugLog("[AI Queue] Queue processing already in progress, returning");
          return;
        }
        if (aiRenameQueue.length === 0) {
          debugLog("[AI Queue] Queue is empty, nothing to process");
          return;
        }

        isProcessingAIQueue = true;
        debugLog(`[AI Queue] ✅ Starting queue processing. Queue length: ${aiRenameQueue.length}`, {
          queueItems: aiRenameQueue.map(item => ({ key: item.downloadKey, path: item.download?.target?.path }))
        });

        try {
          while (aiRenameQueue.length > 0) {
            const queueItem = aiRenameQueue.shift();
            const { downloadKey, download, originalFilename } = queueItem;

            currentlyProcessingKey = downloadKey;
            debugLog(`[AI Queue] Processing ${downloadKey}. Remaining in queue: ${aiRenameQueue.length}`);

            const cardData = activeDownloadCards.get(downloadKey);
            if (!cardData || !cardData.download) {
              debugLog(`[AI Queue] Skipping ${downloadKey} - card data no longer exists`);
              currentlyProcessingKey = null;
              continue;
            }

            const currentPath = cardData.download.target?.path;
            if (renamedFiles.has(currentPath)) {
              debugLog(`[AI Queue] Skipping ${downloadKey} - already renamed`);
              currentlyProcessingKey = null;
              continue;
            }

            if (!cardData.download.succeeded) {
              debugLog(`[AI Queue] Skipping ${downloadKey} - no longer in succeeded state`);
              currentlyProcessingKey = null;
              continue;
            }

            const masterTooltipDOMElement = getMasterTooltip();
            if (focusedKeyRef.current === downloadKey && masterTooltipDOMElement) {
              const statusEl = masterTooltipDOMElement.querySelector(".card-status");
              if (statusEl) {
                statusEl.textContent = "Analyzing for rename...";
                statusEl.style.color = "#54a0ff";
              }
            }

            aiRenameQueue.forEach(item => updateQueueStatusInUI(item.downloadKey));

            try {
              const podElement = cardData.podElement;
              if (podElement) podElement.classList.add('renaming-initiated');

              await processDownloadForAIRenaming(cardData.download, originalFilename, downloadKey);
              debugLog(`[AI Queue] Successfully processed ${downloadKey}`);
            } catch (error) {
              if (error.name === 'AbortError') {
                debugLog(`[AI Queue] Processing of ${downloadKey} was aborted`);
              } else {
                debugLog(`[AI Queue] Error processing ${downloadKey}:`, error);
              }
              const cardDataErr = activeDownloadCards.get(downloadKey);
              if (cardDataErr?.podElement) {
                cardDataErr.podElement.classList.remove('renaming-initiated', 'renaming-active');
              }
            }

            currentlyProcessingKey = null;

            if (aiRenameQueue.length > 0) {
              debugLog(`[AI Queue] Waiting before next item. Remaining: ${aiRenameQueue.length}`);
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        } catch (error) {
          console.error("[AI Queue] Error in queue processor:", error);
          debugLog(`[AI Queue] Queue processor error:`, error);
        } finally {
          isProcessingAIQueue = false;
          currentlyProcessingKey = null;
          debugLog("[AI Queue] Queue processing complete (flag reset)");
        }
      }

      /**
       * When a card's map key changes (temp→path, id→path, disk rename), keep queue and in-flight AI maps aligned.
       * @param {string} oldKey
       * @param {string} newKey
       */
      function migrateAIRenameKeys(oldKey, newKey) {
        if (!oldKey || !newKey || oldKey === newKey) return;

        let touched = false;
        for (const item of aiRenameQueue) {
          if (item.downloadKey === oldKey) {
            item.downloadKey = newKey;
            touched = true;
          }
        }
        if (currentlyProcessingKey === oldKey) {
          currentlyProcessingKey = newKey;
          touched = true;
        }
        if (activeAIProcesses.has(oldKey)) {
          const proc = activeAIProcesses.get(oldKey);
          activeAIProcesses.delete(oldKey);
          activeAIProcesses.set(newKey, proc);
          touched = true;
        }
        if (touched) {
          debugLog(`[AI] Migrated rename keys: ${oldKey} → ${newKey}`);
        }
      }

      async function cancelAIProcessForDownload(downloadKey) {
        const wasInQueue = removeFromAIRenameQueue(downloadKey);
        if (wasInQueue) {
          debugLog(`[AI Cancel] Removed ${downloadKey} from AI rename queue`);
        }

        const aiProcess = activeAIProcesses.get(downloadKey);
        if (!aiProcess) {
          debugLog(`[AI Cancel] No active AI process found for ${downloadKey}`);
          return wasInQueue;
        }

        debugLog(`[AI Cancel] Canceling AI process for ${downloadKey}`, {
          phase: aiProcess.processState.phase,
          duration: Date.now() - aiProcess.startTime
        });

        try {
          aiProcess.abortController.abort();
          activeAIProcesses.delete(downloadKey);

          const cardData = activeDownloadCards.get(downloadKey);
          if (cardData?.podElement) {
            cardData.podElement.classList.remove("renaming-active");
            cardData.podElement.classList.remove("renaming-initiated");
          }

          const masterTooltipDOMElement = getMasterTooltip();
          if (downloadKey === focusedKeyRef.current && masterTooltipDOMElement) {
            const statusEl = masterTooltipDOMElement.querySelector(".card-status");
            if (statusEl && (statusEl.textContent.includes("Analyzing") || statusEl.textContent.includes("Generating"))) {
              const download = cardData?.download;
              if (download?.succeeded) {
                statusEl.textContent = "Download completed";
                statusEl.style.color = "#1dd1a1";
              } else if (download?.error) {
                statusEl.textContent = `Error: ${download.error.message || "Download failed"}`;
                statusEl.style.color = "#ff6b6b";
              }
            }
          }

          debugLog(`[AI Cancel] Successfully canceled AI process for ${downloadKey}`);
          return true;
        } catch (error) {
          debugLog(`[AI Cancel] Error canceling AI process for ${downloadKey}:`, error);
          activeAIProcesses.delete(downloadKey);
          return false;
        }
      }

      return {
        addToAIRenameQueue,
        removeFromAIRenameQueue,
        cancelAIProcessForDownload,
        isInQueue,
        getQueuePosition,
        updateQueueStatusInUI,
        migrateAIRenameKeys
      };
    }
  };

  console.log("[Zen Tidy Downloads] AI Rename module loaded");
})();
