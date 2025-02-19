// config.ts

import { z, ZodError } from "zod";
import { parse } from "yaml";
import { resolvePath } from "./utils";
import path from "path";
import * as fs from "node:fs/promises";
import { merge } from "ts-deepmerge";

const DEFAULT_CONFIG_FILENAME = ".ccsync.yaml";

const DEFAULT_CONFIG: Config = {
  sourceRoot: "./src",
  minecraftSavePath: "~/minecraft/saves/world",
  computerGroups: {},
  rules: [],
  advanced: {
    verbose: false,
    cache_ttl: 5000,
  },
};

// ---- SCHEMA & TYPES ----

// Computer ID validation
const ComputerIdSchema = z.union([
  z
    .string()
    .regex(
      /^(?:0|[1-9]\d*)$/,
      "Computer ID must be a non-negative whole number (e.g. 0, 1, 42)"
    ),
  z
    .number()
    .int("Computer ID must be a whole number (no decimals)")
    .nonnegative("Computer ID must be zero or positive")
    .transform((n) => n.toString()),
]);

// Computer group schema
const ComputerGroupSchema = z.object({
  name: z.string({
    required_error: "Group name is required",
    invalid_type_error: "Group name must be text",
  }),
  computers: z.array(ComputerIdSchema, {
    required_error: "Group must contain computer IDs",
    invalid_type_error: "Computers must be an array of IDs",
  }),
});

// Sync rule schema
const SyncRuleSchema = z.object({
  source: z.string({
    required_error: "Source file path is required",
    invalid_type_error: "Source must be a file path",
  }),
  target: z.string({
    required_error: "Target file path is required",
    invalid_type_error: "Target must be a file path",
  }),
  computers: z
    .union([
      z.array(
        z.union([
          ComputerIdSchema,
          z.string().min(1, "Group name cannot be empty"),
        ])
      ),
      ComputerIdSchema,
      z.string().min(1, "Group name cannot be empty"),
    ])
    .optional()
    .describe("Computer IDs or group names to sync files to"),
});

const AdvancedOptionsSchema = z.object({
  verbose: z
    .boolean({
      invalid_type_error: "Verbose must be true or false",
    })
    .default(false),
  cache_ttl: z
    .number({
      invalid_type_error: "Cache TTL must be a number",
    })
    .min(0, "Cache TTL cannot be negative")
    .default(5000),
});

export const ConfigSchema = z.object({
  sourceRoot: z.string({
    required_error: "Source path is required",
    invalid_type_error: "Source path must be text",
  }),
  minecraftSavePath: z.string({
    required_error: "Minecraft save path is required",
    invalid_type_error: "Save path must be text",
  }),
  computerGroups: z.record(z.string(), ComputerGroupSchema).optional(),
  rules: z.array(SyncRuleSchema),
  advanced: AdvancedOptionsSchema.default({
    verbose: false,
    cache_ttl: 5000,
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ComputerGroup = z.infer<typeof ComputerGroupSchema>;
export type FileSyncRule = z.infer<typeof SyncRuleSchema>;

// ---- CONFIG METHODS ----

export const withDefaultConfig = (config: Partial<Config>) => {
  return merge.withOptions(
    { mergeArrays: false },
    DEFAULT_CONFIG,
    config
  ) as Config;
};

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
        relativePath: path.relative(startDir, configPath),
      });
    } catch {
      // Continue searching even if this path doesn't exist
    }
    currentDir = path.dirname(currentDir);
  }

  return configs;
};

export async function loadConfig(configFilePath: string): Promise<Config> {
  try {
    const resolvedPath = resolvePath(configFilePath);
    try {
      const file = await fs.readFile(resolvedPath, 'utf-8');
      const config = parse(file);
      const validatedConfig = ConfigSchema.parse(config);
      // Resolve all paths in the config
      return {
        ...validatedConfig,
        sourceRoot: resolvePath(validatedConfig.sourceRoot),
        minecraftSavePath: resolvePath(validatedConfig.minecraftSavePath),
      };
    } catch (err) {
      throw new Error(`Failed to read/parse config file: ${err}`);
    }
  } catch (error) {
    if (error instanceof ZodError) {
      const errMsg = error.format();
      throw new Error(
        `Failed to load config. Ensure that syntax is correct.\n${JSON.stringify(
          error.flatten().fieldErrors
        )}`
      );
    } else {
      throw error
    }
  }
}

export const createDefaultConfig = async (projectDir: string) => {
  const configPath = path.join(projectDir, DEFAULT_CONFIG_FILENAME);
  const configContent = `# CC:Sync Configuration File
# This file configures how CC:Sync copies files to your ComputerCraft computers

# Where your source files are located (relative to this config file)
sourceRoot: "${DEFAULT_CONFIG.sourceRoot}"

# Path to your Minecraft world save
# Can use ~ for your home directory
# Example Windows: "~/AppData/Roaming/.minecraft/saves/my_world"
# Example Linux: "~/.minecraft/saves/my_world"
minecraftSavePath: "${DEFAULT_CONFIG.minecraftSavePath}"

# Define groups of computers for easier file targeting
computerGroups: {}
  # Example group:
  # monitors:
  #   name: "Monitor Network"
  #   computers: ["1", "2", "3"]

# Rules that specify which files should sync to which computers
rules: []
  # Examples:
  # Sync to a specific computer:
  # - source: "startup.lua"    # File in your sourceRoot
  #   target: "startup.lua"    # Where to put it on the computer
  #   computers: ["1"]         # Computer IDs to sync to
  #
  # Sync to a group of computers:
  # - source: "lib/*.lua"      # Glob patterns supported
  #   target: "lib/"          # Folders will be created
  #   computers: "monitors"    # Reference a computer group

# Advanced configuration options
advanced:
  # Enable verbose logging
  verbose: false
  
  # How long to cache validation results (milliseconds)
  # Lower = more accurate but more CPU intensive, Higher = faster but may miss changes
  cache_ttl: 5000
`;

  await fs.writeFile(configPath, configContent, "utf-8");
};
