import { homedir } from "os";
import * as fs from "node:fs/promises";
import path from "path";
import type { Config } from "./config";
import { glob } from "glob";

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

const EXCLUDED_DIRS = new Set([".vscode", ".git", ".DS_Store"]);

export interface Computer {
  id: string;
  path: string;
  shortPath: string;
}

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
      const shortPath = path
        .join(saveName, "computercraft", "computer", entry.name)
        .replace("computercraft", "..");

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

export interface FileCheck {
  source: string;
  target: string;
  exists: boolean;
  computers?: string | string[];
}

export async function checkConfigTrackedFiles(
  config: Config
): Promise<FileCheck[]> {
  const results: FileCheck[] = [];

  for (const file of config.files) {
    try {
      // Use glob to find all matching source files
      const matches = await glob(file.source, {
        cwd: config.sourcePath,
        absolute: true,
      });

      // Check if any matches were found
      const exists = matches.length > 0;

      results.push({
        source: file.source,
        target: file.target,
        exists,
        computers: file.computers,
      });
    } catch (err) {
      results.push({
        source: file.source,
        target: file.target,
        exists: false,
        computers: file.computers,
      });
    }
  }

  return results;
}

export async function copyFilesToComputer(
  fileChecks: FileCheck[],
  config: Config,
  computerPath: string
): Promise<void> {
  for (const file of fileChecks) {
    if (!file.exists) continue;

    // Find all matching source files
    const sourceFiles = await glob(file.source, {
      cwd: config.sourcePath,
      absolute: true,
    });

    for (const sourcePath of sourceFiles) {
      // Determine target path
      const targetPath = path.join(computerPath, file.target);

      // Create target directory if it doesn't exist
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      // Copy the file
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}
