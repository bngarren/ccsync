import { homedir } from "os"
import * as fs from "node:fs/promises"
import path from "path"
import type { Config } from "./config"
import { glob } from "glob"
import type {
  Computer,
  ResolvedFileRule,
  ValidationResult as ResolveSyncRulesResult,
} from "./types"
import { isNodeError } from "./errors"
import stripAnsi from "strip-ansi"

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

export const pathIsLikelyFile = (pathStr: string): boolean => {
  // Normalize and sanitize first
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
 * Does NOT handle sanitization of control characters or ANSI sequences. See {@link sanitizePath}.
 *
 * @param filepath The path to normalize
 * @param stripTrailing Whether to remove trailing slash (default: true)
 * @returns Normalized path
 */
export const normalizePath = (
  filepath: string,
  stripTrailing = true
): string => {
  if (typeof filepath !== "string") {
    throw new TypeError("Path must be a string")
  }

  // Handle empty path
  if (!filepath) return ""

  // Special cases
  if (filepath === "\\" || filepath === "/") return "/"
  if (filepath === ".") return "."
  if (filepath === "..") return ".."

  // Normalize using Node's path.normalize first (handles . and .., and removed duplicate slashes)
  let normalized = path.posix.normalize(filepath)

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
 * 2. Normalize (handle backslashes, resolves . and .., and removed duplicate slashes)
 *
 * @param filepath The path to process
 * @param stripTrailing Whether to remove trailing slash (default: true)
 * @returns A fully sanitized and normalized path
 */
export function processPath(input: string, stripTrailing = true): string {
  // First sanitize any problematic characters
  const sanitized = sanitizePath(input)

  // Then perform standard path normalization
  return normalizePath(sanitized, stripTrailing)
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

export const validateMinecraftSave = async (
  saveDir: string
): Promise<SaveValidationResult> => {
  const savePath = resolvePath(saveDir)
  const result: SaveValidationResult = {
    isValid: false,
    savePath,
    errors: [],
    missingFiles: [],
  }

  // Key files that should exist in a valid Minecraft save
  const keyFiles = [
    "level.dat",
    "session.lock",
    "region",
    "computercraft/computer", // Required for ComputerCraft
  ]

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
      keyFiles.map(async (kf) => {
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
    if (!result.missingFiles.includes("computercraft/computer")) {
      try {
        const computercraftStats = await fs.stat(
          path.join(savePath, "computercraft/computer")
        )
        if (!computercraftStats.isDirectory()) {
          result.errors.push("computercraft/computer is not a directory")
        }
      } catch (err) {
        result.errors.push("Failed to check computercraft directory structure")
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
    const computercraftPath = normalizePath(
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
      // Find all matching source files
      const matchedSourceFiles = (
        await glob(processPath(rule.source, false), {
          cwd: processedSourceRootPath,
          absolute: true,
        })
      ).map((sf) => processPath(sf))

      // Filter for 'selectedFiles', i.e. changed files from watch mode
      const filesToResolve = selectedFiles
        ? matchedSourceFiles.filter((file) => {
            const relPath = processPath(path.relative(config.sourceRoot, file))
            return Array.from(selectedFiles).some(
              (changed) => processPath(changed) === relPath
            )
          })
        : matchedSourceFiles

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

      const missingIds = computerIds.filter(
        (id) => !computers.some((c) => c.id === id)
      )
      resolvedResult.missingComputerIds.push(...missingIds)

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
    return processPath(rule.target.path)
  }

  // For directory targets
  const targetDir = processPath(rule.target.path)
  const sourceFilename = path.basename(rule.sourceAbsolutePath)

  // When flattening, just append the filename to the target directory
  if (rule.flatten !== false) {
    // Default to true if undefined
    return processPath(path.join(targetDir, sourceFilename))
  }

  // When not flattening, preserve source directory structure
  const sourceDir = path.dirname(processPath(rule.sourceRelativePath))

  if (sourceDir === "." || sourceDir === "") {
    // Source file is directly in the source root
    return processPath(path.join(targetDir, sourceFilename))
  } else {
    // Source file is in a subdirectory, preserve that structure
    return processPath(path.join(targetDir, sourceDir, sourceFilename))
  }
}

/**
 * Copies files to a specific computer
 */
export async function copyFilesToComputer(
  resolvedFileRules: ResolvedFileRule[],
  computerPath: string
) {
  const copiedFiles = []
  const skippedFiles = []
  const errors = []

  // DEBUG
  // console.log("\n=== Starting copyFilesToComputer ===")
  // console.log("Computer path:", computerPath)
  // console.log("Number of files to process:", resolvedFiles.length)

  // Normalize the computer path
  const normalizedComputerPath = normalizePath(computerPath)

  for (const rule of resolvedFileRules) {
    // Get the resolved target path relative to computer root
    const relativeTargetPath = resolveTargetPath(rule)

    // Build absolute path by joining with computer path
    const targetFilePath = path.join(normalizedComputerPath, relativeTargetPath)

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
      skippedFiles.push(rule.sourceAbsolutePath)
      errors.push(
        `Security violation: Target path '${toSystemPath(rule.target.path)}' attempts to write outside the computer directory`
      )
      continue
    }

    // First ensure source file exists and is a file
    const sourceStats = await fs.stat(toSystemPath(rule.sourceAbsolutePath)) // use systemm-specific path here
    if (!sourceStats.isFile()) {
      skippedFiles.push(rule.sourceAbsolutePath)
      errors.push(
        `Source is not a file: ${toSystemPath(rule.sourceAbsolutePath)}`
      )
      continue
    }

    // Check if target directory exists and is actually a directory
    try {
      const targetDirStats = await fs.stat(toSystemPath(targetDirPath))
      if (!targetDirStats.isDirectory()) {
        skippedFiles.push(rule.sourceAbsolutePath)
        errors.push(
          `Cannot create directory '${toSystemPath(path.basename(targetDirPath))}' because a file with that name already exists`
        )
        continue
      }
    } catch (err) {
      // Directory doesn't exist, create it
      try {
        await fs.mkdir(toSystemPath(targetDirPath), { recursive: true })
      } catch (mkdirErr) {
        skippedFiles.push(rule.sourceAbsolutePath)
        errors.push(`Failed to create directory: ${mkdirErr}`)
        continue
      }
    }

    try {
      // Copy the file using system-specific paths for fs operations
      await fs.copyFile(
        toSystemPath(rule.sourceAbsolutePath),
        toSystemPath(targetFilePath)
      )

      // Verify the copy
      const targetStats = await fs.stat(toSystemPath(targetFilePath))
      if (!targetStats.isFile()) {
        throw new Error(
          `Failed to create target file: ${toSystemPath(targetFilePath)}`
        )
      } else {
        copiedFiles.push(rule.sourceAbsolutePath)
      }
    } catch (err) {
      skippedFiles.push(rule.sourceAbsolutePath)

      if (isNodeError(err)) {
        if (err.code === "ENOENT") {
          errors.push(
            `Source file not found: ${toSystemPath(rule.sourceAbsolutePath)}`
          )
        } else if (err.code === "EACCES") {
          errors.push(`Permission denied: ${err.message}`)
        } else if (err.code === "EISDIR") {
          errors.push(
            `Cannot copy to '${toSystemPath(targetFilePath)}': Is a directory`
          )
        } else if (err.code === "EBUSY") {
          errors.push(
            `File is locked or in use: ${toSystemPath(targetFilePath)}`
          )
        } else {
          errors.push(err instanceof Error ? err.message : String(err))
        }
      } else {
        errors.push(err instanceof Error ? err.message : String(err))
      }

      continue
    }
  }
  return {
    copiedFiles,
    skippedFiles,
    errors,
  }
}
