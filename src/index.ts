#!/usr/bin/env node
// index.ts

import * as p from "@clack/prompts"
import {
  ConfigErrorCategory,
  createDefaultConfig,
  findConfig,
  loadConfig,
  type ConfigError,
} from "./config"
import color from "picocolors"
import path from "path"
import { SyncManager } from "./sync"
import { theme } from "./theme"
import { toTildePath } from "./utils"
import { SyncMode } from "./types"
import { AppError, ErrorSeverity, getErrorMessage } from "./errors"
import { getLogDirectory, getLogger, initializeLogger } from "./log"
import { version } from "./version"
import { UI } from "./ui"
import * as os from "node:os"
import figures from "figures"
import chalk from "chalk"
import {
  getPrettyParsedArgs,
  handleCommands,
  parseArgs,
  type ParsedArgs,
} from "./args"
import { README_ADDRESS } from "./constants"

const initConfig = async (parsedArgs: ParsedArgs) => {
  // Find all config files
  const configs = await findConfig()

  let configPath: string

  if (configs.length === 0) {
    const createDefault = await p.confirm({
      message: "No configuration file found. Create a default configuration?",
      initialValue: true,
    })

    if (!createDefault) {
      p.cancel("Cannot proceed without configuration.")
      process.exit(0)
    }

    await createDefaultConfig(process.cwd())
    p.log.success(`Created default config at ${process.cwd()}/.ccsync.yaml`)
    p.log.info("Please edit the configuration file and run the program again.")
    process.exit(0)
  } else if (configs.length === 1) {
    configPath = configs[0].path
    // p.log.info(`Using config: ${color.gray(configs[0].relativePath)}`);
  } else {
    // Multiple configs found - let user choose
    const selection = (await p.select({
      message: "Multiple config files found. Select one to use:",
      options: configs.map((config, index) => ({
        value: config.path,
        label: config.relativePath,
        hint: index === 0 ? "closest to current directory" : undefined,
      })),
    })) as string

    if (!selection) {
      p.cancel("No config selected.")
      process.exit(0)
    }

    configPath = selection
  }

  return await loadConfig(configPath, {
    overrides: {
      logToFile: parsedArgs.logToFile,
      logLevel: parsedArgs.logLevel,
    },
  })
}

function getErrorCategoryTitle(category: ConfigErrorCategory) {
  switch (category) {
    case ConfigErrorCategory.PATH:
      return "Path Issues"
    case ConfigErrorCategory.RULE:
      return "Sync Rule Issues"
    case ConfigErrorCategory.COMPUTER:
      return "Computer Configuration Issues"
    case ConfigErrorCategory.VERSION:
      return "Version Compatibility Issues"
    default:
      return "Other Issues"
  }
}

const presentConfigErrors = (errors: ConfigError[], verbose: boolean) => {
  let errorLog = `Configuration errors found (${errors.length}):\n`

  let counter = 1

  // Group errors by category
  const errorsByCategory: Record<ConfigErrorCategory, ConfigError[]> =
    Object.values(ConfigErrorCategory).reduce(
      (acc, category) => {
        acc[category] = []
        return acc
      },
      {} as Record<ConfigErrorCategory, ConfigError[]>
    )

  // Populate error categories
  errors.forEach((error) => {
    errorsByCategory[error.category].push(error)
  })

  // Construct error messages with category headers
  Object.entries(errorsByCategory).forEach(([category, categoryErrors]) => {
    if (categoryErrors.length === 0) return

    const title = getErrorCategoryTitle(category as ConfigErrorCategory)
    const categoryErrorsText = categoryErrors
      .map((error) => {
        let errorMessage = theme.error(`    ${counter++}. ${error.message}`)

        if (error.suggestion) {
          errorMessage =
            errorMessage +
            theme.dim(` ${figures.arrowRight} ${error.suggestion}`)
        }

        const details = [errorMessage]

        if (verbose && error.verboseDetail) {
          details.push(
            `      ${theme.dim(`${chalk.italic("[verbose]")} ${error.verboseDetail}`)}`
          )
        }

        return details.join("\n")
      })
      .join("\n")

    errorLog += `\n${theme.bold(` ${figures.triangleRightSmall} ${title}:`)}\n${categoryErrorsText}`
  })

  // Log all errors in one call
  p.log.error(errorLog)

  // Helpful general guidance at the end
  p.log.info(
    theme.bold("General guidance:") + // No newline before this
      "\n  • Edit your .ccsync.yaml file to fix the issues above" +
      "\n  • Consider running with config option logToFile=true and review logs for more information" +
      `\n  • Refer to documentation at ${theme.accent(README_ADDRESS)}`
  )
}

/**
 * Handles fatal errors and exits the process
 */
async function handleFatalError(
  error: unknown,
  syncManager?: SyncManager
): Promise<never> {
  // Extract message from the error
  const message =
    error instanceof AppError ? error.message : getErrorMessage(error)

  // Log the error
  const log = getLogger()
  log.fatal(`FATAL ERROR: ${message}`)

  // Collect system and environment details
  const systemInfo = {
    timestamp: new Date().toISOString(),
    os: {
      type: os.type(),
      release: os.release(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: `${os.uptime()}s`,
    },
    cpu: {
      model: os.cpus()[0]?.model ?? "Unknown",
      cores: os.cpus().length,
      load: os.loadavg(),
    },
    memory: {
      total: `${(os.totalmem() / 1024 / 1024).toFixed(2)} MB`,
      free: `${(os.freemem() / 1024 / 1024).toFixed(2)} MB`,
    },
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      execPath: process.execPath,
      argv: process.argv,
      cwd: process.cwd(),
      uid: process.getuid?.() ?? "N/A",
      gid: process.getgid?.() ?? "N/A",
    },
    resourceUsage: process.resourceUsage(),
  }

  // Try to clean up if we have a sync manager
  if (syncManager) {
    try {
      await syncManager.stop()
    } catch (stopErr) {
      log.error(`Error during cleanup: ${getErrorMessage(stopErr)}`)
    }
  }

  // Exit with error code
  p.outro("Application terminated due to a fatal error.")

  console.log(
    "🫡 Perhaps an issue should be created? See https://github.com/bngarren/ccsync/issues",
    systemInfo
  )

  process.exit(1)
}

async function main() {
  const parsedArgs = parseArgs()

  process.stdout.write("\x1B[2J\x1B[0f")
  process.stdout.write("\n\n")

  p.intro(color.cyanBright(`CC: Sync`))

  await handleCommands(parsedArgs)

  try {
    // Get the config file
    const { config, errors } = await initConfig(parsedArgs)

    if (errors.length > 0) {
      presentConfigErrors(errors, parsedArgs.verbose)
      p.outro("Please fix these issues and try again.")
      process.exit(0)
    }

    if (!config) {
      p.log.error("No valid configuration found.")
      process.exit(0)
    }

    // Initialize logger with config settings
    initializeLogger({
      logToFile: config.advanced.logToFile,
      logLevel: config.advanced.logLevel,
    })

    const log = getLogger().child({ component: "Main" })
    log.info(
      {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        ccSyncVersion: version || process.env.npm_package_version || "unknown",
        platform: process.platform,
        nodeVersion: process.version,
        config: {
          sourceRoot: config.sourceRoot,
          minecraftSave: path.posix.basename(config.minecraftSavePath),
          rulesCount: config.rules.length,
        },
      },
      "CC: Sync initialized"
    )
    log.trace({ config }, "Current configuration")

    // ---- Banner messages ----
    if (parsedArgs.verbose) {
      let details = ""
      details += `version: v${version}\n`
      details += `args: ${getPrettyParsedArgs(parsedArgs)}\n`
      if (config.advanced.logToFile) {
        details += `Logging to file at: ${getLogDirectory()}`
      }
      p.note(details, theme.dim("info"))
    } else {
      p.log.message(theme.dim(`Logging to file at: ${getLogDirectory()}`))
    }

    if (parsedArgs.smokeTest) {
      console.debug("Smoke test mode - exiting immediately")
      process.exit(0)
    }

    const savePath = path.parse(config.minecraftSavePath)

    const gracefulExit = () => {
      p.outro(theme.info("Goodbye."))
      log.info("Gracefully exited.")
      process.exit(0)
    }

    // ---- Confirm MC save location ----

    const res = await p.confirm({
      message: `Begin a sync with Minecraft world: ${theme.bold(
        theme.warn(savePath.name)
      )}?  ${theme.dim(toTildePath(config.minecraftSavePath))}`,
      initialValue: true,
    })

    if (p.isCancel(res) || !res) {
      p.note(
        `If this save instance is incorrect, change the 'minecraftSavePath' in the .ccsync.yaml to point to the one you want.`,
        "Hint"
      )
      gracefulExit()
    }

    log.debug(`User confirmed minecraftSavePath at ${config.minecraftSavePath}`)

    // ---- CHOOSE SYNC MODE ----
    const mode: SyncMode = (await p.select({
      message: "Select sync mode:",
      options: [
        { value: "manual", label: "Manual mode", hint: "Sync on command" },
        {
          value: "watch",
          label: "Watch mode",
          hint: "Auto-sync on file changes",
        },
      ],
    })) as SyncMode

    if (p.isCancel(mode)) {
      gracefulExit()
    }

    log.debug(`User selected sync mode: ${mode.toUpperCase()}`)

    const ui = new UI()
    const syncManager = new SyncManager(config, ui)

    // Handle process termination signals
    const cleanup = () => {
      syncManager.stop().catch((err: unknown) => {
        console.log(`Error could not stop syncManager on cleanup: ${err}`)
      })
      ui.stop()
      gracefulExit()
    }

    process.on("SIGINT", cleanup) // Ctrl+C
    process.on("SIGTERM", cleanup) // Termination request

    try {
      if (mode === SyncMode.MANUAL) {
        const { start } = syncManager.initManualMode()
        start()
      } else {
        const { start } = syncManager.initWatchMode()
        start()
      }

      // Keep the process alive until explicitly terminated
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!syncManager.isRunning()) {
            clearInterval(checkInterval)
            resolve()
          }
        }, 500)
      })

      gracefulExit()
    } catch (error) {
      // Handle errors that bubble up from SyncManager
      if (error instanceof AppError) {
        if (error.severity === ErrorSeverity.FATAL) {
          await handleFatalError(error, syncManager)
        } else {
          // Non-fatal errors - log and exit gracefully
          p.log.error(`Error: ${error.message}`)
          gracefulExit()
        }
      } else {
        // Unknown errors - treat as fatal
        await handleFatalError(error, syncManager)
      }
    }
  } catch (error) {
    // Catch-all for errors during startup
    await handleFatalError(error)
  }
}

main().catch((error: unknown) => {
  // Last resort error handling - should rarely get here
  console.error(`Unhandled error in main process: ${getErrorMessage(error)}`)
  if (error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
