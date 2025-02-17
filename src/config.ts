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
