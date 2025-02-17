## src/utils.ts

```ts
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
```


## src/index.ts

```ts
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

  p.intro(`${color.magentaBright(`CC:Sync (v${process.env.npm_package_version})`)}`);

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
```


## src/config.ts

```ts
// config.ts

import { z } from "zod";
import { parse } from "yaml";
import { resolvePath } from "./utils";

export const ConfigSchema = z.object({
  sourcePath: z.string(),
  minecraftSavePath: z.string(),
  computerGroups: z.record(z.string(), z.array(z.string())).optional(),
  files: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      computers: z.union([z.array(z.string()), z.string()]).optional(),
    })
  ),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(configFilePath: string): Promise<Config> {
  try {
    const resolvedPath = resolvePath(configFilePath)
    const file = await Bun.file(resolvedPath).text();
    const config = parse(file);
    const validatedConfig = ConfigSchema.parse(config);
    // Resolve all paths in the config
    return {
        ...validatedConfig,
        sourcePath: resolvePath(validatedConfig.sourcePath),
        minecraftSavePath: resolvePath(validatedConfig.minecraftSavePath)
    }
  } catch (error) {
    throw new Error(`Failed to load config: ${error}`);
  }
}
```


