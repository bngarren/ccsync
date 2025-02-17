// index.ts

import * as p from "@clack/prompts";
import { createDefaultConfig, findConfig, loadConfig } from "./config";
import color from "picocolors";
import path from "path";
import {
  checkConfigTrackedFiles,
  copyFilesToComputer,
  discoverComputers,
  pluralize,
  validateSaveDir,
} from "./utils";
import { setTimeout } from "node:timers/promises";
import { SyncManager } from "./sync";

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
    const savePath = path.parse(config.minecraftSavePath);

    // ---- Confirm MC save location ----


    const res = await p.confirm({
      message: `Using world save at '${
        config.minecraftSavePath
      }'\nContinue with ${color.bold(color.yellow(savePath.name))}?`,
      initialValue: true,
    });

    if (!res) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    // Choose mode
    const mode = await p.select({
      message: "Select sync mode:",
      options: [
        { value: "manual", label: "Manual mode", hint: "Sync on command" },
        { value: "watch", label: "Watch mode", hint: "Auto-sync on file changes" },
      ],
    });

    if (!mode) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    const syncManager = new SyncManager(config);

    if (mode === "watch") {
      await syncManager.startWatching();
    } else {
      await syncManager.singleMode();
    }
  } catch (err) {
    p.log.error(`${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(console.error);
