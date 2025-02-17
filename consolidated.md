## src/utils.ts

```ts
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
    const group = config.computerGroups[entry];
    if (group) {
      return group.computers;
    }
    // If not a group, it should be a computer ID
    return [entry];
  });

  // Verify all groups existed
  computersList.forEach((entry) => {
    if (!config.computerGroups[entry] && !entry.match(/^\d+$/)) {
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
        `Error processing config for '${rule.source}'\n ⮑  ${
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
 * Copies resolved files to a specific computer
 */
export async function copyFilesToComputer(
  resolvedFiles: ResolvedFile[],
  computerPath: string
): Promise<void> {
  for (const file of resolvedFiles) {
    // Determine target path
    const targetPath = path.join(computerPath, file.targetPath);

    // Create target directory if it doesn't exist
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Copy the file
    await fs.copyFile(file.sourcePath, targetPath);
  }
}
```


## src/types.ts

```ts

export enum SyncMode {
    MANUAL = "manual",
    WATCH = "watch"
} 

// Base interface for file sync configuration in .ccsync.yaml
export interface FileSyncRule {
  source: string; // Glob pattern relative to sourcePath
  target: string; // Target path on computer
  computers?: string[]; // Array of computer IDs or group names
}

// Represents a resolved file that matches a sync rule
export interface ResolvedFile {
  sourcePath: string; // Absolute path to source file
  targetPath: string; // Relative path on computer
  computers: string[]; // Resolved list of computer IDs (not group names)
}

// Represents a computer in the Minecraft save
export interface Computer {
  id: string;
  path: string;
  shortPath: string;
}

// New validation result type
export interface SyncValidation {
  resolvedFiles: ResolvedFile[];
  targetComputers: Computer[];
  missingComputerIds: string[];
  errors: string[];
}
```


## src/keys.ts

```ts
type KeyCallback = () => void | Promise<void>;

interface KeyHandlerOptions {
  onEsc?: KeyCallback;
  onSpace?: KeyCallback;
  onCtrlC?: KeyCallback;
}

export class KeyHandler {
  private isActive = false;
  private keyCallbacks: KeyHandlerOptions;
  private currentHandler: ((data: Buffer) => void) | null = null;
  private keepAliveInterval: Timer | null = null;

  constructor(options: KeyHandlerOptions = {}) {
    this.keyCallbacks = options;

    // Default Ctrl+C handler if none provided
    if (!this.keyCallbacks.onCtrlC) {
      this.keyCallbacks.onCtrlC = () => {
        console.log("Terminated");
        process.exit(0);
      };
    }
  }

  start() {
    if (this.isActive) return;

    try {
      this.isActive = true;
      
      // Ensure clean state
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      
      // Setup stdin
      process.stdin.setEncoding("utf8");
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      // Bind the handler
      this.currentHandler = this.handleKeypress.bind(this);
      process.stdin.removeAllListeners('data');  // Remove any existing listeners
      process.stdin.on("data", this.currentHandler);

      // Keep-alive interval
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
      }
      this.keepAliveInterval = setInterval(() => {
        if (this.isActive && process.stdin.isTTY) {
          process.stdin.resume();
          process.stdin.setRawMode(true);
        } else {
          this.stop();
        }
      }, 100);
    } catch (err) {
      console.error('Error starting key handler:', err);
      this.stop();
    }
  }

  stop() {
    if (!this.isActive) return;

    try {
      this.isActive = false;

      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
        this.keepAliveInterval = null;
      }

      if (this.currentHandler) {
        process.stdin.removeListener("data", this.currentHandler);
        this.currentHandler = null;
      }

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();

    } catch (err) {
      console.error('Error stopping key handler:', err);
    }
  }

  private async handleKeypress(data: Buffer) {
    if (!this.isActive) return;

    const key = data.toString();

    // Handle Ctrl+C (End of Text character)
    if (key === "\u0003" && this.keyCallbacks.onCtrlC) {
      await this.keyCallbacks.onCtrlC();
      return;
    }

    // Handle ESC
    if (key === "\u001b" && this.keyCallbacks.onEsc) {
      await this.keyCallbacks.onEsc();
      return;
    }

    // Handle Space
    if (key === " " && this.keyCallbacks.onSpace) {
      await this.keyCallbacks.onSpace();
      return;
    }
  }

  isListening() {
    return this.isActive;
  }
}
```


## src/log.ts

```ts
import * as p from "@clack/prompts";
import { theme } from "./theme";

interface LogConfig {
  verbose?: boolean;
}

export interface Logger {
  verbose: (msg: string) => void;
  info: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  status: (msg: string) => void;
}

export const createLogger = (config?: LogConfig): Logger => ({
  verbose: (msg: string) => {
    if (config?.verbose) {
      p.log.info(theme.dim(msg));
    }
  },
  info: (msg: string) => p.log.info(theme.info(msg)),
  success: (msg: string) => p.log.success(theme.success(`${msg}`)),
  warn: (msg: string) => p.log.warn(theme.warn(`${msg}`)),
  error: (msg: string) => p.log.error(theme.error(`${msg}`)),
  status: (msg: string) => p.log.info(theme.accent(msg)),
});
```


## src/index.ts

```ts
// index.ts

import * as p from "@clack/prompts";
import { createDefaultConfig, findConfig, loadConfig } from "./config";
import color from "picocolors";
import path from "path";
import { SyncManager } from "./sync";
import { createLogger } from "./log";
import { theme } from "./theme";
import { toTildePath } from "./utils";
import type { SyncMode } from "./types";

const initConfig = async () => {
  // Find all config files
  const configs = await findConfig();

  let configPath: string;

  if (configs.length === 0) {
    const createDefault = await p.confirm({
      message: "No configuration file found. Create a default configuration?",
      initialValue: true,
    });

    if (!createDefault) {
      p.cancel("Cannot proceed without configuration.");
      process.exit(0);
    }

    await createDefaultConfig(process.cwd());
    p.log.success(`Created default config at ${process.cwd()}/.ccsync.yaml`);
    p.log.info("Please edit the configuration file and run the program again.");
    process.exit(0);
  } else if (configs.length === 1) {
    configPath = configs[0].path;
    p.log.info(`Using config: ${color.gray(configs[0].relativePath)}`);
  } else {
    // Multiple configs found - let user choose
    const selection = (await p.select({
      message: "Multiple config files found. Select one to use:",
      options: configs.map((config, index) => ({
        value: config.path,
        label: config.relativePath,
        hint: index === 0 ? "closest to current directory" : undefined,
      })),
    })) as string;

    if (!selection) {
      p.cancel("No config selected.");
      process.exit(0);
    }

    configPath = selection;
  }

  return await loadConfig(configPath);
};

async function main() {
  console.clear();

  p.intro(
    `${color.magentaBright(`CC:Sync (v${process.env.npm_package_version})`)}`
  );

  try {
    const config = await initConfig()
    // Init log
    const log = createLogger({verbose: config.advanced.verbose})
    const savePath = path.parse(config.minecraftSavePath);

    // ---- Confirm MC save location ----


    const res = await p.confirm({
      message: `Sync with ${theme.bold(theme.warn(savePath.name))}?  ${theme.dim(toTildePath(config.minecraftSavePath))}'`,
      initialValue: true,
    });

    if (p.isCancel(res) || !res) {
      log.info("If this save instance is incorrect, change the 'minecraftSavePath' in the .ccsync.yaml to point to the one you want.")
      log.status("Goodbye!");
      process.exit(0);
    }

    // Choose mode
    const mode: SyncMode = await p.select({
      message: "Select sync mode:",
      options: [
        { value: "manual", label: "Manual mode", hint: "Sync on command" },
        { value: "watch", label: "Watch mode", hint: "Auto-sync on file changes" },
      ],
    }) as SyncMode;

    if (p.isCancel(mode)) {
      log.status("Goodbye!");
      process.exit(0);
    }

    const syncManager = new SyncManager(config);

    if (mode === "watch") {
      await syncManager.startWatching();
    } else {
      await syncManager.manualMode();
    }
  } catch (err) {
    p.log.error(`${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(console.error);
```


## src/theme.ts

```ts
import color from "picocolors";

export const theme = {
  success: (s: string) => color.green(s),
  warn: (s: string) => color.yellow(s),
  error: (s: string) => color.red(s),
  info: (s: string) => color.cyan(s),
  accent: (s: string) => color.magentaBright(s),
  dim: (s: string) => color.dim(s),
  bold: (s: string) => color.bold(s),
  gray: (s: string) => color.gray(s)
};
```


## src/config.ts

```ts
// config.ts

import { z, ZodError } from "zod";
import { parse } from "yaml";
import { resolvePath } from "./utils";
import path from "path";
import * as fs from "node:fs/promises";
import { merge } from "ts-deepmerge";

const DEFAULT_CONFIG_FILENAME = ".ccsync.yaml";

const DEFAULT_CONFIG: Config = {
  sourcePath: "./src",
  minecraftSavePath: "~/minecraft/saves/world",
  computerGroups: {},
  files: [],
  advanced: {
    verbose: false,
    cache_ttl: 5000,
  },
};

// ---- SCHEMA & TYPES ----

// Computer ID validation
const ComputerIdSchema = z.union([
  z.string().regex(/^(?:0|[1-9]\d*)$/, "Computer ID must be a non-negative whole number (e.g. 0, 1, 42)"), 
  z.number()
    .int("Computer ID must be a whole number (no decimals)")
    .nonnegative("Computer ID must be zero or positive")
    .transform(n => n.toString()),
 ]);
 
 // Computer group schema
 const ComputerGroupSchema = z.object({
  name: z.string({
    required_error: "Group name is required",
    invalid_type_error: "Group name must be text"
  }),
  computers: z.array(ComputerIdSchema, {
    required_error: "Group must contain computer IDs",
    invalid_type_error: "Computers must be an array of IDs"
  }),
 });
 
 // File sync rule schema
 const FileSyncRuleSchema = z.object({
  source: z.string({
    required_error: "Source file path is required",
    invalid_type_error: "Source must be a file path"
  }),
  target: z.string({
    required_error: "Target file path is required", 
    invalid_type_error: "Target must be a file path"
  }),
  computers: z
    .union([
      z.array(z.union([ComputerIdSchema, z.string().min(1, "Group name cannot be empty")])),
      ComputerIdSchema,
      z.string().min(1, "Group name cannot be empty")
    ])
    .optional()
    .describe("Computer IDs or group names to sync files to"),
 });
 
 const AdvancedOptionsSchema = z.object({
  verbose: z.boolean({
    invalid_type_error: "Verbose must be true or false"
  }).default(false),
  cache_ttl: z.number({
    invalid_type_error: "Cache TTL must be a number"
  }).min(0, "Cache TTL cannot be negative").default(5000),
 });
 
 export const ConfigSchema = z.object({
  sourcePath: z.string({
    required_error: "Source path is required",
    invalid_type_error: "Source path must be text"
  }),
  minecraftSavePath: z.string({
    required_error: "Minecraft save path is required", 
    invalid_type_error: "Save path must be text"
  }),
  computerGroups: z.record(z.string(), ComputerGroupSchema),
  files: z.array(FileSyncRuleSchema),
  advanced: AdvancedOptionsSchema.default({
    verbose: false,
    cache_ttl: 5000,
  }),
 });

export type Config = z.infer<typeof ConfigSchema>;
export type ComputerGroup = z.infer<typeof ComputerGroupSchema>;
export type FileSyncRule = z.infer<typeof FileSyncRuleSchema>;

// ---- CONFIG METHODS ----

export const withDefaultConfig = (config: Partial<Config>) => {
  return merge.withOptions(
    { mergeArrays: false },
    DEFAULT_CONFIG,
    config
  ) as Config;
};

export const findConfig = async (
  startDir: string = process.cwd()
): Promise<Array<{ path: string; relativePath: string }>> => {
  const configs: Array<{ path: string; relativePath: string }> = [];
  let currentDir = startDir;

  while (currentDir !== path.parse(currentDir).root) {
    const configPath = path.join(currentDir, DEFAULT_CONFIG_FILENAME);
    try {
      await fs.access(configPath);
      configs.push({
        path: configPath,
        relativePath: path.relative(startDir, configPath),
      });
    } catch {
      // Continue searching even if this path doesn't exist
    }
    currentDir = path.dirname(currentDir);
  }

  return configs;
};

export async function loadConfig(configFilePath: string): Promise<Config> {
  try {
    const resolvedPath = resolvePath(configFilePath);
    const file = await Bun.file(resolvedPath).text();
    const config = parse(file);
    const validatedConfig = ConfigSchema.parse(config);
    // Resolve all paths in the config
    return {
      ...validatedConfig,
      sourcePath: resolvePath(validatedConfig.sourcePath),
      minecraftSavePath: resolvePath(validatedConfig.minecraftSavePath),
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const errMsg = error.format()
      throw new Error(`Failed to load config. Ensure that syntax is correct.\n${JSON.stringify(error.flatten().fieldErrors)}`);
    } else {
      throw new Error('Faild to load config. Ensure that syntax is correct.')
    }
  }
}

export const createDefaultConfig = async (projectDir: string) => {
  const configPath = path.join(projectDir, DEFAULT_CONFIG_FILENAME);
  const configContent = `# CC:Sync Configuration File
# This file configures how CC:Sync copies files to your ComputerCraft computers

# Where your source files are located (relative to this config file)
sourcePath: "${DEFAULT_CONFIG.sourcePath}"

# Path to your Minecraft world save
# Use ~ for your home directory
# Example Windows: "~/AppData/Roaming/.minecraft/saves/my_world"
# Example Linux: "~/.minecraft/saves/my_world"
minecraftSavePath: "${DEFAULT_CONFIG.minecraftSavePath}"

# Define groups of computers for easier file targeting
computerGroups: {}
  # Example group:
  # monitors:
  #   name: "Monitor Network"
  #   computers: ["1", "2", "3"]

# Files to sync to your computers
files: []
  # Examples:
  # Sync to a specific computer:
  # - source: "startup.lua"    # File in your sourcePath
  #   target: "startup.lua"    # Where to put it on the computer
  #   computers: ["1"]         # Computer IDs to sync to
  #
  # Sync to a group of computers:
  # - source: "lib/*.lua"      # Glob patterns supported
  #   target: "lib/"          # Folders will be created
  #   computers: "monitors"    # Reference a computer group

# Advanced configuration options
advanced:
  # Enable verbose logging
  verbose: false
  
  # How long to cache validation results (milliseconds)
  # Lower = more accurate but more CPU intensive, Higher = faster but may miss changes
  cache_ttl: 5000
`;

  await fs.writeFile(configPath, configContent, "utf-8");
};
```


## src/sync.ts

```ts
// Sync

import * as p from "@clack/prompts";
import { watch } from "chokidar";
import color from "picocolors";
import type { Config } from "./config";
import {
  copyFilesToComputer,
  discoverComputers,
  getFormattedDate,
  pluralize,
  validateFileSync,
  validateSaveDir,
} from "./utils";
import { setTimeout } from "node:timers/promises";
import path from "path";
import { KeyHandler } from "./keys";
import type { Computer, SyncValidation } from "./types";
import { createLogger, type Logger } from "./log";
import { theme } from "./theme";

interface SyncResult {
  successCount: number;
  errorCount: number;
  missingCount: number;
}

export class SyncManager {
  private config: Config;
  private watcher: ReturnType<typeof watch> | null = null;
  private isWatching = false;
  private keyHandler: KeyHandler | null = null;
  private changedFiles: Set<string> = new Set();
  private lastValidation: Readonly<{
    validation: Readonly<SyncValidation>;
    computers: ReadonlyArray<Computer>;
    timestamp: number;
  }> | null = null;
  private isInitialWatchSync = true;
  private log: Logger;

  constructor(config: Config) {
    this.config = config;
    // Init log
    this.log = createLogger({ verbose: config.advanced.verbose });
  }

  /**
   * Determines if the cached validation is still valid
   */
  private isCacheValid(): boolean {
    if (!this.lastValidation?.timestamp) return false;
    if (this.isWatching) return false;

    // Cache expires after 5 seconds in manual mode
    const timeSinceLastValidation = Date.now() - this.lastValidation.timestamp;
    this.log.verbose(
      `Time since last validation: ${timeSinceLastValidation}ms`
    );
    const isValid = timeSinceLastValidation < this.config.advanced.cache_ttl;
    this.log.verbose(`Cache valid? ${isValid}`);

    return isValid;
  }

  /**
   * Forces cache invalidation in specific scenarios
   */
  private invalidateCache(): void {
    this.lastValidation = null;
  }

  /**
   * Validates sync setup and caches results for performSync
   */
  private async runValidation(forceRefresh = false): Promise<SyncValidation> {
    // Check if we can use cached validation
    if (!forceRefresh && this.isCacheValid()) {
      if (this.lastValidation?.validation) {
        this.log.verbose("Using cached validation results");
        return this.lastValidation?.validation;
      }
    }

    // Validate save directory
    const saveDirValidation = await validateSaveDir(
      this.config.minecraftSavePath
    );
    if (!saveDirValidation.isValid) {
      this.log.error("Oops!");
      this.log.verbose("Save directory validation failed");
      saveDirValidation.errors.forEach((error) => this.log.error(`• ${error}`));
      throw new Error("Invalid save directory");
    }

    // Discover computers
    const computers = await discoverComputers(this.config.minecraftSavePath);
    if (computers.length === 0) {
      this.log.error("Oops!");
      this.log.error("No computers found in the save directory.");
      this.log.info(
        "Sometimes a computer placed in the world isn't fully loaded until its file system is modified. Trying adding a dummy file and then re-run CC:Sync."
      );
      throw new Error("No computers found in the save directory");
    }

    // In watch mode, only use changedFiles if it's not the initial sync
    const changedFilesForValidation =
      this.isWatching && !this.isInitialWatchSync
        ? this.changedFiles
        : undefined;

    try {
      // Validate file sync configuration
      const validation = await validateFileSync(
        this.config,
        computers,
        changedFilesForValidation
      );

      if (validation.errors.length > 0) {
        const pl_error = pluralize("error")(validation.errors.length);
        this.log.error(`Could not continue due to the following ${pl_error}:`);

        validation.errors.forEach((error) =>
          this.log.error(`${validation.errors.length > 1 ? "• " : ""}${error}`)
        );
        throw new Error("File sync validation failed");
      }

      if (validation.resolvedFiles.length === 0) {
        this.log.error("Oops!");
        this.log.error("No files found to sync!");
        throw new Error("No files to sync!");
      }

      if (validation.targetComputers.length === 0) {
        this.log.error("Oops!");
        this.log.error("Could not find computers to sync files to!");
        throw new Error("No matching computers found to sync files to");
      }

      // Update cache with timestamp
      this.lastValidation = {
        validation,
        computers,
        timestamp: Date.now(),
      };
      return validation;
    } catch (err) {
      this.lastValidation = null; // Clear cache on any error
      throw err;
    }
  }

  /**
   * Performs file synchronization using cached validation results
   */
  private async performSync(validation: SyncValidation): Promise<SyncResult> {
    const spinner = p.spinner();
    const result: SyncResult = {
      successCount: 0,
      errorCount: 0,
      missingCount: 0,
    };
    const fileResults = new Map<
      string,
      Array<{ computerId: string; success: boolean }>
    >();

    // Initialize results map
    for (const file of validation.resolvedFiles) {
      const relativePath = path.relative(
        this.config.sourcePath,
        file.sourcePath
      );
      fileResults.set(relativePath, []);
    }

    // Process each computer
    for (const computer of validation.targetComputers) {
      spinner.start(`Copying files to computer ${computer.id}`);
      const computerFiles = validation.resolvedFiles.filter((file) =>
        file.computers.includes(computer.id)
      );

      if (computerFiles.length === 0) {
        spinner.stop("");
        continue;
      }

      try {
        await copyFilesToComputer(computerFiles, computer.path);
        await setTimeout(500);

        // Record successful copies
        computerFiles.forEach((file) => {
          const relativePath = path.relative(
            this.config.sourcePath,
            file.sourcePath
          );
          const results = fileResults.get(relativePath) ?? [];
          results.push({ computerId: computer.id, success: true });
          fileResults.set(relativePath, results);
        });
        result.successCount++;
      } catch (err) {
        // Record failed copies
        computerFiles.forEach((file) => {
          const relativePath = path.relative(
            this.config.sourcePath,
            file.sourcePath
          );
          const results = fileResults.get(relativePath) ?? [];
          results.push({ computerId: computer.id, success: false });
          fileResults.set(relativePath, results);
        });
        spinner.stop(
          `${theme.error("✗")} Error copying files to computer ${
            computer.id
          }: ${err}`
        );
        result.errorCount++;
      }
    }

    spinner.stop("Results:");

    // Display final status for each file
    for (const [filePath, results] of fileResults.entries()) {
      const file = validation.resolvedFiles.find(
        (f) => path.relative(this.config.sourcePath, f.sourcePath) === filePath
      );
      if (!file) continue;

      // Add missing computers as failed results
      file.computers.forEach((computerId) => {
        if (validation.missingComputerIds.some((mc) => mc === computerId)) {
          results.push({ computerId, success: false });
          result.missingCount++; // Track missing separately
        }
      });

      // Sort results by computer ID
      const sortedResults = results.sort((a, b) =>
        a.computerId.localeCompare(b.computerId)
      );

      const computerStatus = sortedResults
        .map(
          (r) =>
            `${r.computerId}${
              r.success ? theme.success("✓") : theme.error("✗")
            }`
        )
        .join(" ");

      this.log.info(
        `  ${theme.success("✓")} ${filePath} ${theme.dim(
          `→ ${file.targetPath}`
        )} ${theme.dim("[")}${computerStatus}${theme.dim("]")}`
      );
    }

    if (this.isWatching) {
      this.changedFiles.clear();
    }
    return result;
  }

  private async handleKeyPress(resolve: () => void): Promise<void> {
    this.keyHandler = new KeyHandler({
      onSpace: async () => {
        resolve();
        await this.cleanup();
      },
      onEsc: async () => {
        await this.cleanup();
        p.outro("CC:Sync manual mode stopped.");
        process.exit(0);
      },
      onCtrlC: async () => {
        await this.cleanup();
        p.outro("CC:Sync program terminated.");
        process.exit(0);
      },
    });

    this.keyHandler.start();
  }

  /**
   * Starts watch mode for automatic file syncing
   */
  async startWatching(): Promise<void> {
    if (this.isWatching) return;

    this.isWatching = true;

    // On first sync, we sync all tracked files.
    this.isInitialWatchSync = true;

    try {
      // Initial validation and sync
      const validation = await this.runValidation(true);
      const { successCount, errorCount, missingCount } = await this.performSync(
        validation
      );

      const totalFails = errorCount + missingCount;
      const fDate = theme.gray(`@ ${getFormattedDate()}`);

      if (totalFails === 0) {
        this.log.success(`Initial sync successful. ${fDate}`);
      } else if (
        totalFails ===
        validation.targetComputers.length + validation.missingComputerIds.length
      ) {
        this.log.error(`Initial sync failed. ${fDate}`);
      } else {
        this.log.warn(`Initial sync partial. ${fDate}`);
      }

      this.isInitialWatchSync = false; // Reset after initial sync

      // Setup file watching
      const patterns = this.config.files.map((f) =>
        path.join(this.config.sourcePath, f.source)
      );

      this.keyHandler = new KeyHandler({
        onEsc: async () => {
          await this.cleanup();
          p.outro("CC:Sync watch mode stopped.");
          process.exit(0);
        },
        onCtrlC: async () => {
          await this.cleanup();
          p.outro("CC:Sync program terminated.");
          process.exit(0);
        },
      });
      this.keyHandler.start();

      this.watcher = watch(patterns, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
      });

      this.watcher.on("change", async (changedPath) => {
        if (!this.isWatching) return;

        const relativePath = path.relative(this.config.sourcePath, changedPath);
        this.changedFiles.add(relativePath);

        this.invalidateCache(); // Invalidate cache when files change

        this.log.status(`\nFile changed: ${changedPath}`);

        try {
          const validation = await this.runValidation(true);
          const { successCount, errorCount, missingCount } =
            await this.performSync(validation);

          const totalFails = errorCount + missingCount;
          const fDate = theme.gray(`@ ${getFormattedDate()}`);

          if (totalFails === 0) {
            this.log.success(`Sync successful. ${fDate}`);
          } else if (
            totalFails ===
            validation.targetComputers.length +
              validation.missingComputerIds.length
          ) {
            this.log.error(`Sync failed. ${fDate}`);
          } else {
            this.log.warn(`Partial sync. ${fDate}`);
          }

          this.logWatchStatus();
        } catch (err) {
          this.log.verbose(`Sync failed: ${err}`);
          this.logWatchStatus();
        }
      });

      this.watcher.on("error", (error) => {
        p.log.error(`Watch error: ${error}`);
        this.logWatchStatus();
      });

      this.logWatchStatus();
    } catch (err) {
      await this.cleanup();
      throw err;
    }
  }

  private logWatchStatus(): void {
    if (!this.isWatching) return;
    p.log.info(color.cyan("\nWatching for file changes..."));
    p.log.info(color.cyanBright("Press ESC to exit..."));
  }

  /**
   * Starts manual mode for command-triggered syncing
   */
  async manualMode(): Promise<void> {
    this.log.status(`CC:Sync manual mode started at ${getFormattedDate()}`);

    while (true) {
      try {
        const validation = await this.runValidation();

        const fDate = theme.gray(`@ ${getFormattedDate()}`);

        const { successCount, errorCount, missingCount } =
          await this.performSync(validation);
        const totalFails = errorCount + missingCount;

        if (totalFails === 0) {
          this.log.success(`Successful sync. ${fDate}`);
        } else if (
          totalFails ===
          validation.targetComputers.length +
            validation.missingComputerIds.length
        ) {
          this.log.error(`Sync failed. ${fDate}`);
        } else {
          this.log.warn(`Partial sync. ${fDate}`);
        }

        this.log.verbose(
          `Sync completed with ${successCount}/${
            successCount + errorCount
          } computers updated.`
        );
        console.log(
          theme.gray("\n\n  [Press SPACE to re-sync or ESC to exit...] ")
        );

        await new Promise<void>((resolve) => this.handleKeyPress(resolve));
      } catch (err) {
        await this.cleanup();
        this.log.verbose(`Sync failed: ${err}`);
        break;
      }
    }
  }
  private async cleanup(): Promise<void> {
    if (this.keyHandler) {
      this.keyHandler.stop();
      this.keyHandler = null;
    }

    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (err) {
        p.log.error(`Error closing watcher: ${err}`);
      }
      this.watcher = null;
    }

    this.isWatching = false;
    this.isInitialWatchSync = true;
  }
}
```


