#!/usr/bin/env node
// index.ts

import * as p from "@clack/prompts";
import { createDefaultConfig, findConfig, loadConfig } from "./config";
import color from "picocolors";
import path from "path";
import { SyncManager } from "./sync";
import { createLogger } from "./log";
import { theme } from "./theme";
import { toTildePath } from "./utils";
import { SyncEvent, type SyncMode } from "./types";

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

  p.intro(`${color.magentaBright(`CC:Sync`)}`);

  try {
    const config = await initConfig();
    // Init log
    const log = createLogger({ verbose: config.advanced.verbose });
    const savePath = path.parse(config.minecraftSavePath);

    // ---- Confirm MC save location ----

    const res = await p.confirm({
      message: `Sync with ${theme.bold(
        theme.warn(savePath.name)
      )}?  ${theme.dim(toTildePath(config.minecraftSavePath))}'`,
      initialValue: true,
    });

    if (p.isCancel(res) || !res) {
      log.info(
        "If this save instance is incorrect, change the 'minecraftSavePath' in the .ccsync.yaml to point to the one you want."
      );
      log.status("Goodbye!");
      process.exit(0);
    }

    // Choose mode
    const mode: SyncMode = (await p.select({
      message: "Select sync mode:",
      options: [
        { value: "manual", label: "Manual mode", hint: "Sync on command" },
        {
          value: "watch",
          label: "Watch mode",
          hint: "Auto-sync on file changes",
        },
      ],
    })) as SyncMode;

    if (p.isCancel(mode)) {
      log.status("Goodbye!");
      process.exit(0);
    }

    const syncManager = new SyncManager(config);

    // Handle process termination signals
    const cleanup = async () => {
      await syncManager.stop();
      log.status("Goodbye!");
      process.exit(0);
    };

    process.on("SIGINT", cleanup); // Ctrl+C
    process.on("SIGTERM", cleanup); // Termination request

    try {
      if (mode === "manual") {
        const manualController = await syncManager.startManualMode();

        manualController.on(
          SyncEvent.SYNC_COMPLETE,
          ({ successCount, errorCount, missingCount }) => {
            log.verbose(
              `Sync stats: ${successCount} successful, ${errorCount} failed, ${missingCount} missing`
            );
          }
        );

        manualController.on(SyncEvent.SYNC_ERROR, (error) => {
          log.error(`Sync error: ${error}`);
        });

        manualController.on(SyncEvent.STOPPED, () => {
          cleanup();
        });
      } else {
        const watchController = await syncManager.startWatchMode();

        watchController.on(SyncEvent.STARTED, () => {
          log.verbose("Watch mode started");
        });

        watchController.on(
          SyncEvent.INITIAL_SYNC_COMPLETE,
          ({ successCount, errorCount, missingCount }) => {
            if (config.advanced.verbose) {
              log.verbose(
                `Initial sync stats: ${successCount} successful, ${errorCount} failed, ${missingCount} missing`
              );
            }
          }
        );

        watchController.on(
          SyncEvent.FILE_SYNC,
          ({ path, successCount, errorCount, missingCount }) => {
            if (config.advanced.verbose) {
              log.verbose(
                `Synced ${path}: ${successCount} successful, ${errorCount} failed, ${missingCount} missing`
              );
            }
          }
        );

        watchController.on(SyncEvent.FILE_SYNC_ERROR, ({ path, error }) => {
          log.error(`Failed to sync ${path}: ${error}`);
        });

        watchController.on(SyncEvent.WATCHER_ERROR, (error) => {
          log.error(`Watcher error: ${error}`);
        });

        watchController.on(SyncEvent.STOPPED, () => {
          cleanup();
        });
      }
    } catch (err) {
      log.error(
        `Failed to start sync: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      await syncManager.stop();
      process.exit(1);
    }

    // Keep the process alive until explicitly terminated
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!syncManager.isRunning()) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
  } catch (err) {
    p.log.error(`${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(console.error);
