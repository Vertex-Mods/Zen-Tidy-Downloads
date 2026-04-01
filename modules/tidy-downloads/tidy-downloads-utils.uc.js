// ==UserScript==
// @include   main
// @loadOrder 99999999999997
// @ignorecache
// ==/UserScript==

// tidy-downloads-utils.uc.js
// Shared utilities for Zen Tidy Downloads - must load before tidy-downloads and zen-stuff
(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") return;

  const { classes: Cc, interfaces: Ci } = Components;

  // ============================================================================
  // CONSTANTS
  // ============================================================================
  const MISTRAL_API_KEY_PREF = "extensions.downloads.mistral_api_key";
  const DISABLE_AUTOHIDE_PREF = "extensions.downloads.disable_autohide";
  const IMAGE_LOAD_ERROR_ICON = "🚫";
  const TEMP_LOADER_ICON = "⏳";
  const RENAMED_SUCCESS_ICON = "✓";
  const IMAGE_EXTENSIONS = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".avif",
    ".ico", ".tif", ".tiff", ".jfif"
  ]);
  /** @type {Set<string>} */
  const TEXT_EXTENSIONS = new Set([
    ".txt", ".md", ".js", ".css", ".html", ".json", ".xml", ".log", ".ini", ".sh", ".py",
    ".java", ".c", ".cpp", ".h", ".ts", ".jsx", ".tsx"
  ]);
  /** @type {Set<string>} */
  const SYSTEM_ICON_EXTENSIONS = new Set([
    ".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".wmv", ".m4v",
    ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".exe", ".msi", ".bat", ".cmd", ".scr",
    ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".iso"
  ]);
  const PATH_SEPARATOR = navigator.platform.includes("Win") ? "\\" : "/";
  const DEFAULT_TEXT_PREVIEW_MAX_BYTES = 500;

  // ============================================================================
  // PREFERENCES
  // ============================================================================
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

  // ============================================================================
  // SECURITY UTILITIES
  // ============================================================================
  const SecurityUtils = (function () {
    "use strict";

    const WINDOWS_RESERVED_NAMES = Object.freeze([
      "CON", "PRN", "AUX", "NUL",
      "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
      "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    ]);
    const WINDOWS_INVALID_CHARS = /[<>:"|?*\x00-\x1F]/;
    const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
    const MAX_PATH_LENGTH = 32767;
    const MAX_FILENAME_LENGTH = 200;
    const isWindowsPlatform = navigator.platform.includes("Win");

    function parsePath(path) {
      const normalized = path.replace(/\\/g, "/");
      const parts = normalized.split("/").filter(Boolean);
      const filename = parts[parts.length - 1] || path;
      const isWindows = isWindowsPlatform || path.includes("\\");
      return { normalized, parts, filename, isWindows };
    }

    function validateFilePath(path, options = {}) {
      const { strict = true } = options;

      if (!path || typeof path !== "string") {
        return { valid: false, error: "Path must be a non-empty string", code: "INVALID_TYPE" };
      }
      if (path.length > MAX_PATH_LENGTH) {
        return { valid: false, error: "Path exceeds maximum length", code: "PATH_TOO_LONG" };
      }
      if (path.includes("\0") || path.includes("\x00")) {
        return { valid: false, error: "Path contains null bytes", code: "NULL_BYTES" };
      }

      const { normalized, parts, filename, isWindows } = parsePath(path);

      if (parts.some(part => part === ".." || part.startsWith("../"))) {
        return { valid: false, error: "Path contains directory traversal patterns", code: "TRAVERSAL" };
      }
      if (normalized.startsWith("../") || normalized.endsWith("/..")) {
        return { valid: false, error: "Path contains directory traversal patterns", code: "TRAVERSAL" };
      }
      if (path.includes("//") && !path.match(/^\\\\/)) {
        return { valid: false, error: "Path contains invalid path separators", code: "INVALID_SEPARATORS" };
      }
      if (CONTROL_CHARS.test(path.replace(/[\n\t]/g, ""))) {
        return { valid: false, error: "Path contains control characters", code: "CONTROL_CHARS" };
      }

      if (isWindows) {
        for (const part of parts) {
          const nameBase = part.toUpperCase().split(".")[0];
          if (WINDOWS_RESERVED_NAMES.includes(nameBase)) {
            return { valid: false, error: `Path contains Windows reserved name: ${nameBase}`, code: "RESERVED_NAME" };
          }
        }
        if (WINDOWS_INVALID_CHARS.test(filename)) {
          return { valid: false, error: "Filename contains invalid characters for Windows", code: "INVALID_CHARS" };
        }
      }

      return { valid: true, error: null, code: "VALID" };
    }

    function normalizeUnicode(str) {
      try {
        if (typeof str.normalize === "function") return str.normalize("NFC");
        return str;
      } catch (e) {
        return str;
      }
    }

    function sanitizeFilename(filename) {
      if (!filename || typeof filename !== "string") {
        throw new Error("Filename must be a non-empty string");
      }

      let sanitized = normalizeUnicode(filename);
      sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, "");

      if (isWindowsPlatform) {
        sanitized = sanitized.replace(/[<>:"|?*]/g, "");
      }

      sanitized = sanitized.trim().replace(/^\.+|\.+$/g, "");
      sanitized = sanitized.replace(/\.{2,}/g, ".");

      if (isWindowsPlatform && sanitized) {
        const nameBase = sanitized.split(".")[0].toUpperCase();
        if (WINDOWS_RESERVED_NAMES.includes(nameBase)) {
          sanitized = `FILE_${sanitized}`;
        }
      }

      sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF]/g, "");
      sanitized = sanitized.replace(/[\u200E-\u200F\u202A-\u202E]/g, "");

      if (!sanitized || sanitized.trim().length === 0) {
        throw new Error("Filename is empty after sanitization");
      }

      if (sanitized.length > MAX_FILENAME_LENGTH) {
        const lastDot = sanitized.lastIndexOf(".");
        if (lastDot > 0) {
          const ext = sanitized.substring(lastDot);
          const name = sanitized.substring(0, lastDot);
          sanitized = name.substring(0, MAX_FILENAME_LENGTH - ext.length) + ext;
        } else {
          sanitized = sanitized.substring(0, MAX_FILENAME_LENGTH);
        }
      }

      return sanitized;
    }

    return {
      validateFilePath,
      sanitizeFilename,
      WINDOWS_RESERVED_NAMES,
      MAX_PATH_LENGTH,
      MAX_FILENAME_LENGTH
    };
  })();

  /**
   * Validate file path - throws on invalid, returns path on valid (for zen-stuff compatibility)
   */
  function validateFilePathOrThrow(path) {
    const result = SecurityUtils.validateFilePath(path);
    if (!result.valid) {
      throw new Error(result.error);
    }
    return path;
  }

  // ============================================================================
  // RATE LIMITER
  // ============================================================================
  const RateLimiter = (function () {
    "use strict";
    const MAX_REQUESTS_PER_MINUTE = 10;
    const MAX_REQUESTS_PER_HOUR = 100;
    const REQUEST_HISTORY = [];

    function canMakeRequest() {
      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      const oneHourAgo = now - 3600000;

      while (REQUEST_HISTORY.length > 0 && REQUEST_HISTORY[0] < oneHourAgo) {
        REQUEST_HISTORY.shift();
      }

      const recentRequests = REQUEST_HISTORY.filter(time => time > oneMinuteAgo);
      if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) {
        const oldestRecent = Math.min(...recentRequests);
        const waitTime = Math.ceil((oldestRecent + 60000 - now) / 1000);
        return {
          allowed: false,
          waitTime,
          reason: `Rate limit exceeded: ${recentRequests.length} requests in the last minute (max: ${MAX_REQUESTS_PER_MINUTE})`
        };
      }
      if (REQUEST_HISTORY.length >= MAX_REQUESTS_PER_HOUR) {
        const oldestRequest = REQUEST_HISTORY[0];
        const waitTime = Math.ceil((oldestRequest + 3600000 - now) / 1000);
        return {
          allowed: false,
          waitTime,
          reason: `Rate limit exceeded: ${REQUEST_HISTORY.length} requests in the last hour (max: ${MAX_REQUESTS_PER_HOUR})`
        };
      }
      return { allowed: true };
    }

    function recordRequest() {
      REQUEST_HISTORY.push(Date.now());
    }

    function getStats() {
      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      const oneHourAgo = now - 3600000;
      return {
        lastMinute: REQUEST_HISTORY.filter(time => time > oneMinuteAgo).length,
        lastHour: REQUEST_HISTORY.filter(time => time > oneHourAgo).length,
        total: REQUEST_HISTORY.length,
        limits: { perMinute: MAX_REQUESTS_PER_MINUTE, perHour: MAX_REQUESTS_PER_HOUR }
      };
    }

    return { canMakeRequest, recordRequest, getStats };
  })();

  // ============================================================================
  // LOGGING
  // ============================================================================
  function redactSensitiveData(data) {
    if (typeof data === "string") {
      return data
        .replace(/Bearer\s+[A-Za-z0-9_-]+/gi, "Bearer [REDACTED]")
        .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9_-]+/gi, "Authorization: Bearer [REDACTED]")
        .replace(/(api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*[A-Za-z0-9_-]+/gi, "$1=[REDACTED]");
    }
    if (typeof data !== "object" || data === null) return data;
    if (Array.isArray(data)) return data.map(item => redactSensitiveData(item));

    const SENSITIVE_KEY_PATTERN = /(api|key|authorization|token|secret|password|credential)/i;
    const redacted = {};
    for (const key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      const value = data[key];
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        redacted[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        redacted[key] = redactSensitiveData(value);
      } else if (typeof value === "object" && value !== null) {
        redacted[key] = redactSensitiveData(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  function debugLog(message, data = null, category = "general") {
    try {
      const debugEnabled = getPref("extensions.downloads.enable_debug", false);
      const debugAiOnly = getPref("extensions.downloads.debug_ai_only", true);

      if (!debugEnabled) return;
      if (debugAiOnly && category !== "aiRename" && category !== "general") return;

      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] Download Preview [${category.toUpperCase()}]:`;
      const safeData = data ? redactSensitiveData(data) : null;
      const safeMessage = typeof message === "string" ? redactSensitiveData(message) : message;

      if (safeData) {
        console.log(`${prefix} ${safeMessage}`, safeData);
      } else {
        console.log(`${prefix} ${safeMessage}`);
      }
    } catch (e) {
      const safeData = data ? redactSensitiveData(data) : null;
      const safeMessage = typeof message === "string" ? redactSensitiveData(message) : message;
      console.log(`[Download Preview] ${safeMessage}`, safeData || "");
    }
  }

  // ============================================================================
  // POD VALIDATION (shared by zen-stuff)
  // ============================================================================
  function validatePodData(podData) {
    if (!podData || typeof podData !== "object") {
      throw new Error("Invalid pod data: must be an object");
    }
    if (!podData.key || typeof podData.key !== "string") {
      throw new Error("Invalid pod data: missing or invalid key");
    }
    if (!podData.filename || typeof podData.filename !== "string") {
      throw new Error("Invalid pod data: missing or invalid filename");
    }
    return podData;
  }

  // ============================================================================
  // FORMAT UTILITIES
  // ============================================================================
  function formatBytes(b, d = 2) {
    if (b === 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${parseFloat((b / Math.pow(1024, i)).toFixed(d))} ${sizes[i]}`;
  }

  /**
   * @param {string} [filename]
   * @param {Set<string>} extSet - extensions with leading dot (e.g. ".png")
   * @returns {boolean}
   */
  function filenameEndsWithExtensionFromSet(filename, extSet) {
    if (!filename || !extSet || extSet.size === 0) return false;
    const lower = filename.toLowerCase();
    for (const ext of extSet) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

  /**
   * Read the start of a UTF-8 text file (IOUtils when available).
   * @param {string} path
   * @param {number} [maxBytes=500]
   * @returns {Promise<string|null>}
   */
  async function readTextFilePreview(path, maxBytes = DEFAULT_TEXT_PREVIEW_MAX_BYTES) {
    try {
      if (typeof path !== "string" || !path) return null;
      if (typeof IOUtils !== "undefined") {
        return await IOUtils.readUTF8(path, { maxBytes });
      }
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      if (!file.exists()) return null;
      const fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
      const cstream = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
      fstream.init(file, -1, 0, 0);
      cstream.init(fstream, "UTF-8", 0, 0);
      const str = {};
      cstream.readString(maxBytes, str);
      cstream.close();
      return str.value;
    } catch (e) {
      return null;
    }
  }

  // ============================================================================
  // DOM UTILITIES
  // ============================================================================
  function waitForElement(elementId, timeout = 5000) {
    return new Promise(resolve => {
      const startTime = Date.now();
      const checkForElement = () => {
        const element = document.getElementById(elementId);
        if (element) {
          console.log(`[Tidy Downloads] Element ${elementId} found after ${Date.now() - startTime}ms`);
          resolve(element);
          return;
        }
        if (Date.now() - startTime >= timeout) {
          console.log(`[Tidy Downloads] Timeout waiting for element ${elementId} after ${timeout}ms`);
          resolve(null);
          return;
        }
        setTimeout(checkForElement, 100);
      };
      checkForElement();
    });
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================
  window.zenTidyDownloadsUtils = {
    // Constants
    MISTRAL_API_KEY_PREF,
    DISABLE_AUTOHIDE_PREF,
    IMAGE_LOAD_ERROR_ICON,
    TEMP_LOADER_ICON,
    RENAMED_SUCCESS_ICON,
    IMAGE_EXTENSIONS,
    TEXT_EXTENSIONS,
    SYSTEM_ICON_EXTENSIONS,
    PATH_SEPARATOR,
    DEFAULT_TEXT_PREVIEW_MAX_BYTES,

    // Preferences
    getPref,

    // Security
    SecurityUtils,
    validateFilePathOrThrow,
    sanitizeFilename: SecurityUtils.sanitizeFilename,

    // Rate limiting
    RateLimiter,

    // Logging
    debugLog,
    redactSensitiveData,

    // Validation
    validatePodData,

    // Format
    formatBytes,

    // File / extension helpers (shared with preview + zen-stuff pile)
    readTextFilePreview,
    filenameEndsWithExtensionFromSet,

    // DOM
    waitForElement
  };

  console.log("[Zen Tidy Downloads] Utils loaded");
})();
