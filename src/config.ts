// config.ts

import { z } from "zod"
import { parse } from "yaml"
import { pathIsLikelyFile, processPath, resolvePath } from "./utils"
import path from "path"
import * as fs from "node:fs/promises"

import { merge } from "ts-deepmerge"
import type { DeepPartial } from "./types"

export const CONFIG_VERSION = "2.1"
export const DEFAULT_CONFIG_FILENAME = ".ccsync.yaml"
export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  sourceRoot: "./src",
  minecraftSavePath: "~/minecraft/saves/world",
  computerGroups: {},
  rules: [],
  advanced: {
    logToFile: false,
    logLevel: "debug",
    cacheTTL: 5000,
    usePolling: false,
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

// Schema that allows computer IDs or group references
const ComputerReferenceSchema = z.union([
  ComputerIdSchema,
  z.string().min(1, "Group reference cannot be empty"),
])

// Computer group schema
const ComputerGroupSchema = z.object({
  name: z.string({
    required_error: "Group name is required",
    invalid_type_error: "Group name must be text",
  }),
  computers: z.array(ComputerReferenceSchema, {
    required_error: "Group must contain computer IDs or group references",
    invalid_type_error: "Computers must be an array of IDs or group names",
  }),
})

// Sync rule schema
const SyncRuleSchema = z.object({
  source: z
    .string({
      required_error: "Source file path is required",
      invalid_type_error: "Source must be a file path",
    })
    .transform((path) => processPath(path, false)), // keep trailing slashes for globs
  target: z
    .string({
      required_error: "Target file path is required",
      invalid_type_error: "Target must be a file path",
    })
    .transform((path) => processPath(path)),
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
  logToFile: z
    .boolean({
      invalid_type_error: "logToFile must be true or false",
    })
    .default(false),
  // mirror pino's log levels
  logLevel: z
    .enum([
      "silent",
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ] as const)
    .default("debug"),
  cacheTTL: z
    .number({
      invalid_type_error: "Cache TTL must be a number",
    })
    .min(0, "Cache TTL cannot be negative")
    .default(5000),
  usePolling: z.boolean({ coerce: true }).default(false),
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
      .transform((path) => processPath(path)),
    minecraftSavePath: z
      .string({
        required_error: "Minecraft save path is required",
        invalid_type_error: "Save path must be text",
      })
      .transform((path) => processPath(path)),
    computerGroups: ComputerGroupsSchema,
    rules: z.array(SyncRuleSchema),
    advanced: AdvancedOptionsSchema.default({
      cacheTTL: 5000,
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

    // Verify any computer groups that are referenced

    // Collect all defined group names
    const definedGroups = config.computerGroups
      ? new Set(Object.keys(config.computerGroups))
      : new Set<string>()

    // Helper to check if a string is likely a group reference (not a numeric ID)
    const isLikelyGroupReference = (ref: string) => isNaN(Number(ref))

    // 1. Check group references within group definitions
    if (config.computerGroups) {
      for (const [groupName, group] of Object.entries(config.computerGroups)) {
        for (const computer of group.computers) {
          // Skip validation for computer IDs
          if (!isLikelyGroupReference(computer)) {
            continue
          }

          // Check if referenced group exists
          if (!definedGroups.has(computer)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Computer group '${groupName}' references unknown group '${computer}'`,
              path: ["computerGroups", groupName, "computers"],
            })
          }
        }
      }
    }

    // 2. Check group references in sync rules
    for (const [ruleIndex, rule] of config.rules.entries()) {
      const computerRefs = Array.isArray(rule.computers)
        ? rule.computers
        : [rule.computers]

      for (const ref of computerRefs) {
        // Skip validation for computer IDs
        if (!isLikelyGroupReference(ref)) {
          continue
        }

        // Check if referenced group exists
        if (!definedGroups.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Sync rule references unknown computer group '${ref}'`,
            path: ["rules", ruleIndex, "computers"],
          })
        }
      }
    }
  })

export type Config = z.infer<typeof ConfigSchema>
export type ComputerGroup = z.infer<typeof ComputerGroupSchema>
export type SyncRule = z.infer<typeof SyncRuleSchema>

// ---- CONFIG METHODS ----

export const withDefaultConfig = (config: DeepPartial<Config>): Config => {
  return merge.withOptions({ mergeArrays: false }, DEFAULT_CONFIG, config, {
    rules:
      config.rules?.map((rule) => ({
        ...rule,
        flatten: rule?.flatten ?? true, // Default to true if undefined
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

type LoadConfigOptions = {
  /**
   * Path validation in loadConfig includes verifying that the `sourceRoot` directory exists and that the `minecraftSavePath` exists and can be accessed
   *
   * Skipping this validation step can be helpful for tests.
   */
  skipPathValidation?: boolean
}

export async function loadConfig(
  configFilePath: string,
  options: LoadConfigOptions = {
    skipPathValidation: false,
  }
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
    // Resolve paths
    const resolvedSourceRoot = resolvePath(validatedConfig.sourceRoot)
    const resolvedSavePath = resolvePath(validatedConfig.minecraftSavePath)

    // We can skip path validation during testing
    if (!options.skipPathValidation) {
      // Validate source root
      try {
        const sourceRootStats = await fs.stat(resolvedSourceRoot)
        if (!sourceRootStats.isDirectory()) {
          result.errors.push({
            category: ConfigErrorCategory.PATH,
            message: `Source root '${validatedConfig.sourceRoot}' is not a directory`,
            suggestion:
              "Make sure the source path points to a directory containing your source files.",
            verboseDetail: `Path resolved to: ${resolvedSourceRoot}`,
          })
        }
      } catch (err) {
        result.errors.push({
          category: ConfigErrorCategory.PATH,
          message: `Source root '${validatedConfig.sourceRoot}' cannot be accessed`,
          suggestion: "Create the directory or check permissions.",
          verboseDetail: `Error: ${err instanceof Error ? err.message : String(err)}, Path: ${resolvedSourceRoot}`,
        })
      }

      // Validate save path
      try {
        await fs.access(resolvedSavePath)
        // We don't validate if it's a Minecraft save here - that happens elsewhere
      } catch (err) {
        result.errors.push({
          category: ConfigErrorCategory.PATH,
          message: `Minecraft save path '${validatedConfig.minecraftSavePath}' cannot be accessed`,
          suggestion:
            "Check if the save exists and you have permissions to access it.",
          verboseDetail: `Error: ${err instanceof Error ? err.message : String(err)}, Path: ${resolvedSavePath}`,
        })
      }
    }

    // Check for circular references in computer groups
    if (validatedConfig.computerGroups) {
      const circularRefs = findCircularGroupReferences(
        validatedConfig.computerGroups
      )
      if (circularRefs.length > 0) {
        result.errors.push({
          category: ConfigErrorCategory.COMPUTER,
          message: `Circular references detected in computer groups: ${circularRefs.join(", ")}`,
          suggestion: "Remove circular references between computer groups.",
          verboseDetail: `Circular reference chain: ${circularRefs.join(" -> ")}`,
        })
      }
    }

    // Only set the config if we have no errors
    if (result.errors.length === 0) {
      result.config = {
        ...validatedConfig,
        sourceRoot: processPath(resolvedSourceRoot),
        minecraftSavePath: processPath(resolvedSavePath),
      }
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

# IMPORTANT: Recommend using forward slashes (/) in paths, even on Windows.
# Example: "C:/Users/name/path"
# Otherwise, backslashes need to be properly escaped: "C:\\Users\\name\\path"

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
  # Enable logging to file
  logToFile: false
  
  # Log level: silent, trace, debug, info, warn, error, fatal
  logLevel: "debug"
  
  # How long to cache validation results (milliseconds)
  # Lower = more accurate but more CPU intensive, Higher = faster but may miss changes
  cacheTTL: 5000

  # To use polling during match mode rather than native OS events (default). This may be necessary if watch mode is missing file changes. Polling may result in higher CPU usage (with a large number of watched files).
  usePolling: false
`

  await fs.writeFile(configPath, configContent, "utf-8")
}

/**
 * Detects circular references between computer groups in the configuration.
 *
 * A circular reference occurs when computer groups reference each other in a loop,
 * which would cause infinite recursion when trying to resolve all computers in a group.
 *
 * Example of a circular reference:
 * ```
 * computerGroups: {
 *   servers: {
 *     name: "Servers",
 *     computers: ["1", "2", "clients"]  // References the 'clients' group
 *   },
 *   clients: {
 *     name: "Clients",
 *     computers: ["3", "4", "servers"]  // References the 'servers' group, creating a loop
 *   }
 * }
 * ```
 *
 * @param groups - Record of computer group definitions from the config
 * @returns An array of group names that form a circular reference chain, or an empty array if none found.
 * For the example above, it would return: ["servers", "clients", "servers"]
 */
export function findCircularGroupReferences(
  groups: Record<string, ComputerGroup>
): string[] {
  // Helper to check if a string is a number (computer ID) or a group name
  const isGroupName = (name: string) =>
    isNaN(Number(name)) && groups[name] !== undefined

  // Depth-first search to find cycles
  function dfs(
    current: string,
    visited: Set<string>,
    path: string[]
  ): string[] {
    if (visited.has(current)) {
      // Found a cycle
      const cycleStart = path.indexOf(current)
      return path.slice(cycleStart)
    }

    // Not a group, no need to process
    if (!isGroupName(current)) {
      return []
    }

    visited.add(current)
    path.push(current)

    // Check all computers in this group
    for (const computer of groups[current].computers) {
      // Only recurse if it's a group name
      if (isGroupName(computer)) {
        const cycle = dfs(computer, visited, [...path])
        if (cycle.length > 0) {
          return cycle
        }
      }
    }

    visited.delete(current)
    return []
  }

  // Check each group
  for (const groupName of Object.keys(groups)) {
    const cycle = dfs(groupName, new Set<string>(), [])
    if (cycle.length > 0) {
      return cycle
    }
  }

  return []
}
