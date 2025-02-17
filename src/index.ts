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

  p.intro(`${color.magentaBright(`CC:Sync`)}`);

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
