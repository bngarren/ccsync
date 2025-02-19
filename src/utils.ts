import { homedir } from "os";
import * as fs from "node:fs/promises";
import path from "path";
import type { Config } from "./config";
import { glob } from "glob";
import type {
  Computer,
  FileSyncRule,
  ResolvedFile,
  SyncValidation,
} from "./types";

export const pluralize = (text: string) => {
  return (count: number) => {
    const isPlural = Math.abs(count) !== 1;
    return isPlural ? `${text}s` : text;
  };
};

export function resolvePath(filePath: string): string {
  // Handle home directory expansion
  if (filePath.startsWith("~")) {
    return path.join(homedir(), filePath.slice(1));
  }
  return path.resolve(filePath);
}

export const toTildePath = (fullPath: string): string => {
  const home = homedir();
  return fullPath.startsWith(home) ? fullPath.replace(home, "~") : fullPath;
};

export const getFormattedDate = (): string => {
  const now = new Date();
  const time = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = now.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
  return `${time} on ${date}`;
};

// - - - - - MINECRAFT - - - - -

interface SaveValidationResult {
  isValid: boolean;
  savePath: string;
  errors: string[];
  missingFiles: string[];
}

export const validateSaveDir = async (
  saveDir: string
): Promise<SaveValidationResult> => {
  const savePath = resolvePath(saveDir);
  const result: SaveValidationResult = {
    isValid: false,
    savePath,
    errors: [],
    missingFiles: [],
  };

  // Key files that should exist in a valid Minecraft save
  const keyFiles = [
    "level.dat",
    "session.lock",
    "region",
    "computercraft/computer", // Required for ComputerCraft
  ];

  try {
    // First check if the directory exists
    try {
      await fs.access(savePath);
    } catch (err) {
      result.errors.push(`Save directory not found: ${savePath}`);
      return result;
    }

    // Check each key file/directory
    await Promise.all(
      keyFiles.map(async (kf) => {
        try {
          await fs.access(path.join(savePath, kf));
        } catch (err) {
          result.missingFiles.push(kf);
        }
      })
    );

    // If we have any missing files, add an error
    if (result.missingFiles.length > 0) {
      result.errors.push(
        `The folder at ${savePath} doesn't appear to be a Minecraft save.`
      );
    }

    // Specific check for computercraft directory
    if (!result.missingFiles.includes("computercraft/computer")) {
      try {
        const computercraftStats = await fs.stat(
          path.join(savePath, "computercraft/computer")
        );
        if (!computercraftStats.isDirectory()) {
          result.errors.push("computercraft/computer is not a directory");
        }
      } catch (err) {
        result.errors.push("Failed to check computercraft directory structure");
      }
    }

    // Set isValid if we have no errors
    result.isValid = result.errors.length === 0;

    return result;
  } catch (err) {
    result.errors.push(
      `Validation failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return result;
  }
};

// - - - - - COMPUTERS - - - - -

const EXCLUDED_DIRS = new Set([".vscode", ".git", ".DS_Store"]);

export const getComputerShortPath = (saveName: string, computerId: string) => {
  return path
    .join(saveName, "computercraft", "computer", computerId)
    .replace("computercraft", "..");
};

export const discoverComputers = async (savePath: string) => {
  try {
    // Build path to computercraft directory
    const computercraftPath = path.join(savePath, "computercraft", "computer");

    // Check if directory exists
    try {
      await fs.access(computercraftPath);
    } catch (err) {
      throw new Error(
        `ComputerCraft directory not found at ${computercraftPath}`
      );
    }

    // Get the save name from the path
    const savePathParts = computercraftPath.split(path.sep);
    const saveIndex = savePathParts.findIndex((part) => part === "saves");
    const saveName = saveIndex !== -1 ? savePathParts[saveIndex + 1] : "";

    // Read all subdirectories
    const entries = await fs.readdir(computercraftPath, {
      withFileTypes: true,
    });
    const computers: Computer[] = [];

    for (const entry of entries) {
      // Skip if it's not a directory or if it's in the excluded list
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      const computerPath = path.join(computercraftPath, entry.name);
      const shortPath = getComputerShortPath(saveName, entry.name);

      computers.push({
        id: entry.name,
        path: computerPath,
        shortPath,
      });
    }

    return computers.sort((a, b) => {
      // Sort numerically if both IDs are numbers
      const numA = parseInt(a.id);
      const numB = parseInt(b.id);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      // Otherwise sort alphabetically
      return a.id.localeCompare(b.id);
    });
  } catch (err) {
    throw new Error(`Failed to discover computers: ${err}`);
  }
};

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
  if (!computers) return [];

  const computersList = Array.isArray(computers) ? computers : [computers];

  let invalidGroups: string[] = [];
  const resolvedIds = computersList.flatMap((entry) => {
    const group = config.computerGroups?.[entry]
    if (group) {
      return group.computers;
    }
    // If not a group, it should be a computer ID
    return [entry];
  });

  // Verify all groups existed
  computersList.forEach((entry) => {
    if (!config.computerGroups?.[entry] && !entry.match(/^\d+$/)) {
      invalidGroups.push(entry);
    }
  });

  if (invalidGroups.length > 0) {
    throw new Error(`invalid computer groups → "${invalidGroups.join(", ")}"`);
  }

  return resolvedIds;
}

/**
 * Resolves file sync rules into actual files and validates the configuration
 */
export async function validateFileSync(
  config: Config,
  computers: Computer[],
  changedFiles?: Set<string>
): Promise<SyncValidation> {
  const validation: SyncValidation = {
    resolvedFiles: [],
    targetComputers: [],
    missingComputerIds: [],
    errors: [],
  };

  // Process each sync rule
  for (const rule of config.files) {
    try {
      // Find all matching source files
      const sourceFiles = await glob(rule.source, {
        cwd: config.sourcePath,
        absolute: true,
      });

      // Filter by changed files if in watch mode
      const relevantFiles = changedFiles
        ? sourceFiles.filter((file) =>
            changedFiles.has(path.relative(config.sourcePath, file))
          )
        : sourceFiles;

      if (relevantFiles.length === 0) {
        validation.errors.push(`No matching files found for: '${rule.source}'`);
        continue;
      }

      // Resolve computer IDs for this rule
      const computerIds = resolveComputerIds(rule.computers, config);
      if (computerIds.length === 0) {
        validation.errors.push(
          `No target computers specified for: '${rule.source}'`
        );
        continue;
      }

      const missingIds = computerIds.filter(id => 
        !computers.some(c => c.id === id)
      );
      validation.missingComputerIds.push(...missingIds);
    

      // Create resolved file entries
      for (const sourcePath of relevantFiles) {
        validation.resolvedFiles.push({
          sourcePath,
          targetPath: rule.target,
          computers: computerIds,
        });
      }

      // Track target computers
      const matchingComputers = computers.filter((c) =>
        computerIds.includes(c.id)
      );
      validation.targetComputers.push(...matchingComputers);
    } catch (err) {
      validation.errors.push(
        `Error processing config file sync rule for '${rule.source}'\n ⮑  ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Deduplicate target computers
  validation.targetComputers = [...new Set(validation.targetComputers)];

  return validation;
}

/**
 * Copies files to a specific computer
 */
export async function copyFilesToComputer(
  resolvedFiles: ResolvedFile[],
  computerPath: string
): Promise<void> {
  // Normalize the computer path
  const normalizedComputerPath = path.normalize(computerPath);

  for (const file of resolvedFiles) {
    // For directory targets, use source filename
    const targetFileName = file.targetPath.endsWith('/')
      ? path.basename(file.sourcePath)
      : path.basename(file.targetPath);

    // Handle both absolute and relative paths by removing leading slash
    // This makes paths like "/lib" or "/startup.lua" relative to the computer root
    const relativePath = file.targetPath.replace(/^\//, '');

    // Get the target directory path
    const targetDirPath = relativePath.endsWith('/')
      ? path.join(computerPath, relativePath.slice(0, -1))
      : path.join(computerPath, path.dirname(relativePath));

    // Construct and normalize the full target path
    const targetFilePath = path.normalize(path.join(targetDirPath, targetFileName));

    // Security check: Ensure the target path stays within the computer directory
    const relativeToComputer = path.relative(normalizedComputerPath, targetFilePath);
    if (relativeToComputer.startsWith('..') || path.isAbsolute(relativeToComputer)) {
      throw new Error(
        `Security violation: Target path '${file.targetPath}' attempts to write outside the computer directory`
      );
    }

    // First ensure source file exists and is a file
    const sourceStats = await fs.stat(file.sourcePath);
    if (!sourceStats.isFile()) {
      throw new Error(`Source is not a file: ${file.sourcePath}`);
    }

    // Create target directory
    await fs.mkdir(targetDirPath, { recursive: true });

    // Copy the file
    await fs.copyFile(file.sourcePath, targetFilePath);

    // Verify the copy
    const targetStats = await fs.stat(targetFilePath);
    if (!targetStats.isFile()) {
      throw new Error(`Failed to create target file: ${targetFilePath}`);
    }
  }
}
