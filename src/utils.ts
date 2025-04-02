import { homedir } from "os"
import * as fs from "node:fs/promises"
import path from "path"
import type { Config } from "./config"
import { type Path } from "glob"
import {
  type Computer,
  type ResolvedFileRule,
  type ValidationResult as ResolveSyncRulesResult,
} from "./types"
import { AppError, ErrorSeverity, getErrorMessage, isNodeError } from "./errors"
import stripAnsi from "strip-ansi"
import { cachedGlob, invalidateGlobCache, pathCache } from "./cache"
import { err, ok, Result } from "neverthrow"
import {
  createFileSyncResult,
  createFileSyncSummary,
  type FileSyncResult,
  type FileSyncSummary,
} from "./results"

// ---- Language ----
export const pluralize = (text: string) => {
  return (count: number) => {
    const isPlural = Math.abs(count) !== 1
    return isPlural ? `${text}s` : text
  }
}

// ---- Date ----
export const getFormattedDate = (): string => {
  const now = new Date()
  const time = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
  const date = now.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  })
  return `${time} on ${date}`
}

// ---- Screen ----
/**
 * Clears the screen and moves the cursor to the top-left. Uses ANSI escape codes.
 *
 * Unlike `console.log`, this keeps the scroll history intact.
 */
export function clearScreen() {
  process.stdout.write("\x1B[2J\x1B[0f")
}

// ---- Paths ----
export function resolvePath(filePath: string): string {
  // Handle home directory expansion
  if (filePath.startsWith("~")) {
    return path.join(homedir(), filePath.slice(1))
  }
  return path.resolve(filePath)
}

export const toTildePath = (fullPath: string): string => {
  const home = homedir()
  return fullPath.startsWith(home) ? fullPath.replace(home, "~") : fullPath
}

/**
 * Determines if a path is likely a file rather than a directory.
 *
 * A path is considered a likely file if:
 * 1. It doesn't end with a slash (after normalization)
 * 2. The last segment contains a period that's not at the beginning
 *
 * @param pathStr Path to analyze
 * @returns true if the path is likely a file, false if likely a directory
 */
export const pathIsLikelyFile = (pathStr: string): boolean => {
  // Normalize and sanitize first, but preserve trailing slash
  const processedPath = processPath(pathStr)

  // If it has a trailing slash, it's definitely a directory
  if (processedPath.endsWith("/")) {
    return false
  }

  // Get the last segment of the path (after last slash or full path if no slash)
  const lastSegment = processedPath.split("/").pop() || processedPath

  // If it has a file extension, it's likely a file
  if (lastSegment.includes(".") && !lastSegment.startsWith(".")) {
    return true
  }

  // we assume it's a directory (safer default for copying)
  return false
}

/**
 * Sanitizes a path string by:
 * 1. Removing ANSI escape sequences
 * 2. Replacing control characters with forward slashes
 *
 * This function ONLY handles problematic characters and does not
 * modify the path structure (no backslash conversion, etc.)
 *
 * @param pathStr The path string to sanitize
 * @returns A sanitized path string without control chars or ANSI sequences
 */
export function sanitizePath(pathStr: string): string {
  if (typeof pathStr !== "string") {
    throw new TypeError("Path must be a string")
  }

  // Return early for empty paths
  if (!pathStr) return pathStr

  // Step 1: Strip any ANSI escape sequences
  let sanitized = stripAnsi(pathStr)

  // Step 2:
  // Replace control characters with forward slashes rather than removing them
  // to maintain path structure integrity and prevent path segments from merging
  // This regex targets control characters (0-31, 127) BUT NOT BACKSLASH (which is 92)
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]+/g, "/")

  return sanitized
}

/**
 * Normalizes a file path to use forward slashes and handles trailing slashes consistently.
 *
 * By default, we keep trailing slashes for normalized paths in our code. This preserves the semantic meaning of the path as a directory. We can explicitly strip them only when needed for specific operations.
 *
 * Does NOT handle sanitization of control characters or ANSI sequences. See {@link sanitizePath}.
 *
 * @param filepath The path to normalize
 * @param stripTrailing Whether to remove trailing slash (default: false)
 * @returns Normalized path
 */
export const normalizePath = (
  filepath: string,
  stripTrailing = false
): string => {
  if (typeof filepath !== "string") {
    throw new TypeError("Path must be a string")
  }

  // Handle empty path
  if (!filepath) return ""

  const trimmed = filepath.trim()

  if (!trimmed) return ""

  // Special cases
  if (trimmed === "\\" || trimmed === "/") return "/"
  if (trimmed === ".") return "."
  if (trimmed === "..") return ".."

  // Normalize using Node's path.normalize first (handles . and .., and removed duplicate slashes)
  let normalized = path.posix.normalize(trimmed)

  // Handle Windows drive letters consistently
  const hasWindowsDrive = /^[A-Z]:/i.test(normalized)

  // Convert all backslashes to forward slashes
  normalized = normalized.replace(/\\/g, "/")

  // Strip ./ from the beginning if present
  if (normalized.startsWith("./")) {
    normalized = normalized.substring(2)
  }

  // Handle trailing slash based on the path type
  if (stripTrailing) {
    const isDriveRoot = /^[A-Z]:\/$/i.test(normalized)
    const isShareRoot = /^\/\/[^/]+\/[^/]+\/$/.test(normalized)
    const isFileRoot = normalized === "/"
    if (!isDriveRoot && !isShareRoot && !isFileRoot && normalized.length > 1) {
      normalized = normalized.replace(/\/$/, "")
    }
  }

  // Restore Windows drive letter if present
  if (hasWindowsDrive && normalized.length >= 2 && normalized[1] !== ":") {
    normalized = normalized[0] + ":" + normalized.substring(1)
  }

  return normalized
}

/**
 * Comprehensive path processing function that both sanitizes and normalizes a path.
 * This is the primary function that should be used when processing paths for most operations.
 *
 * Steps performed:
 * 1. Sanitize (remove ANSI, control chars)
 * 2. Normalize (handle backslashes, resolves . and .., and remove duplicate slashes)
 *
 * @param filepath The path to process
 * @param stripTrailing Whether to remove trailing slash (default: false)
 * @returns A fully sanitized and normalized path
 */
export function processPath(input: string, stripTrailing = false): string {
  // Create a cache key that includes both the input and the stripTrailing flag
  const cacheKey = `${input}::${stripTrailing ? 1 : 0}`

  // Check if result is in cache
  const cachedResult = pathCache.get<string>(cacheKey)
  if (cachedResult !== undefined) {
    return cachedResult
  }

  // First sanitize any problematic characters
  const sanitized = sanitizePath(input)

  // Then perform standard path normalization
  const result = normalizePath(sanitized, stripTrailing)

  // Cache the result
  pathCache.set(cacheKey, result)

  return result
}

/**
 * Compares two paths for equality, accounting for platform differences
 */
export const pathsAreEqual = (path1: string, path2: string): boolean => {
  const norm1 = processPath(path1)
  const norm2 = processPath(path2)

  // On Windows, paths are case-insensitive
  if (process.platform === "win32") {
    return norm1.toLowerCase() === norm2.toLowerCase()
  }

  return norm1 === norm2
}

/**
 * Ensures a path uses the correct separators for the current OS.
 * Use this when making actual filesystem calls.
 */
export const toSystemPath = (filepath: string): string => {
  return process.platform === "win32" ? filepath.replace(/\//g, "\\") : filepath
}

/**
 * Returns a user-friendly display path of a file relative to the given root directory
 *
 * @param filePath Absolute path to the file
 * @param rootPath Absolute path to the root directory
 * @param options Options for formatting the relative path
 * @returns A formatted relative path for display
 */
export function getRelativePath(
  filePath: string,
  rootPath: string,
  options: {
    includeRootName?: boolean // Include the source root directory name
    normalize?: boolean // Normalize path separators to forward slashes
  } = {}
): string {
  const { includeRootName = false, normalize = true } = options

  // Get the relative path (will use OS-specific separators)
  let relativePath = path.relative(rootPath, filePath)

  // Optionally include root dir name
  if (includeRootName) {
    const rootName = path.basename(rootPath)
    relativePath = path.join(rootName, relativePath)
  }

  // Normalize slashes for display if requested (useful for consistent UI)
  if (normalize) {
    relativePath = normalizePath(relativePath)
  }

  return relativePath
}

export const isRecursiveGlob = (pattern: string): boolean => {
  // Match any pattern containing ** which indicates recursion
  const result = pattern.includes("**")
  // console.log("isRecursiveGlob:", { pattern, result })
  return result
}

// - - - - - MINECRAFT - - - - -

interface SaveValidationResult {
  isValid: boolean
  savePath: string
  errors: string[]
  missingFiles: string[]
}

/**
 * Verifies that the path specified by 'saveDir' points to a valid Minecraft save/instance directory. Additionally, verifies that the Minecraft save has the required 'computerModDir', i.e. CC: Tweaked uses `computercraft/computer`.
 *
 * A valid Minecraft save is assumed to have specific files/dirs such as "level.dat", "session.lock", "region/"
 *
 * @param saveDir Absolute path to Minecraft save
 * @param computerModDir Relative path (from root of saveDir) to the directory containing the computers
 * @returns
 */
export const validateMinecraftSave = async (
  saveDir: string,
  computerModDir = "computercraft/computer"
): Promise<SaveValidationResult> => {
  const savePath = processPath(resolvePath(saveDir))
  const result: SaveValidationResult = {
    isValid: false,
    savePath,
    errors: [],
    missingFiles: [],
  }

  // Key files/dirs that should exist in a valid Minecraft save
  const keyPaths = ["level.dat", "session.lock", "region"]

  try {
    // First check if the directory exists
    try {
      await fs.access(savePath)
    } catch (err) {
      result.errors.push(`Save directory not found: ${savePath}`)
      return result
    }

    // Check each key file/directory
    await Promise.all(
      keyPaths.map(async (kf) => {
        try {
          await fs.access(path.join(savePath, kf))
        } catch (err) {
          result.missingFiles.push(kf)
        }
      })
    )

    // If we have any missing files, add an error
    if (result.missingFiles.length > 0) {
      result.errors.push(
        `The folder at ${savePath} doesn't appear to be a Minecraft save.`
      )
    }

    // Specific check for computercraft directory
    const errorMessage = `${computerModDir} not found. Is 'CC: Tweaked' mod installed?`
    try {
      const computerModDirPath = path.join(savePath, computerModDir)
      // Check if the directory exists and if it's a directory
      const computercraftStats = await fs.stat(computerModDirPath)

      if (!computercraftStats.isDirectory()) {
        result.errors.push(errorMessage)
      }
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        // Directory doesn't exist
        result.errors.push(errorMessage)
      } else {
        // Other errors (e.g., permission issues, etc.)
        result.errors.push(
          `Unexpected failure to validate '${computerModDir}: ${getErrorMessage(err)}'`
        )
      }
    }

    // Set isValid if we have no errors
    result.isValid = result.errors.length === 0

    return result
  } catch (err) {
    result.errors.push(
      `Validation failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return result
  }
}

// - - - - - COMPUTERS - - - - -

const EXCLUDED_DIRS = new Set([".vscode", ".git", ".DS_Store"])

export const getComputerShortPath = (saveName: string, computerId: string) => {
  return normalizePath(
    path
      .join(saveName, "computercraft", "computer", computerId)
      .replace("computercraft", "..")
  )
}

export const findMinecraftComputers = async (savePath: string) => {
  try {
    // Build path to computercraft directory
    const computercraftPath = processPath(
      path.join(savePath, "computercraft", "computer")
    )

    // Check if directory exists
    try {
      await fs.access(computercraftPath)
    } catch (err) {
      throw new Error(
        `ComputerCraft directory not found at ${computercraftPath}`
      )
    }

    const computers: Computer[] = []

    // Get the save name from the path
    const savePathParts = computercraftPath.split(path.sep)
    const saveIndex = savePathParts.findIndex((part) => part === "saves")
    const saveName = saveIndex !== -1 ? savePathParts[saveIndex + 1] : ""

    // Read all subdirectories
    const entries = await fs.readdir(computercraftPath, {
      withFileTypes: true,
    })

    for (const entry of entries) {
      // Skip if it's not a directory or if it's in the excluded list
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) {
        continue
      }

      const computerPath = path.join(computercraftPath, entry.name)
      const shortPath = getComputerShortPath(saveName, entry.name)

      computers.push({
        id: entry.name,
        path: computerPath,
        shortPath,
      })
    }

    return computers.sort((a, b) => {
      // Sort numerically if both IDs are numbers
      const numA = parseInt(a.id)
      const numB = parseInt(b.id)
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB
      }
      // Otherwise sort alphabetically
      return a.id.localeCompare(b.id)
    })
  } catch (err) {
    throw new Error(`Failed to discover computers: ${err}`)
  }
}

// - - - - - Files - - - - -

/**
 * Filters a list of paths to include only files and exclude directories
 *
 * This utility efficiently processes file paths in batches to avoid exhausting file descriptors.
 *
 * Paths that cannot be accessed (due to permissions or non-existence) will be silently filtered out.
 *
 * @param paths - Array of file paths to filter
 * @param concurrency - Maximum number of concurrent file operations (default: 50)
 * @returns Promise resolving to an array containing only the paths that are files
 * @example
 * // Filter only actual files from glob results
 * const allPaths = await glob("*");
 * const onlyFiles = await filterFilesOnly(allPaths);
 */
export async function filterFilesOnly(
  paths: string[],
  concurrency = 50
): Promise<string[]> {
  // Use a simple concurrency pool to avoid opening too many file handles
  const results: string[] = []
  const chunks: string[][] = []

  // Split into chunks for concurrent processing
  const chunkSize = Math.max(1, Math.min(concurrency, paths.length))
  for (let i = 0; i < paths.length; i += chunkSize) {
    chunks.push(paths.slice(i, i + chunkSize))
  }

  // Process each chunk sequentially, but files within a chunk concurrently
  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map(async (filePath) => {
        try {
          const stats = await fs.stat(toSystemPath(filePath))
          return stats.isFile() ? filePath : null
        } catch (err) {
          return null // Skip files that can't be accessed // TODO may need to return error instead of silently skipping
        }
      })
    )

    results.push(
      ...chunkResults.filter((path): path is string => path !== null)
    )
  }

  return results
}

/**
 * Resolves computer references into a flat array of computer IDs, recursively expanding group references.
 *
 * This function handles:
 * - Exact computer IDs (e.g., "1", "2")
 * - Group references that contain computer IDs
 * - Nested group references
 * - Circular references (safely avoided)
 *
 * @example
 * // Config with nested groups
 * const config = {
 *   computerGroups: {
 *     monitors: { name: "Monitors", computers: ["1", "2"] },
 *     servers: { name: "Servers", computers: ["3", "monitors"] }
 *   }
 * };
 *
 * // Returns { resolvedIds: ["3", "1", "2"], errors: [] }
 * resolveComputerReferences("servers", config);
 *
 * // Returns { resolvedIds: ["5", "3", "1", "2"], errors: [] }
 * resolveComputerReferences(["5", "servers"], config);
 *
 * // Returns { resolvedIds: [], errors: ["invalid computer groups → \"unknown\""] }
 * resolveComputerReferences("unknown", config);
 *
 * @param computers - Single computer ID, group name, or array of computer IDs and group names
 * @param config - The full config object containing computerGroups definitions
 * @returns Object containing resolved IDs and any errors encountered
 */
export function resolveComputerReferences(
  computers: string | string[] | undefined,
  config: Config
): { resolvedIds: string[]; errors: string[] } {
  if (!computers) return { resolvedIds: [], errors: [] }

  const computersList = Array.isArray(computers) ? computers : [computers]
  const resolvedIds = new Set<string>() // Use a set to avoid duplicates
  const processedGroups = new Set<string>() // track processed groups to avoid infinite recursion
  const invalidGroups: string[] = [] // Track invalid group references

  // Helper to recursively resolve group references
  function resolveGroup(groupName: string) {
    // Skip if already processed to prevent infinite loops
    if (processedGroups.has(groupName)) return

    const group = config.computerGroups?.[groupName]
    if (!group) return

    processedGroups.add(groupName)

    for (const computer of group.computers) {
      if (!isNaN(Number(computer))) {
        // It's a computer ID
        resolvedIds.add(computer)
      } else if (config.computerGroups?.[computer]) {
        // It's a group reference
        resolveGroup(computer)
      } else {
        // It's an invalid reference - track it
        invalidGroups.push(computer)
      }
    }
  }

  // Process each entry
  for (const entry of computersList) {
    if (config.computerGroups?.[entry]) {
      // It's a group name, resolve it
      resolveGroup(entry)
    } else if (!isNaN(Number(entry))) {
      // It's a valid computer ID
      resolvedIds.add(entry)
    } else {
      // It's neither a valid group nor a numeric ID
      invalidGroups.push(entry)
    }
  }

  const result = {
    resolvedIds: Array.from(resolvedIds),
    errors: [] as string[],
  }

  // Only add error if we found invalid groups
  if (invalidGroups.length > 0) {
    result.errors.push(
      `Invalid computer groups → "${[...new Set(invalidGroups)].join(", ")}"`
    )
  }

  return result
}

/**
 * Using the config file, will resolve sync rules into viable files ({@link ResolvedFileRule}) and their available or missing computers that are intended targets.
 *
 * For each sync rule, this function will first find all source files that match the `rule.source` pattern/glob. If `selectedFiles` parameter is passed, i.e. from files changed during watch mode, only these files--rather than all of the rule's matched files--will be resolved. Next, all computer ID's will be resolved for this rule--expanding computer groups into a distinct set of comptuer ID's. Finally a {@link ResolveSyncRulesResult} is returned.
 */
export async function resolveSyncRules(
  config: Config,
  computers: Computer[],
  selectedFiles?: Set<string>
): Promise<ResolveSyncRulesResult> {
  const resolvedResult: ResolveSyncRulesResult = {
    resolvedFileRules: [],
    availableComputers: [],
    missingComputerIds: [],
    errors: [],
  }

  const processedSourceRootPath = processPath(config.sourceRoot)

  // Process each sync rule
  for (const rule of config.rules) {
    try {
      // Find all matching source files using cached glob
      const matchedPaths = (await cachedGlob(processPath(rule.source, false), {
        cwd: processedSourceRootPath,
        withFileTypes: true,
      })) as Path[]

      // Filter to only include files (not directories)
      const matchedSourceFiles = matchedPaths
        .filter((path) => path.isFile())
        .map((path) => processPath(path.fullpath()))

      // Filter for 'selectedFiles', i.e. changed files from watch mode
      let filesToResolve

      // TODO: We should mandate whether the passed 'selectedFiles' are absolute or relative (to sourceRoot). Though we are accounting for either here, this feels messy.
      if (selectedFiles) {
        filesToResolve = matchedSourceFiles.filter((file) => {
          // Get the absolute path of the file
          const absolutePath = processPath(file)

          // Check if this absolute path exists in selectedFiles
          if (selectedFiles.has(absolutePath)) {
            return true
          }

          // Also try checking with relative path (more reliable across platforms)
          const relPath = getRelativePath(file, config.sourceRoot)
          const relPathMatches = Array.from(selectedFiles).some(
            (selectedFile) => pathsAreEqual(relPath, selectedFile)
          )
          return relPathMatches
        })
      } else {
        filesToResolve = matchedSourceFiles
      }

      if (filesToResolve.length === 0) {
        resolvedResult.errors.push(
          `No matching files found for: '${toSystemPath(rule.source)}'`
        )
        // continue
      }

      // Resolve computer IDs for this rule
      const { resolvedIds: computerIds, errors } = resolveComputerReferences(
        rule.computers,
        config
      )

      if (errors.length > 0) {
        errors.forEach((e) => {
          resolvedResult.errors.push(e)
        })
        // allow continued processing even if we didnt fully resolve all computer references
      }

      if (computerIds.length === 0) {
        resolvedResult.errors.push(
          `No target computers specified for: '${toSystemPath(rule.source)}'`
        )
        continue
      }

      const missingComputerIds = computerIds.filter(
        (id) => !computers.some((c) => c.id === id)
      )
      resolvedResult.missingComputerIds.push(...missingComputerIds)

      // Create resolved file entries
      for (const sourcePath of filesToResolve) {
        const normalizedTargetPath = processPath(rule.target)
        const isDirectory = !pathIsLikelyFile(normalizedTargetPath)

        resolvedResult.resolvedFileRules.push({
          sourceAbsolutePath: processPath(sourcePath),
          // Calculated relative to sourceRoot
          sourceRelativePath: processPath(
            path.relative(config.sourceRoot, sourcePath)
          ),
          flatten: !isRecursiveGlob(rule.source) || rule.flatten,
          target: {
            type: isDirectory ? "directory" : "file",
            path: normalizedTargetPath,
          },
          computers: computerIds,
        })
      }

      // Track target computers
      const matchingComputers = computers.filter((c) =>
        computerIds.includes(c.id)
      )
      resolvedResult.availableComputers.push(...matchingComputers)
    } catch (err) {
      invalidateGlobCache(processPath(rule.source))
      // Handle the main errors glob can throw
      if (isNodeError(err)) {
        switch (err.code) {
          case "ENOENT":
            resolvedResult.errors.push(
              `Source directory not found: ${toSystemPath(config.sourceRoot)}`
            )
            break
          case "EACCES":
            resolvedResult.errors.push(
              `Permission denied reading source directory: ${toSystemPath(config.sourceRoot)}`
            )
            break
          case "EMFILE":
            resolvedResult.errors.push(
              "Too many open files. Try reducing the number of glob patterns."
            )
            break
          default:
            resolvedResult.errors.push(
              `Error processing '${toSystemPath(rule.source)}': ${err.message}`
            )
        }
      } else {
        // Handle glob pattern/config errors
        resolvedResult.errors.push(
          `Invalid pattern '${toSystemPath(rule.source)}': ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  // Deduplicate target computers
  resolvedResult.availableComputers = [
    ...new Set(resolvedResult.availableComputers),
  ]
  // Deduplicate missing computer IDs
  resolvedResult.missingComputerIds = [
    ...new Set(resolvedResult.missingComputerIds),
  ]

  return resolvedResult
}

/**
 * Resolves the complete final target path for a file based on a {@link SyncRule}.
 *
 * This function properly handles:
 * 1. File targets - returns the target path directly
 * 2. Directory targets with flatten=true - appends only filename to target directory
 * 3. Directory targets with flatten=false - preserves source directory structure
 *
 * @param rule The resolved file rule containing source and target information
 * @returns Normalized complete target path including filename
 */
export function resolveTargetPath(rule: ResolvedFileRule): string {
  // For file targets, normalize and use the specified path directly
  if (rule.target.type === "file") {
    return processPath(rule.target.path, true) // strip trailing slash for files
  }

  // For directory targets
  // Note: Always ensure the target directory path has a trailing slash
  const targetDir = processPath(rule.target.path) + "/"

  // Normalize the targetDir to ensure it has exactly one trailing slash
  const normalizedTargetDir = targetDir.replace(/\/+$/, "/")

  const sourceFilename = path.basename(rule.sourceAbsolutePath)

  // When flattening, just append the filename to the target directory
  if (rule.flatten !== false) {
    // Default to true if undefined
    return processPath(path.join(normalizedTargetDir, sourceFilename))
  }

  // When not flattening, preserve source directory structure
  const sourceDir = path.dirname(processPath(rule.sourceRelativePath))

  if (sourceDir === "." || sourceDir === "") {
    // Source file is directly in the source root
    return processPath(path.join(normalizedTargetDir, sourceFilename))
  } else {
    // Source file is in a subdirectory, preserve that structure
    // Ensure the sourceDir doesn't have trailing slashes
    const normalizedSourceDir = processPath(sourceDir, true)
    return processPath(
      normalizedTargetDir + normalizedSourceDir + "/" + sourceFilename
    )
  }
}

/**
 * Helper function that checks if any file rules have same target paths on the same computer, i.e. will overwrite each other on sync
 *
 * @returns a Map of the duplicated target paths. Each key in the map is a string key of `computerID:targetPath` and its value is an array of file rules that target this computer/path combo
 */
export function checkDuplicateTargetPaths(
  resolvedFileRules: ResolvedFileRule[]
): Map<string, ResolvedFileRule[]> {
  // Group file rules by their resolved target paths
  const targetPathMap = new Map<string, ResolvedFileRule[]>()

  for (const rule of resolvedFileRules) {
    const targetPath = resolveTargetPath(rule)

    // For each computer, we need to check for duplicates
    for (const computerId of rule.computers) {
      // Create a unique key combining computer ID and target path
      const key = `${computerId}:${targetPath}`

      if (!targetPathMap.has(key)) {
        targetPathMap.set(key, [rule])
      } else {
        targetPathMap.get(key)?.push(rule)
      }
    }
  }

  // Filter to only include duplicate entries
  return new Map(
    [...targetPathMap.entries()].filter(([_, rules]) => rules.length > 1)
  )
}

export async function copyFilesToComputer(
  resolvedFileRules: ResolvedFileRule[],
  computerPath: string
): Promise<Result<FileSyncSummary, AppError>> {
  const fileResults: FileSyncResult[] = []

  // Normalize the computer path
  const normalizedComputerPath = normalizePath(computerPath)

  // Track directories we've already verified/created to avoid redundant checks
  const verifiedDirs = new Set<string>()

  try {
    for (const rule of resolvedFileRules) {
      // Get the resolved target path relative to computer root
      const relativeTargetPath = resolveTargetPath(rule)

      // Build absolute path by joining with computer path
      const targetFilePath = path.join(
        normalizedComputerPath,
        relativeTargetPath
      )

      // Get directory portion for creating folders if needed
      const targetDirPath = path.dirname(targetFilePath)

      // Security check: Ensure the target path stays within the computer directory
      const relativeToComputer = path.relative(
        normalizedComputerPath,
        targetFilePath
      )
      if (
        normalizePath(relativeToComputer).startsWith("..") ||
        path.isAbsolute(relativeToComputer)
      ) {
        fileResults.push(
          createFileSyncResult(
            rule.sourceAbsolutePath,
            relativeTargetPath,
            false,
            new AppError(
              `Security violation: target path outside computer directory`,
              ErrorSeverity.ERROR,
              "copyFilesToComputer"
            )
          )
        )
        continue
      }

      // Ensure source file exists and is a file
      try {
        const sourceStats = await fs.stat(toSystemPath(rule.sourceAbsolutePath))
        if (!sourceStats.isFile()) {
          fileResults.push(
            createFileSyncResult(
              rule.sourceAbsolutePath,
              relativeTargetPath,
              false,
              new AppError(
                `Source is not a file: ${toSystemPath(rule.sourceAbsolutePath)}`,
                ErrorSeverity.ERROR,
                "copyFilesToComputer"
              )
            )
          )
          continue
        }
      } catch (error) {
        fileResults.push(
          createFileSyncResult(
            rule.sourceAbsolutePath,
            relativeTargetPath,
            false,
            new AppError(
              `Source file not found: ${toSystemPath(rule.sourceAbsolutePath)}`,
              ErrorSeverity.ERROR,
              "copyFilesToComputer"
            )
          )
        )
        continue
      }

      // Check if target directory exists. Only need to verify
      // directories that haven't been previously verified
      if (!verifiedDirs.has(targetDirPath)) {
        try {
          const targetDirStats = await fs.stat(toSystemPath(targetDirPath))
          if (!targetDirStats.isDirectory()) {
            fileResults.push(
              createFileSyncResult(
                rule.sourceAbsolutePath,
                relativeTargetPath,
                false,
                new AppError(
                  `Cannot create directory '${toSystemPath(path.basename(targetDirPath))}' because a file with that name already exists`,
                  ErrorSeverity.ERROR,
                  "copyFilesToComputer"
                )
              )
            )
            continue
          }
        } catch {
          // Directory doesn't exist, create it
          try {
            await fs.mkdir(toSystemPath(targetDirPath), { recursive: true })
          } catch (mkdirErr) {
            fileResults.push(
              createFileSyncResult(
                rule.sourceAbsolutePath,
                relativeTargetPath,
                false,
                new AppError(
                  `Failed to create directory: ${mkdirErr}`,
                  ErrorSeverity.ERROR,
                  "copyFilesToComputer"
                )
              )
            )
            continue
          }
        }
        verifiedDirs.add(targetDirPath)
      }

      // Attempt the file copy operation
      try {
        // Copy the file using system-specific paths
        await fs.copyFile(
          toSystemPath(rule.sourceAbsolutePath),
          toSystemPath(targetFilePath)
        )
        // success
        fileResults.push(
          createFileSyncResult(
            rule.sourceAbsolutePath,
            relativeTargetPath,
            true
          )
        )
      } catch (err) {
        // Handle file copy errors
        const error = new AppError(
          getErrorMessage(err),
          ErrorSeverity.ERROR,
          "copyFilesToComputer",
          err,
          undefined,
          {
            source: rule.sourceRelativePath,
            target: rule.target.path,
          }
        )

        fileResults.push(
          createFileSyncResult(
            rule.sourceAbsolutePath,
            relativeTargetPath,
            false,
            error
          )
        )
      }
    }
    return ok(createFileSyncSummary(fileResults))
  } catch (error) {
    // Only return Err for fatal errors that prevent the entire operation
    return err(
      new AppError(
        `Fatal error in copy operation: ${getErrorMessage(err)}`,
        ErrorSeverity.FATAL,
        "copyFilesToComputerNew",
        err
      )
    )
  }
}

const clearComputer = async (computerDirPath: string) => {
  // ensure path is system-specific
  const computerSystemPath = toSystemPath(computerDirPath)

  const entries = await fs.readdir(computerSystemPath, { withFileTypes: true })

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(computerSystemPath, entry.name)

      if (entry.isDirectory()) {
        // Recursively remove contents, then remove the directory itself
        await fs.rm(fullPath, { recursive: true, force: true })
      } else {
        await fs.unlink(fullPath)
      }
    })
  )
}

export async function clearComputers(computers: Computer[]) {
  try {
    const ops = computers.map((c) => clearComputer(c.path))
    await Promise.all(ops)
    return computers.map((c) => Number(c.id))
  } catch (error: unknown) {
    throw AppError.error(
      `Failed to clear ${pluralize("computer")(computers.length || 1)}`,
      "clearComputers",
      error
    )
  }
}
