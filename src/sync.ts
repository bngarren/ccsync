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
