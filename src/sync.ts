// Sync

import * as p from "@clack/prompts";
import { watch } from "chokidar";
import color from "picocolors";
import type { Config } from "./config";
import {
  checkConfigTrackedFiles,
  copyFilesToComputer,
  discoverComputers,
  pluralize,
  validateSaveDir,
  type Computer,
  type FileCheck,
} from "./utils";
import { setTimeout } from "node:timers/promises";
import path from "path";
import { KeyHandler } from "./keys";

interface ValidatedSync {
  fileChecks: FileCheck[];
  matchedComputers: Computer[];
  requiredComputerIds: string[];
}

export class SyncManager {
  private config: Config;
  private watcher: ReturnType<typeof watch> | null = null;
  private isWatching = false;
  private keyHandler: KeyHandler | null = null;

  // language
  private pl_computer = pluralize("computer");

  constructor(config: Config) {
    this.config = config;
  }

  private async validateSync(): Promise<ValidatedSync> {
    // Validate save directory
    const saveDirValidation = await validateSaveDir(
      this.config.minecraftSavePath
    );
    if (!saveDirValidation.isValid) {
      p.log.error("Oops:");
      saveDirValidation.errors.forEach((error) => p.log.error(`• ${error}`));
      p.log.warn(
        "Ensure that the 'minecraftSavePath' in .ccsync.yaml points to a Minecraft world save folder."
      );
      throw new Error("Invalid save directory.");
    }

    // Check tracked files
    const fileChecks = await checkConfigTrackedFiles(this.config);

    if (fileChecks.length === 0) {
      throw new Error("Not tracking any files. Please edit the config.");
    }

    // Display file check results
    fileChecks.forEach((check) => {
      const status = check.exists ? color.green("✓") : color.red("✗");
      p.log.info(
        `  ${status} ${check.source} ${color.dim(`→ ${check.target}`)}`
      );
    });

    // Discover computers
    const availableComputers = await discoverComputers(
      this.config.minecraftSavePath
    );
    if (availableComputers.length === 0) {
      throw new Error("No computers found in the save directory.");
    }

    const availableComputerIds = availableComputers.map((c) => c.id);
    const requiredComputerIds = [
      ...new Set(this.config.files.flatMap((f) => f.computers || [])),
    ];
    const matchedComputers = availableComputers.filter((c) =>
      requiredComputerIds.includes(c.id)
    );

    if (matchedComputers.length === 0) {
      throw new Error("No matching computers found to sync files to.");
    }

    return { fileChecks, matchedComputers, requiredComputerIds };
  }

  private async performSync(validation: ValidatedSync) {
    const { fileChecks, matchedComputers } = validation;
    const spinner = p.spinner();
    let successCount = 0;
    let errorCount = 0;

    for (const computer of matchedComputers) {
      spinner.start(`Copying files to computer ${computer.id}`);

      try {
        const relevantFiles = fileChecks.filter(
          (check) => check.exists && check.computers?.includes(computer.id)
        );

        if (relevantFiles.length === 0) {
          spinner.stop(`No files configured for computer ${computer.id}`);
          continue;
        }

        await copyFilesToComputer(relevantFiles, this.config, computer.path);
        await setTimeout(500);
        spinner.stop(
          `${color.green("✓")} Files copied to computer ${computer.id}`
        );
        successCount++;
      } catch (err) {
        spinner.stop(
          `${color.red("✗")} Error copying files to computer ${
            computer.id
          }: ${err}`
        );
        errorCount++;
      }
    }

    return { successCount, errorCount };
  }

  private logWatchModeMessage = () => {
    p.log.info(color.cyan("\nWatching for file changes..."));
    p.log.info(color.cyanBright("Press ESC to exit..."));
  };

  async startWatching() {
    if (this.isWatching) return;

    // Initial validation
    const validation = await this.validateSync();

    this.isWatching = true;
    const patterns = this.config.files.map((f) =>
      path.join(this.config.sourcePath, f.source)
    );

    // Perform initial sync
    const { successCount, errorCount } = await this.performSync(validation);
    p.log.info(
      `Initial sync completed with ${successCount}/${
        successCount + errorCount
      } ${this.pl_computer(successCount)} updated.`
    );

    this.watcher = watch(patterns, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    // Setup key handler
    this.keyHandler = new KeyHandler({
      onEsc: async () => {
        await this.stopWatching();
        p.outro("Watch mode stopped.");
        process.exit(0);
      },
      onCtrlC: async () => {
        await this.stopWatching();
        p.outro("Program terminated.");
        process.exit(0);
      },
    });

    this.keyHandler.start();

    // Handle file changes
    this.watcher.on("change", async (changedPath) => {
      if (!this.isWatching) return; // Skip if we're stopping

      p.log.info(`\nFile changed: ${changedPath}`);
      try {
        const validation = await this.validateSync();
        const { successCount, errorCount } = await this.performSync(validation);
        p.log.info(
          `Sync completed with ${successCount}/${
            successCount + errorCount
          } ${this.pl_computer(successCount)} updated.`
        );

        // Re-display watch mode message
        this.logWatchModeMessage();
      } catch (err) {
        p.log.error(`Sync failed: ${err}`);
        // Re-display watch mode message even after error
        this.logWatchModeMessage();
      }
    });

    // Handle watcher errors
    this.watcher.on("error", (error) => {
      p.log.error(`Watch error: ${error}`);
      // Re-display watch mode message
      this.logWatchModeMessage();
    });

    // Initial watch message
    this.logWatchModeMessage();
  }

  async singleMode() {
    while (true) {
      try {
        const validation = await this.validateSync();
        const { successCount, errorCount } = await this.performSync(validation);
        p.log.info(
          `Initial sync completed with ${successCount}/${
            successCount + errorCount
          } computers updated.`
        );

        p.log.info(
          color.cyanBright("Press SPACE to re-sync or ESC to exit...")
        );

        // Wait for a key press
        await new Promise<void>((resolve, reject) => {
          this.keyHandler = new KeyHandler({
            onSpace: async () => {
              this.keyHandler?.stop();
              this.keyHandler = null;
              resolve();
            },
            onEsc: async () => {
              this.keyHandler?.stop();
              this.keyHandler = null;
              p.outro("Manual mode stopped.");
              process.exit(0);
            },
            onCtrlC: async () => {
              this.keyHandler?.stop();
              this.keyHandler = null;
              p.outro("Program terminated.");
              process.exit(0);
            },
          });

          this.keyHandler.start();
        });
      } catch (err) {
        if (this.keyHandler) {
          this.keyHandler.stop();
          this.keyHandler = null;
        }
        p.log.error(`Sync failed: ${err}`);
        break;
      }
    }
  }

  async stopWatching() {
    // Clean up key handler
    if (this.keyHandler) {
      this.keyHandler.stop();
      this.keyHandler = null;
    }

    // Clean up watcher
    if (this.watcher) {
      try {
        await this.watcher.close();
      } catch (err) {
        p.log.error(`Error closing watcher: ${err}`);
      }
      this.watcher = null;
    }
  }
}
