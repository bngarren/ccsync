import { homedir } from "os"
import * as fs from "node:fs/promises"
import path from "path"
import type { Config } from "./config"
import { glob } from "glob"
import type { Computer, ResolvedFileRule, ValidationResult } from "./types"
import { isNodeError } from "./errors"

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

export const pathIsLikelyFile = (path: string): boolean => {
  // Get the last segment of the path (after last slash or full path if no slash)
  const lastSegment = path.split("/").pop() || path
  // If it contains a dot, it's likely meant to be a file
  return lastSegment.includes(".")
}

/**
 * Normalizes a file path to use forward slashes and handles trailing slashes consistently.
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

  // Special case for root paths
  if (filepath === "\\" || filepath === "/") return "/"

  // Handle empty or very short paths
  if (filepath.length <= 1) return filepath

  // Normalize using Node's path.normalize first (handles . and ..)
  let normalized = path.normalize(filepath)

  // Convert all backslashes to forward slashes
  normalized = normalized.replace(/\\/g, "/")

  // Handle trailing slash based on the path type
  if (stripTrailing) {
    const isDriveRoot = /^[A-Z]:\/$/i.test(normalized)
    const isShareRoot = /^\/\/[^/]+\/[^/]+\/$/.test(normalized)

    if (!isDriveRoot && !isShareRoot && normalized.length > 1) {
      normalized = normalized.replace(/\/$/, "")
    }
  }

  return normalized
}

/**
 * Compares two paths for equality, accounting for platform differences
 */
export const pathsAreEqual = (path1: string, path2: string): boolean => {
  const norm1 = normalizePath(path1)
  const norm2 = normalizePath(path2)

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
 * Resolves computer IDs from a sync rule's computers field, expanding any group names
 * @param computers Computer IDs or group names from a sync rule
 * @param config The full config object for group lookups
 * @returns Array of resolved computer IDs
 * @throws Error if a computer group name is used but doesn't exist
 */
export function resolveComputerIds(
  computers: string | string[] | undefined,
  config: Config
): string[] {
  if (!computers) return []

  const computersList = Array.isArray(computers) ? computers : [computers]

  const invalidGroups: string[] = []
  const resolvedIds = computersList.flatMap((entry) => {
    const group = config.computerGroups?.[entry]
    if (group) {
      return group.computers
    }
    // If not a group, it should be a computer ID
    return [entry]
  })

  // Verify all groups existed
  computersList.forEach((entry) => {
    if (!config.computerGroups?.[entry] && !entry.match(/^\d+$/)) {
      invalidGroups.push(entry)
    }
  })

  if (invalidGroups.length > 0) {
    throw new Error(`invalid computer groups → "${invalidGroups.join(", ")}"`)
  }

  return resolvedIds
}

/**
 * Using the config file, will resolve sync rules into viable files ({@link ResolvedFileRule}) and validates the configuration
 */
export async function validateFileSync(
  config: Config,
  computers: Computer[],
  changedFiles?: Set<string>
): Promise<ValidationResult> {
  const validation: ValidationResult = {
    resolvedFileRules: [],
    availableComputers: [],
    missingComputerIds: [],
    errors: [],
  }

  const normalizedSourceRoot = normalizePath(config.sourceRoot)

  // Process each sync rule
  for (const rule of config.rules) {
    try {
      // Find all matching source files
      const sourceFiles = (
        await glob(rule.source, {
          cwd: normalizedSourceRoot,
          absolute: true,
        })
      ).map((sf) => normalizePath(sf))

      // Filter by changed files if in watch mode
      const relevantFiles = changedFiles
        ? sourceFiles.filter((file) => {
            const relPath = normalizePath(
              path.relative(config.sourceRoot, file)
            )
            return Array.from(changedFiles).some(
              (changed) => normalizePath(changed) === relPath
            )
          })
        : sourceFiles

      if (relevantFiles.length === 0) {
        validation.errors.push(`No matching files found for: '${rule.source}'`)
        continue
      }

      // Resolve computer IDs for this rule
      const computerIds = resolveComputerIds(rule.computers, config)
      if (computerIds.length === 0) {
        validation.errors.push(
          `No target computers specified for: '${rule.source}'`
        )
        continue
      }

      const missingIds = computerIds.filter(
        (id) => !computers.some((c) => c.id === id)
      )
      validation.missingComputerIds.push(...missingIds)

      // Create resolved file entries
      for (const sourcePath of relevantFiles) {
        validation.resolvedFileRules.push({
          sourceAbsolutePath: normalizePath(sourcePath),
          sourceRelativePath: normalizePath(
            path.relative(path.dirname(sourcePath), sourcePath)
          ),
          targetPath: normalizePath(rule.target),
          computers: computerIds,
        })
      }

      // Track target computers
      const matchingComputers = computers.filter((c) =>
        computerIds.includes(c.id)
      )
      validation.availableComputers.push(...matchingComputers)
    } catch (err) {
      // Handle the main errors glob can throw
      if (isNodeError(err)) {
        switch (err.code) {
          case "ENOENT":
            validation.errors.push(
              `Source directory not found: ${config.sourceRoot}`
            )
            break
          case "EACCES":
            validation.errors.push(
              `Permission denied reading source directory: ${config.sourceRoot}`
            )
            break
          case "EMFILE":
            validation.errors.push(
              "Too many open files. Try reducing the number of glob patterns."
            )
            break
          default:
            validation.errors.push(
              `Error processing '${rule.source}': ${err.message}`
            )
        }
      } else {
        // Handle glob pattern/config errors
        validation.errors.push(
          `Invalid pattern '${rule.source}': ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  // Deduplicate target computers
  validation.availableComputers = [...new Set(validation.availableComputers)]

  return validation
}

/**
 * Copies files to a specific computer
 */
export async function copyFilesToComputer(
  resolvedFiles: ResolvedFileRule[],
  computerPath: string
) {
  const copiedFiles = []
  const skippedFiles = []
  const errors = []

  // Normalize the computer path
  const normalizedComputerPath = normalizePath(computerPath)

  for (const file of resolvedFiles) {
    // Normalize source and target paths
    const normalizedSource = normalizePath(file.sourcePath)
    const normalizedTarget = normalizePath(file.targetPath.replace(/^\//, ""))

    // Determine if target is a directory:
    const isTargetDirectory = !pathIsLikelyFile(normalizedTarget)

    // For directory targets, use source filename, otherwise use target filename
    const targetFileName = isTargetDirectory
      ? path.basename(normalizedSource)
      : path.basename(normalizedTarget)

    // Get the target directory path
    const targetDirPath = normalizePath(
      isTargetDirectory
        ? path.join(computerPath, normalizedTarget)
        : path.join(computerPath, path.dirname(normalizedTarget))
    )

    // Construct and normalize the full target path
    const targetFilePath = normalizePath(
      path.join(targetDirPath, targetFileName)
    )

    // Security check: Ensure the target path stays within the computer directory
    const relativeToComputer = path.relative(
      normalizedComputerPath,
      targetFilePath
    )

    if (
      normalizePath(relativeToComputer).startsWith("..") ||
      path.isAbsolute(relativeToComputer)
    ) {
      skippedFiles.push(file.sourceAbsolutePath)
      errors.push(
        `Security violation: Target path '${file.targetPath}' attempts to write outside the computer directory`
      )
      continue
    }

    // First ensure source file exists and is a file
    const sourceStats = await fs.stat(toSystemPath(file.sourceAbsolutePath)) // use systemm-specific path here
    if (!sourceStats.isFile()) {
      skippedFiles.push(file.sourceAbsolutePath)
      errors.push(`Source is not a file: ${file.sourceAbsolutePath}`)
      continue
    }

    // Check if target directory exists and is actually a directory
    try {
      const targetDirStats = await fs.stat(toSystemPath(targetDirPath))
      if (!targetDirStats.isDirectory()) {
        skippedFiles.push(file.sourceAbsolutePath)
        errors.push(
          `Cannot create directory '${path.basename(targetDirPath)}' because a file with that name already exists`
        )
        continue
      }
    } catch (err) {
      // Directory doesn't exist, create it
      try {
        await fs.mkdir(toSystemPath(targetDirPath), { recursive: true })
      } catch (mkdirErr) {
        skippedFiles.push(file.sourceAbsolutePath)
        errors.push(`Failed to create directory: ${mkdirErr}`)
        continue
      }
    }

    try {
      // Copy the file using system-specific paths for fs operations
      await fs.copyFile(
        toSystemPath(file.sourceAbsolutePath),
        toSystemPath(targetFilePath)
      )

      // Verify the copy
      const targetStats = await fs.stat(toSystemPath(targetFilePath))
      if (!targetStats.isFile()) {
        throw new Error(`Failed to create target file: ${targetFilePath}`)
      } else {
        copiedFiles.push(file.sourceAbsolutePath)
      }
    } catch (err) {
      skippedFiles.push(file.sourceAbsolutePath)

      if (isNodeError(err)) {
        if (err.code === "ENOENT") {
          errors.push(`Source file not found: ${file.sourceAbsolutePath}`)
        } else if (err.code === "EACCES") {
          errors.push(`Permission denied: ${err.message}`)
        } else if (err.code === "EISDIR") {
          errors.push(`Cannot copy to '${targetFilePath}': Is a directory`)
        } else if (err.code === "EBUSY") {
          errors.push(`File is locked or in use: ${targetFilePath}`)
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
