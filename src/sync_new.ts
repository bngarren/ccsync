import { watch } from "chokidar";
import path from "node:path";
import type { Config } from "./config";
import { createLogger, type Logger } from "./log";
import type { Computer, SyncValidation } from "./types";
import {
  validateSaveDir,
  discoverComputers,
  validateFileSync,
  getFormattedDate,
  copyFilesToComputer,
} from "./utils";
import { theme } from "./theme";
import * as p from "@clack/prompts";
import { KeyHandler } from "./keys";
import EventEmitter from "node:events";
import { setTimeout } from "node:timers/promises";

interface SyncResult {
  successCount: number;
  errorCount: number;
  missingCount: number;
}

export class SyncManager {
  private log: Logger;
  private activeLoop: ManualSyncLoop | WatchSyncLoop | null = null;
  private lastValidation: Readonly<{
    validation: Readonly<SyncValidation>;
    computers: ReadonlyArray<Computer>;
    timestamp: number;
  }> | null = null;

  constructor(private config: Config) {
    this.log = createLogger({ verbose: config.advanced.verbose });
  }

  // Cache management
  private isCacheValid(): boolean {
    if (!this.lastValidation?.timestamp) return false;
    if (this.activeLoop instanceof WatchSyncLoop) return false;

    const timeSinceLastValidation = Date.now() - this.lastValidation.timestamp;
    this.log.verbose(
      `Time since last validation: ${timeSinceLastValidation}ms`
    );
    const isValid = timeSinceLastValidation < this.config.advanced.cache_ttl;
    this.log.verbose(`Cache valid? ${isValid}`);

    return isValid;
  }

  public invalidateCache(): void {
    this.lastValidation = null;
  }

  isRunning(): boolean {
    return this.activeLoop !== null;
  }

  // Core validation and sync methods
  public async runValidation(forceRefresh = false): Promise<SyncValidation> {
    if (!forceRefresh && this.isCacheValid()) {
      if (this.lastValidation?.validation) {
        this.log.verbose("Using cached validation results");
        return this.lastValidation.validation;
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
      this.log.error("No computers found in the save directory.");
      this.log.info(
        "Sometimes a computer placed in the world isn't fully loaded until its file system is modified. Try adding a dummy file and then re-run CC:Sync."
      );
      throw new Error("No computers found in the save directory");
    }

    // Get changed files from watch loop if applicable
    const changedFiles =
      this.activeLoop instanceof WatchSyncLoop
        ? this.activeLoop.getChangedFiles()
        : undefined;

    try {
      const validation = await validateFileSync(
        this.config,
        computers,
        changedFiles
      );

      if (validation.errors.length > 0) {
        this.log.error(`Could not continue due to the following errors:`);
        validation.errors.forEach((error) =>
          this.log.error(`${validation.errors.length > 1 ? "• " : ""}${error}`)
        );
        throw new Error("File sync validation failed");
      }

      // Cache validation results
      this.lastValidation = {
        validation,
        computers,
        timestamp: Date.now(),
      };
      return validation;
    } catch (err) {
      this.lastValidation = null;
      throw err;
    }
  }

  public async performSync(validation: SyncValidation): Promise<SyncResult> {
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

    // Initialize results map for each file
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

    // In watch mode, clear changed files after sync
    if (this.activeLoop instanceof WatchSyncLoop) {
      this.invalidateCache();
    }

    return result;
  }

  // Loop management
  async startManualMode(): Promise<ManualSyncLoop> {
    if (this.activeLoop) {
      throw new Error("A sync loop is already running");
    }

    const manualLoop = new ManualSyncLoop(this, this.log);
    this.activeLoop = manualLoop;
    // Start the loop but don't await it
    manualLoop.start();
    return manualLoop;
  }

  async startWatchMode(): Promise<WatchSyncLoop> {
    if (this.activeLoop) {
      throw new Error("A sync loop is already running");
    }

    const watchLoop = new WatchSyncLoop(this, this.config, this.log);
    this.activeLoop = watchLoop;
    // Start the loop but don't await it
    watchLoop.start();
    return watchLoop;
  }

  async stop(): Promise<void> {
    if (this.activeLoop) {
      await this.activeLoop.stop();
      this.activeLoop = null;
    }
  }
}

class ManualSyncLoop extends EventEmitter {
  private isRunning = false;
  private keyHandler: KeyHandler | null = null;

  constructor(private syncManager: SyncManager, private log: Logger) {
    super();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Manual sync loop is already running");
    }

    this.isRunning = true;
    this.log.status(`CC: Sync manual mode started at ${getFormattedDate()}`);

    try {
      while (this.isRunning) {
        await this.performSyncCycle();

        if (!this.isRunning) break;

        console.log(
          theme.gray("\n\n  [Press SPACE to re-sync or ESC to exit...] ")
        );
        await this.waitForUserInput();
      }
    } catch (err) {
      this.log.error(`Sync error: ${err}`);
    } finally {
      await this.cleanup();
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.cleanup();
    this.emit("stopped");
  }

  private async performSyncCycle(): Promise<void> {
    try {
      const validation = await this.syncManager.runValidation();
      const { successCount, errorCount, missingCount } =
        await this.syncManager.performSync(validation);

      const fDate = theme.gray(`@ ${getFormattedDate()}`);
      const totalFails = errorCount + missingCount;

      if (totalFails === 0) {
        this.log.success(`Successful sync. ${fDate}`);
      } else if (
        totalFails ===
        validation.targetComputers.length + validation.missingComputerIds.length
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

      this.emit("syncComplete", { successCount, errorCount, missingCount });
    } catch (err) {
      this.log.error(`Sync cycle failed: ${err}`);
      this.emit("syncError", err);
      throw err;
    }
  }

  private waitForUserInput(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setupKeyHandler(resolve);
    });
  }

  private setupKeyHandler(continueCallback: () => void): void {
    if (this.keyHandler) {
      this.keyHandler.stop();
    }

    this.keyHandler = new KeyHandler({
      onSpace: async () => {
        if (!this.isRunning) return;
        continueCallback();
      },
      onEsc: async () => {
        await this.stop();
        continueCallback();
      },
      onCtrlC: async () => {
        await this.stop();
        continueCallback();
        p.outro("CC:Sync program terminated.");
        process.exit(0);
      },
    });

    this.keyHandler.start();
  }

  private async cleanup(): Promise<void> {
    if (this.keyHandler) {
      this.keyHandler.stop();
      this.keyHandler = null;
    }
  }
}

class WatchSyncLoop extends EventEmitter {
  private isRunning = false;
  private watcher: ReturnType<typeof watch> | null = null;
  private keyHandler: KeyHandler | null = null;
  private changedFiles: Set<string> = new Set();
  private isInitialSync = true;

  constructor(
    private syncManager: SyncManager,
    private config: Config,
    private log: Logger
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Watch sync loop is already running");
    }

    this.isRunning = true;

    try {
      await this.performInitialSync();

      if (!this.isRunning) return;

      this.setupKeyHandler();
      await this.setupWatcher();

      this.emit("started");

      // Keep running until stopped
      while (this.isRunning) {
        await new Promise((resolve) => setTimeout(100, resolve));
      }
    } catch (err) {
      this.log.error(`Watch mode error: ${err}`);
      this.emit("error", err);
    } finally {
      await this.cleanup();
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.cleanup();
    this.emit("stopped");
  }

  getChangedFiles(): Set<string> | undefined {
    return this.isInitialSync ? undefined : this.changedFiles;
  }

  private async performInitialSync(): Promise<void> {
    try {
      const validation = await this.syncManager.runValidation(true);
      const { successCount, errorCount, missingCount } =
        await this.syncManager.performSync(validation);

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

      this.isInitialSync = false;
      this.emit("initialSyncComplete", {
        successCount,
        errorCount,
        missingCount,
      });
    } catch (err) {
      this.emit("initialSyncError", err);
      throw err;
    }
  }

  private setupKeyHandler(): void {
    if (this.keyHandler) {
      this.keyHandler.stop();
    }

    this.keyHandler = new KeyHandler({
      onEsc: async () => {
        await this.stop();
        p.outro("CC: Sync watch mode stopped.");
        process.exit(0);
      },
      onCtrlC: async () => {
        await this.stop();
        p.outro("CC: Sync program terminated.");
        process.exit(0);
      },
    });

    this.keyHandler.start();
  }

  private async setupWatcher(): Promise<void> {
    const patterns = this.config.files.map((f) =>
      path.join(this.config.sourcePath, f.source)
    );

    this.watcher = watch(patterns, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on("change", async (changedPath) => {
      if (!this.isRunning) return;

      const relativePath = path.relative(this.config.sourcePath, changedPath);
      this.changedFiles.add(relativePath);

      this.syncManager.invalidateCache();
      this.log.status(`\nFile changed: ${changedPath}`);

      try {
        const validation = await this.syncManager.runValidation(true);
        const { successCount, errorCount, missingCount } =
          await this.syncManager.performSync(validation);

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
        this.emit("fileSync", {
          path: changedPath,
          successCount,
          errorCount,
          missingCount,
        });

        // Clear changed files after successful sync
        this.changedFiles.clear();
      } catch (err) {
        this.log.verbose(`Sync failed: ${err}`);
        this.emit("fileSyncError", { path: changedPath, error: err });
        this.logWatchStatus();
      }
    });

    this.watcher.on("error", (error) => {
      this.log.error(`Watch error: ${error}`);
      this.emit("watcherError", error);
      this.logWatchStatus();
    });

    this.logWatchStatus();
  }

  private logWatchStatus(): void {
    if (!this.isRunning) return;
    this.log.info("\nWatching for file changes...");
    this.log.info("Press ESC to exit...");
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
        this.log.error(`Error closing watcher: ${err}`);
      }
      this.watcher = null;
    }

    this.changedFiles.clear();
  }
}
