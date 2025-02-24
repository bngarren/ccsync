// config.ts

import { z } from "zod"
import { parse } from "yaml"
import { normalizePath, pathIsLikelyFile, resolvePath } from "./utils"
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
  errors: ConfigError[]
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

// ---- ERROR HANDLING ----

export enum ConfigErrorCategory {
  PATH = "path",
  RULE = "rule",
  COMPUTER = "computer",
  VERSION = "version",
  UNKNOWN = "unknown",
}

// Structured error object with helpful context
export interface ConfigError {
  category: ConfigErrorCategory
  message: string
  verboseDetail?: string // Additional technical details for verbose mode
  path?: string[] // Path to the error in the config object
  suggestion?: string // Actionable guidance
}

const categorizeZodError = (issue: z.ZodIssue): ConfigError => {
  let category = ConfigErrorCategory.UNKNOWN
  let suggestion = ""

  // Path contains the location of the error in the config object
  const path = issue.path

  // Use the path and error code to infer the category
  if (path[0] === "sourceRoot" || path[0] === "minecraftSavePath") {
    category = ConfigErrorCategory.PATH
    suggestion =
      "Ensure the path exists and is accessible. Use absolute paths or ~ for home directory."
  } else if (path[0] === "rules") {
    category = ConfigErrorCategory.RULE

    // Check for specific rule issues
    if (issue.message.includes("glob") || issue.message.includes("target")) {
      suggestion =
        "Check that your target is a directory path when using glob patterns. Directories should end with a slash."
    } else if (issue.message.includes("computer")) {
      suggestion =
        "Make sure all computer IDs or group names referenced in rules actually exist."
    }
  } else if (path[0] === "computerGroups") {
    category = ConfigErrorCategory.COMPUTER
    suggestion =
      "Check that all computer groups have valid names and contain at least one computer ID."
  } else if (path[0] === "version") {
    category = ConfigErrorCategory.VERSION
    suggestion = `Update your config version to ${CONFIG_VERSION} or recreate your config file.`
  }

  // Create structured error object
  return {
    category,
    message: issue.message,
    path: [...String(issue.path)],
    suggestion,
    verboseDetail: `Error code: ${issue.code}, Path: ${path.join(".")}`,
  }
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
  source: z
    .string({
      required_error: "Source file path is required",
      invalid_type_error: "Source must be a file path",
    })
    .transform((path) => normalizePath(path, false)), // keep trailing slashes for globs
  target: z
    .string({
      required_error: "Target file path is required",
      invalid_type_error: "Target must be a file path",
    })
    .transform((path) => normalizePath(path)),
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
    .describe("Computer IDs or group names to sync files to"),
  flatten: z.boolean().optional(),
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
    sourceRoot: z
      .string({
        required_error: "Source path is required",
        invalid_type_error: "Source path must be text",
      })
      .transform((path) => normalizePath(path)),
    minecraftSavePath: z
      .string({
        required_error: "Minecraft save path is required",
        invalid_type_error: "Save path must be text",
      })
      .transform((path) => normalizePath(path)),
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
export type SyncRule = z.infer<typeof SyncRuleSchema>

// ---- CONFIG METHODS ----

export const withDefaultConfig = (config: Partial<Config>): Config => {
  return merge.withOptions({ mergeArrays: false }, DEFAULT_CONFIG, config, {
    rules:
      config.rules?.map((rule) => ({
        ...rule,
        flatten: rule.flatten ?? true, // Default to true if undefined
      })) || [],
  }) as Config
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

    const parseResult = ConfigSchema.safeParse(rawConfig)

    if (!parseResult.success) {
      // Transform Zod errors into structured errors
      result.errors = parseResult.error.errors.map(categorizeZodError)
      return result
    }

    const validatedConfig = parseResult.data
    // Resolve and normalize all paths in the config
    result.config = {
      ...validatedConfig,
      sourceRoot: normalizePath(resolvePath(validatedConfig.sourceRoot)),
      minecraftSavePath: normalizePath(
        resolvePath(validatedConfig.minecraftSavePath)
      ),
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Determine if this is a file access issue
    const isFileAccessError =
      errorMessage.includes("ENOENT") ||
      errorMessage.includes("no such file") ||
      errorMessage.includes("cannot open")

    result.errors.push({
      category: isFileAccessError
        ? ConfigErrorCategory.PATH
        : ConfigErrorCategory.UNKNOWN,
      message: `Failed to read/parse config file: ${errorMessage}`,
      suggestion: isFileAccessError
        ? "Check that the config file exists and is readable."
        : "Verify the config file contains valid YAML syntax.",
      verboseDetail: `Full error: ${error instanceof Error ? error.stack : String(error)}`,
    })
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

# Absolute path to your Minecraft world save
# Can use ~ for your home directory
# Example Windows: "~/AppData/Roaming/.minecraft/saves/my_world"
# Example Unix: "~/.minecraft/saves/my_world"
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
