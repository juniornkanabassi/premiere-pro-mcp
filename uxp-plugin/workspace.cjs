(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PremiereMcpWorkspace = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CONFIG_FILE = "workspace-access.json";

  function workspaceError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function parseAbsolutePath(value, label) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.indexOf("\0") !== -1) {
      throw workspaceError("UXP_INVALID_ARGUMENT", label + " must be a non-empty absolute path of at most 4096 characters");
    }
    // Trimming is only valid for the blank-value check above. Leading and
    // trailing spaces are legal POSIX filename characters and must survive
    // normalization unchanged.
    const original = value;
    const windowsInput = /^[A-Za-z]:[\\/]/.test(original) || /^\\\\/.test(original) || /^\/\/[^/]+\/[^/]+/.test(original);
    const slashed = windowsInput ? original.replace(/\\/g, "/") : original;
    const drive = /^([A-Za-z]):\/(.*)$/.exec(slashed);
    const unc = windowsInput && /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(slashed);
    const posix = !drive && !unc && slashed.charAt(0) === "/";
    if (!drive && !unc && !posix) {
      throw workspaceError("UXP_INVALID_ARGUMENT", label + " must be absolute");
    }
    const prefix = drive ? drive[1].toUpperCase() + ":" : unc ? "//" + unc[1] + "/" + unc[2] : "";
    const remainder = drive ? drive[2] : unc ? (unc[3] || "") : slashed.slice(1);
    const parts = [];
    for (const part of remainder.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) throw workspaceError("UXP_PATH_OUTSIDE_WORKSPACE", label + " escapes its filesystem root");
        parts.pop();
        continue;
      }
      if ((drive || unc) && (/[. ]$/.test(part) || part.indexOf(":") !== -1 || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
        throw workspaceError("UXP_INVALID_ARGUMENT", label + " contains a Windows-ambiguous path segment");
      }
      parts.push(part);
    }
    const normalized = prefix + "/" + parts.join("/");
    return {
      normalized: normalized,
      comparison: (drive || unc ? normalized.toLowerCase() : normalized),
      kind: drive ? "windows" : unc ? "unc" : "posix",
      depth: parts.length
    };
  }

  function isContained(rootPath, candidatePath, allowRoot) {
    const root = parseAbsolutePath(rootPath, "workspace root");
    const candidate = parseAbsolutePath(candidatePath, "path");
    if (root.kind !== candidate.kind) return false;
    if (candidate.comparison === root.comparison) return !!allowRoot;
    const prefix = root.comparison.endsWith("/") ? root.comparison : root.comparison + "/";
    return candidate.comparison.indexOf(prefix) === 0;
  }

  function isUnicodeAliasCandidate(rootPath, candidatePath, allowRoot) {
    const root = parseAbsolutePath(rootPath, "workspace root");
    const candidate = parseAbsolutePath(candidatePath, "path");
    if (root.kind !== candidate.kind || typeof root.comparison.normalize !== "function") return false;
    const rootKey = root.comparison.normalize("NFC"), candidateKey = candidate.comparison.normalize("NFC");
    const prefix = rootKey.endsWith("/") ? rootKey : rootKey + "/";
    return candidateKey === rootKey ? !!allowRoot : candidateKey.indexOf(prefix) === 0;
  }

  function validateLoopbackBridgeUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) {
      throw workspaceError("UXP_INVALID_BRIDGE_URL", "Bridge URL is invalid");
    }
    if (url.protocol !== "ws:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      url.pathname !== "/uxp" || url.username || url.password || url.hash) {
      throw workspaceError("UXP_INVALID_BRIDGE_URL", "Bridge URL must be ws://127.0.0.1:<port>/uxp or ws://localhost:<port>/uxp");
    }
    url.search = "";
    return url;
  }

  function nativePathOf(fs, entry) {
    if (entry && typeof entry.nativePath === "string" && entry.nativePath) return entry.nativePath;
    if (entry && fs && typeof fs.getNativePath === "function") return fs.getNativePath(entry);
    return "";
  }

  function toFileUrl(nativePath) {
    const parsed = parseAbsolutePath(nativePath, "path");
    const encoded = parsed.normalized.split("/").map((part, index) => parsed.kind === "windows" && index === 0 ? part : encodeURIComponent(part)).join("/");
    if (parsed.kind === "windows") return "file:/" + encoded;
    return "file:" + encoded;
  }

  function createCanonicalPathResolver(deps) {
    const fs = deps && deps.fs;
    if (!fs || typeof fs.getEntryWithUrl !== "function") return undefined;
    return async function resolveCanonicalPath(value, options) {
      const label = options && options.label || "path";
      const kind = options && options.kind || "file";
      let entry;
      try {
        // Same %20 fallback as configureRoot: Premiere 27 wants the plain path.
        try { entry = await fs.getEntryWithUrl(toFileUrl(value)); } catch (first) { entry = await fs.getEntryWithUrl("file:" + parseAbsolutePath(value, label).normalized).catch(() => { throw first; }); }
      } catch (error) {
        if (error && /^UXP_[A-Z0-9_]+$/.test(error.code || "")) throw error;
        throw workspaceError("UXP_CANONICAL_PATH_UNAVAILABLE", "This UXP host could not resolve " + label + " to a canonical filesystem path");
      }
      const native = nativePathOf(fs, entry);
      if (!native) {
        throw workspaceError("UXP_CANONICAL_PATH_UNAVAILABLE", "This UXP host could not resolve " + label + " to a canonical filesystem path");
      }
      if (kind === "directory" && entry && entry.isFile) {
        throw workspaceError("UXP_INVALID_ARGUMENT", label + " must be a directory");
      }
      if (kind === "file" && entry && entry.isFolder) {
        throw workspaceError("UXP_INVALID_ARGUMENT", label + " must be a file");
      }
      return parseAbsolutePath(native, label).normalized;
    };
  }

  function createWorkspaceBroker(deps) {
    const fs = deps && deps.fs;
    const resolveCanonicalPath = deps && deps.resolveCanonicalPath;
    let rootEntry = null;
    let persistentToken = null;
    let configuredRoot = false;
    let configError = null;
    let configRefused = false;
    let pickedFolderName = null;
    let initialized = false;

    function nativePathFor(entry) {
      return nativePathOf(fs, entry);
    }

    async function dataFolder() {
      if (!fs || typeof fs.getDataFolder !== "function") {
        throw workspaceError("UXP_WORKSPACE_UNAVAILABLE", "UXP persistent storage is unavailable");
      }
      return fs.getDataFolder();
    }

    async function readConfiguration() {
      try {
        const folder = await dataFolder();
        const file = await folder.getEntry(CONFIG_FILE);
        const parsed = JSON.parse(await file.read());
        if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.persistentToken !== "string") return null;
        return parsed;
      } catch (_) {
        return null;
      }
    }

    async function writeConfiguration(token) {
      const folder = await dataFolder();
      const file = await folder.createFile(CONFIG_FILE, { overwrite: true });
      await file.write(JSON.stringify({ schemaVersion: 1, persistentToken: token }));
    }

    async function deleteConfiguration() {
      try {
        const folder = await dataFolder();
        const file = await folder.getEntry(CONFIG_FILE);
        if (file && typeof file.delete === "function") await file.delete();
      } catch (_) {}
    }

    async function initialize() {
      if (initialized) return status();
      initialized = true;
      const stored = await readConfiguration();
      if (!stored || !fs || typeof fs.getEntryForPersistentToken !== "function") return status();
      try {
        const entry = await fs.getEntryForPersistentToken(stored.persistentToken);
        if (entry && entry.isFolder && nativePathFor(entry)) {
          rootEntry = entry;
          persistentToken = stored.persistentToken;
        }
      } catch (_) {
        await deleteConfiguration();
      }
      return status();
    }

    async function requestRoot() {
      if (!fs || typeof fs.getFolder !== "function" || typeof fs.createPersistentToken !== "function") {
        throw workspaceError("UXP_WORKSPACE_UNAVAILABLE", "This UXP runtime cannot request persistent folder access");
      }
      const entry = await fs.getFolder();
      const nativePath = nativePathFor(entry);
      if (!entry || !entry.isFolder || !nativePath) {
        throw workspaceError("UXP_WORKSPACE_NOT_SELECTED", "No workspace folder was selected");
      }
      if (parseAbsolutePath(nativePath, "workspace root").depth < 1) {
        throw workspaceError("UXP_WORKSPACE_TOO_BROAD", "Choose a project subfolder instead of a filesystem or share root");
      }
      const token = await fs.createPersistentToken(entry);
      if (typeof token !== "string" || !token) {
        throw workspaceError("UXP_WORKSPACE_UNAVAILABLE", "Premiere did not return a persistent workspace token");
      }
      await writeConfiguration(token);
      persistentToken = token;
      initialized = true;
      if (configRefused) return status();
      if (configuredRoot && rootEntry) {
        // The server's configured root wins. The picked folder is stored but not used, and the conflict is reported.
        pickedFolderName = samePath(entry, rootEntry) ? null : entry.name || "picked folder";
        return status();
      }
      rootEntry = entry;
      configuredRoot = false;
      return status();
    }

    function samePath(a, b) {
      const left = nativePathFor(a), right = nativePathFor(b);
      return !!(left && right && parseAbsolutePath(left, "folder").comparison === parseAbsolutePath(right, "folder").comparison);
    }

    // A user's home folder (or its Windows/Linux equivalent) is far too broad to approve for file access.
    function isHomeFolder(parsed) {
      return /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+$/i.test(parsed.normalized);
    }

    // The MCP server sends its approved root (PREMIERE_UXP_WORKSPACE_ROOT) after the handshake. It needs
    // the manifest's "fullAccess" file permission, so no picker click is required. If the operator also
    // picked a different folder in the panel, the server's root wins and the conflict is reported in status().
    async function configureRoot(value) {
      try {
        if (!fs || typeof fs.getEntryWithUrl !== "function") {
          throw workspaceError("UXP_WORKSPACE_UNAVAILABLE", "This UXP runtime cannot open a configured workspace folder; use Choose folder in the MCP panel");
        }
        const parsed = parseAbsolutePath(value, "configured workspace root");
        if (parsed.depth < 2 || isHomeFolder(parsed)) {
          throw workspaceError("UXP_WORKSPACE_TOO_BROAD", "Configure a project subfolder, not a filesystem root, share root or home folder");
        }
        await initialize();
        let entry;
        // Premiere 27 does not decode %20 in file: URLs, so fall back to the plain path (most project folders contain spaces).
        try { entry = await fs.getEntryWithUrl(toFileUrl(parsed.normalized)); } catch (_) { try { entry = await fs.getEntryWithUrl("file:" + parsed.normalized); } catch (_) { entry = null; } }
        if (!entry) {
          throw workspaceError("UXP_WORKSPACE_UNAVAILABLE", "Premiere could not open the configured workspace folder. Check that it exists and that the panel manifest uses localFileSystem fullAccess");
        }
        if (!entry || !entry.isFolder || !nativePathFor(entry)) {
          throw workspaceError("UXP_WORKSPACE_NOT_SELECTED", "The configured workspace root is not a folder");
        }
        const picked = persistentToken && rootEntry && !configuredRoot ? rootEntry : null;
        pickedFolderName = picked && !samePath(picked, entry) ? picked.name || "picked folder" : null;
        rootEntry = entry;
        configuredRoot = true;
        configRefused = false;
        configError = null;
        return status();
      } catch (error) {
        // Fail closed: a refused server root leaves no approved folder at all (not the old root, not a picked
        // folder) until a later config frame succeeds, so every path command is refused.
        rootEntry = null;
        configuredRoot = false;
        pickedFolderName = null;
        configRefused = true;
        initialized = true;
        configError = error && error.message ? String(error.message) : String(error);
        throw error;
      }
    }

    /**
     * Applies the server's one config frame per connection. Later frames on the same connection are swallowed
     * and ignored. Returns true when the frame was a config frame (so the caller does not dispatch it).
     */
    function createServerConfigReceiver(broker, hooks) {
      let applied = false;
      return {
        reset() { applied = false; },
        receive(raw) {
          if (typeof raw !== "string" || raw.indexOf('"config"') === -1) return false;
          let frame;
          try { frame = JSON.parse(raw); } catch (_) { return false; }
          if (!frame || frame.type !== "config") return false;
          if (applied) return true;
          applied = true;
          const root = frame.payload && frame.payload.workspaceRoot;
          if (typeof root === "string" && root) {
            broker.configureRoot(root).then((value) => hooks && hooks.onApplied && hooks.onApplied(value), (error) => hooks && hooks.onError && hooks.onError(error));
          }
          return true;
        }
      };
    }

    async function revoke() {
      rootEntry = null;
      persistentToken = null;
      configuredRoot = false;
      configError = null;
      configRefused = false;
      pickedFolderName = null;
      initialized = true;
      await deleteConfiguration();
      return status();
    }

    function canWalkGrantedFolder() {
      return !!(rootEntry && typeof rootEntry.getEntry === "function");
    }

    function status() {
      return {
        configured: !!rootEntry,
        accessMode: configuredRoot ? "configured" : "request",
        rootName: rootEntry && typeof rootEntry.name === "string" ? rootEntry.name : null,
        persistent: !!persistentToken && !configuredRoot && !configRefused,
        configError: configError,
        pickedFolderIgnored: configuredRoot && pickedFolderName ? pickedFolderName : null,
        pathDisclosure: "redacted",
        canonicalPathValidation: typeof resolveCanonicalPath === "function" || canWalkGrantedFolder() ? "available" : "unavailable"
      };
    }

    function relativeSegments(rootPath, candidatePath, label) {
      const root = parseAbsolutePath(rootPath, "workspace root");
      const candidate = parseAbsolutePath(candidatePath, label);
      if (candidate.comparison === root.comparison) return [];
      const prefix = root.comparison.endsWith("/") ? root.comparison : root.comparison + "/";
      if (candidate.comparison.indexOf(prefix) !== 0) {
        throw workspaceError("UXP_PATH_OUTSIDE_WORKSPACE", label + " must stay inside the approved workspace folder");
      }
      return candidate.normalized.slice(root.normalized.length).replace(/^\//, "").split("/").filter(Boolean);
    }

    async function resolveThroughGrantedFolder(candidatePath, options) {
      const label = options && options.label || "path";
      if (!canWalkGrantedFolder()) {
        throw workspaceError("UXP_CANONICAL_PATH_UNAVAILABLE", "The approved workspace folder cannot be walked on this host, so the path cannot be checked. Nothing was changed");
      }
      const rootPath = nativePathFor(rootEntry);
      const segments = relativeSegments(rootPath, candidatePath, label);
      let entry = rootEntry;
      for (let index = 0; index < segments.length; index += 1) {
        if (!entry || typeof entry.getEntry !== "function") {
          throw workspaceError("UXP_CANONICAL_PATH_UNAVAILABLE", "The approved workspace folder cannot be walked on this host, so the path cannot be checked. Nothing was changed");
        }
        try {
          entry = await entry.getEntry(segments[index]);
        } catch (error) {
          if (error && /^UXP_[A-Z0-9_]+$/.test(error.code || "")) throw error;
          throw workspaceError("UXP_CANONICAL_PATH_UNAVAILABLE", "This UXP host could not resolve " + label + " to a canonical filesystem path");
        }
      }
      const native = nativePathFor(entry);
      if (!native) {
        throw workspaceError("UXP_CANONICAL_PATH_UNAVAILABLE", "This UXP host could not resolve " + label + " to a canonical filesystem path");
      }
      return parseAbsolutePath(native, label).normalized;
    }

    async function assertPathAllowed(value, options) {
      const label = options && options.label || "path";
      const kind = options && options.kind || "file";
      const rootPath = nativePathFor(rootEntry);
      if (!rootEntry || !rootPath) {
        throw workspaceError("UXP_WORKSPACE_REQUIRED", "No workspace folder is approved for " + label + ". Set PREMIERE_UXP_WORKSPACE_ROOT on the MCP server, or click Choose folder in the MCP for Adobe Premiere Pro panel. Nothing was changed");
      }
      const candidate = parseAbsolutePath(value, label);
      const lexicallyContained = isContained(rootPath, candidate.normalized, kind === "directory");
      if (!lexicallyContained && !isUnicodeAliasCandidate(rootPath, candidate.normalized, kind === "directory")) {
        throw workspaceError("UXP_PATH_OUTSIDE_WORKSPACE", label + " must stay inside the approved workspace folder");
      }
      // Unicode equivalence is only a preliminary check. Distinct filesystems
      // can store both spellings, so the final canonical containment stays exact.
      const canonicalResolver = typeof resolveCanonicalPath === "function" ? resolveCanonicalPath
        : !lexicallyContained || !canWalkGrantedFolder() ? createCanonicalPathResolver({ fs }) : undefined;
      if (!lexicallyContained && typeof canonicalResolver !== "function") {
        throw workspaceError("UXP_CANONICAL_PATH_UNAVAILABLE", label + " uses a different Unicode spelling from the approved folder. An independent canonical resolver is required; use the selected folder's native spelling until that identity can be checked. Nothing was changed.");
      }
      // Lexical containment cannot detect symlink, junction, or reparse-point
      // escapes. Prefer an embedder-supplied resolver; otherwise walk from the
      // granted folder Entry so nativePath reflects the host's resolved target.
      let canonicalRootValue, canonicalCandidateValue;
      try {
        if (typeof canonicalResolver === "function") {
          canonicalRootValue = await canonicalResolver(rootPath, { label: "workspace root", kind: "directory" });
          canonicalCandidateValue = await canonicalResolver(candidate.normalized, { label, kind });
        } else {
          canonicalRootValue = await resolveThroughGrantedFolder(rootPath, { label: "workspace root", kind: "directory" });
          canonicalCandidateValue = await resolveThroughGrantedFolder(candidate.normalized, { label, kind });
        }
      } catch (error) {
        if (error && /^UXP_[A-Z0-9_]+$/.test(error.code || "")) throw error;
        throw workspaceError("UXP_CANONICAL_PATH_UNAVAILABLE", "This UXP host could not resolve " + label + " to a canonical filesystem path");
      }
      const canonicalRoot = parseAbsolutePath(canonicalRootValue, "workspace root");
      const canonicalCandidate = parseAbsolutePath(canonicalCandidateValue, label);
      if (!isContained(canonicalRoot.normalized, canonicalCandidate.normalized, kind === "directory")) {
        throw workspaceError("UXP_PATH_OUTSIDE_WORKSPACE", label + " resolves outside the approved workspace folder");
      }
      return canonicalCandidate.normalized;
    }

    // Whether a file exists inside the approved folder. A plugin with "request" file access
    // cannot open arbitrary file: URLs (getEntryWithUrl fails even for files that exist), so
    // walk from the granted folder Entry. Null means the answer is unavailable here.
    async function fileExists(value) {
      const rootPath = nativePathFor(rootEntry);
      if (!rootEntry || !rootPath || !canWalkGrantedFolder()) return null;
      let segments;
      try {
        segments = relativeSegments(rootPath, value, "path");
      } catch (_) {
        return null;
      }
      if (!segments.length) return false;
      let entry = rootEntry;
      for (let index = 0; index < segments.length; index += 1) {
        if (!entry || typeof entry.getEntry !== "function") return false;
        try {
          entry = await entry.getEntry(segments[index]);
        } catch (_) {
          return false;
        }
      }
      return !!(entry && !entry.isFolder);
    }

    return { initialize, requestRoot, configureRoot, createConfigReceiver: (hooks) => createServerConfigReceiver({ configureRoot }, hooks), revoke, status, assertPathAllowed, fileExists };
  }

  return { createWorkspaceBroker, createCanonicalPathResolver, parseAbsolutePath, isContained, validateLoopbackBridgeUrl, workspaceError };
});
