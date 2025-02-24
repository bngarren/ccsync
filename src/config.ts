// config.ts

import { z, ZodError } from "zod"
import { parse } from "yaml"
import { pathIsLikelyFile, resolvePath } from "./utils"
import path from "path"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import { merge } from "ts-deepmerge"

export const CONFIG_VERSION = "1.0"
export const DEFAULT_CONFIG_FILENAME = ".ccsync.yaml"
export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  sourceRoot: "./src",
  minecraftSavePath: "~/minecraft/saves/world",
  computerGroups: {},
  rules: [],
  advanced: {
    verbose: false,
    cache_ttl: 5000,
  },
}

export interface LoadConfigResult {
  config: Config | null
  errors: string[]
}

const hasGlobPattern = (path: string): boolean => {
  return path.includes("*") || path.includes("{") || path.includes("[")
}

/**
 * Checks if a config version is compatible with the CLI version
 * @param configVersion Version from the config file
 * @returns true if compatible, false if not
 */
export function isConfigVersionCompatible(configVersion: string): boolean {
  // For now, just check major version number
  const [configMajor] = configVersion.split(".")
  const [cliMajor] = CONFIG_VERSION.split(".")
  return configMajor === cliMajor
}

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
])

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
})

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
})

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
})

const ComputerGroupsSchema = z
  .record(z.string(), ComputerGroupSchema)
  .refine((groups) => {
    // Ensure no empty groups
    return Object.values(groups).every((group) => group.computers.length > 0)
  }, "Computer groups cannot be empty")
  .optional()

export const ConfigSchema = z
  .object({
    version: z.string({
      required_error: "Config version is required",
      invalid_type_error: "Version must be a string",
    }),
    sourceRoot: z.string({
      required_error: "Source path is required",
      invalid_type_error: "Source path must be text",
    }),
    minecraftSavePath: z.string({
      required_error: "Minecraft save path is required",
      invalid_type_error: "Save path must be text",
    }),
    computerGroups: ComputerGroupsSchema,
    rules: z.array(SyncRuleSchema),
    advanced: AdvancedOptionsSchema.default({
      verbose: false,
      cache_ttl: 5000,
    }),
  })
  .superRefine((config, ctx) => {
    // Version compatibility check
    if (!isConfigVersionCompatible(config.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Config version ${CONFIG_VERSION} is required. You are using ${config.version}.`,
        path: ["version"],
      })
    }
    // Validate each rule's source/target compatibility
    config.rules.forEach((rule, idx) => {
      if (hasGlobPattern(rule.source) && pathIsLikelyFile(rule.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `When using glob patterns in this rule's [source], [target] should be a directory path. A file path is assumed because it contains a file extension.\n [source] = ${rule.source}\n [target] = ${rule.target} <-- ERROR\n [computers] = ${rule.computers}`,
          path: ["rules", idx],
          fatal: true,
        })
      }
    })

    // Validate source root exists and is accessible
    try {
      const resolvedSourceRoot = resolvePath(config.sourceRoot)
      if (!fsSync.existsSync(resolvedSourceRoot)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Source root '${config.sourceRoot}' does not exist`,
          path: ["sourceRoot"],
          fatal: true,
        })
      } else {
        const stats = fsSync.statSync(resolvedSourceRoot)
        if (!stats.isDirectory()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Source root '${config.sourceRoot}' is not a directory`,
            path: ["sourceRoot"],
            fatal: true,
          })
        }
      }
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Error checking source root: ${err instanceof Error ? err.message : String(err)}`,
        path: ["sourceRoot"],
        fatal: true,
      })
    }
  })

export type Config = z.infer<typeof ConfigSchema>
export type ComputerGroup = z.infer<typeof ComputerGroupSchema>
export type FileSyncRule = z.infer<typeof SyncRuleSchema>

// ---- CONFIG METHODS ----

export const withDefaultConfig = (config: Partial<Config>) => {
  return merge.withOptions(
    { mergeArrays: false },
    DEFAULT_CONFIG,
    config
  ) as Config
}

export const findConfig = async (
  startDir: string = process.cwd()
): Promise<Array<{ path: string; relativePath: string }>> => {
  const configs: Array<{ path: string; relativePath: string }> = []
  let currentDir = startDir

  while (currentDir !== path.parse(currentDir).root) {
    const configPath = path.join(currentDir, DEFAULT_CONFIG_FILENAME)
    try {
      await fs.access(configPath)
      configs.push({
        path: configPath,
        relativePath: path.relative(startDir, configPath),
      })
    } catch {
      // Continue searching even if this path doesn't exist
    }
    currentDir = path.dirname(currentDir)
  }

  return configs
}

export async function loadConfig(
  configFilePath: string
): Promise<LoadConfigResult> {
  const result: LoadConfigResult = {
    config: null,
    errors: [],
  }

  try {
    const resolvedPath = resolvePath(configFilePath)
    const file = await fs.readFile(resolvedPath, "utf-8")
    const rawConfig = parse(file)

    try {
      const validatedConfig = ConfigSchema.parse(rawConfig)
      // Resolve all paths in the config
      result.config = {
        ...validatedConfig,
        sourceRoot: resolvePath(validatedConfig.sourceRoot),
        minecraftSavePath: resolvePath(validatedConfig.minecraftSavePath),
      }
    } catch (error) {
      if (error instanceof ZodError) {
        // Format Zod errors into readable messages
        error.errors.forEach((issue) => {
          result.errors.push(`${issue.message}`)
        })
      } else {
        result.errors.push(
          `Config error: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  } catch (error) {
    result.errors.push(
      `Failed to read/parse config file: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  return result
}

export const createDefaultConfig = async (projectDir: string) => {
  const configPath = path.join(projectDir, DEFAULT_CONFIG_FILENAME)
  const configContent = `# CC:Sync Configuration File
# This file configures how CC:Sync copies files to your ComputerCraft computers

# Config version (do not modify)
version: "${CONFIG_VERSION}"

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
`

  await fs.writeFile(configPath, configContent, "utf-8")
}
