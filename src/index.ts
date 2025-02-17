// index.ts

import * as p from "@clack/prompts";
import { loadConfig } from "./config";
import color from "picocolors";
import path from "path";
import {
  checkConfigTrackedFiles,
  copyFilesToComputer,
  discoverComputers,
  pluralize,
} from "./utils";
import { setTimeout } from 'node:timers/promises';

async function main() {
  console.clear();

  p.intro(`${color.magentaBright(`CC:Sync`)}`);

  try {
    const config = await loadConfig("./examples/test1/example.ccsync.yaml");
    const savePath = path.parse(config.minecraftSavePath);

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

    // Check config files
    p.log.info("📂 Checking tracked files...");
    const fileChecks = await checkConfigTrackedFiles(config);

    // Display file check results
    fileChecks.forEach((check) => {
      const status = check.exists ? color.green("✓") : color.red("✗");
      p.log.info(`${status} ${check.source} ${color.dim(`→ ${check.target}`)}`);
    });

    // If any files are missing, ask to continue
    if (fileChecks.some((check) => !check.exists)) {
      const continueWithMissing = await p.confirm({
        message: "Some files are missing. Continue anyway?",
        initialValue: false,
      });

      if (!continueWithMissing) {
        p.cancel("Cancelled due to missing files.");
        process.exit(0);
      }
    }

    p.log.success("Found all tracked files.");

    // Discover available computers
    p.log.info(
      `🖥️ Scanning for computers in ${color.bold(
        color.yellow(savePath.name)
      )}...`
    );
    const availableComputers = await discoverComputers(
      config.minecraftSavePath
    );

    if (availableComputers.length === 0) {
      p.log.error("No computers found in the save directory.");
      process.exit(1);
    }

    const availableComputerIds = availableComputers.map((c) => c.id);
    const requiredComputerIds = [
      ...new Set(config.files.flatMap((f) => f.computers || [])),
    ];
    const matchedComputers = availableComputers.filter((c) =>
      requiredComputerIds.includes(c.id)
    );

    const pl_computer = pluralize("computer");

    p.log.info(`The configured sync requires ${
      requiredComputerIds.length
    } ${pl_computer(requiredComputerIds.length)}:  ${requiredComputerIds.map(
      (i) => `"${i}"`
    )}
      `);
    if (matchedComputers.length === requiredComputerIds.length) {
      p.log.success(`Found all required computers.`);
    } else {
      const missingComputers = requiredComputerIds.filter(
        (id) => !availableComputerIds.includes(id)
      );
      p.log.warn(
        `Did not find all required computers. Found ${matchedComputers.length} of ${requiredComputerIds.length}.` +
          `\nMissing computers: ${missingComputers
            .map((id) => `"${id}"`)
            .join(", ")}`
      );
    }

    if (matchedComputers.length === 0) {
      p.log.error("No matching computers found to sync files to.");
      process.exit(1);
    }

    const continueWithSync = await p.confirm({
      message: `${color.cyan(
        `Continue with syncing files to ${
          matchedComputers.length
        } ${pl_computer(matchedComputers.length)}?`
      )}`,
      initialValue: true,
    });

    if (!continueWithSync) {
      p.cancel("Sync cancelled.");
      process.exit(0);
    }

    // Start copying files
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

        await copyFilesToComputer(relevantFiles, config, computer.path);
        await setTimeout(500)
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

    p.outro(
      `❇️ Sync completed with ${successCount} successful and ${errorCount} failed ${pl_computer(
        errorCount
      )}.`
    );
  } catch (err) {
    p.log.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(console.error);
