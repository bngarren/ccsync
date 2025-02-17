// config.ts

import { z } from "zod";
import { parse } from "yaml";
import { resolvePath } from "./utils";
import path from "path";
import * as fs from "node:fs/promises";

const DEFAULT_CONFIG_FILENAME = ".ccsync.yaml";

const DEFAULT_CONFIG: Config = {
  sourcePath: "./src",
  minecraftSavePath: "~/minecraft/saves/world",
  computerGroups: {},
  files: [],
};

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
          relativePath: path.relative(startDir, configPath)
        });
      } catch {
        // Continue searching even if this path doesn't exist
      }
      currentDir = path.dirname(currentDir);
    }
    
    return configs;
};

export const createDefaultConfig = async (projectDir: string) => {
  const configPath = path.join(projectDir, DEFAULT_CONFIG_FILENAME);
  const configContent = `# CC:Sync Configuration
sourcePath: "${DEFAULT_CONFIG.sourcePath}"
minecraftSavePath: "${DEFAULT_CONFIG.minecraftSavePath}"
computerGroups: {}
files: []
  # Add your files to sync here
  # - source: "program.lua"
  #   target: "/programs/program.lua"
  #   computers: ["1"]
`;

  await fs.writeFile(configPath, configContent, "utf-8");
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
    throw new Error(`Failed to load config: ${error}`);
  }
}
