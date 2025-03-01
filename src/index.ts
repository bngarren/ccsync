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
import { type SyncMode } from "./types"
import { AppError, ErrorSeverity, getErrorMessage } from "./errors"

const initConfig = async () => {
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

  return await loadConfig(configPath)
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

const presentConfigErrors = (errors: ConfigError[], isVerbose: boolean) => {
  p.log.error("Configuration errors found:")

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

  // Display errors with category headers
  Object.entries(errorsByCategory).forEach(([category, categoryErrors]) => {
    if (categoryErrors.length === 0) return

    const title = getErrorCategoryTitle(category as ConfigErrorCategory)
    p.log.error(theme.bold(`${title}:`))

    categoryErrors.forEach((error) => {
      p.log.error(
        `  • ${error.message}${error.suggestion ? "\n    " + theme.dim(error.suggestion) : ""}`
      )

      if (isVerbose && error.verboseDetail) {
        p.log.info(`    ${theme.dim(error.verboseDetail)}`)
      }
    })
  })

  // helpful general guidance at the end
  p.log.info(
    theme.bold("\nGeneral guidance:") +
      "\n  • Edit your .ccsync.yaml file to fix the issues above" +
      "\n  • Run with verbose=true for more detailed error information" +
      "\n  • Refer to documentation at https://github.com/bngarren/ccsync#readme"
  )
  // p.log.info("  • Use 'ccsync --init' to create a fresh config if needed")
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
  p.log.error(`FATAL ERROR: ${message}`)

  // Try to clean up if we have a sync manager
  if (syncManager) {
    try {
      await syncManager.stop()
    } catch (stopErr) {
      p.log.error(`Error during cleanup: ${getErrorMessage(stopErr)}`)
    }
  }

  // Exit with error code
  p.outro("Application terminated due to a fatal error.")
  process.exit(1)
}

async function main() {
  console.clear()

  p.intro(`${color.magentaBright(`CC: Sync`)}`)

  try {
    // Get the config file
    const { config, errors } = await initConfig()

    if (errors.length > 0) {
      presentConfigErrors(errors, config?.advanced?.verbose || false)
      p.outro("Please fix these issues and try again.")
      process.exit(0)
    }

    if (!config) {
      p.log.error("No valid configuration found.")
      process.exit(0)
    }

    const savePath = path.parse(config.minecraftSavePath)

    const gracefulExit = () => {
      p.outro(theme.info("Goodbye."))
      process.exit(0)
    }

    // ---- Confirm MC save location ----

    const res = await p.confirm({
      message: `Sync with ${theme.bold(
        theme.warn(savePath.name)
      )}?  ${theme.dim(toTildePath(config.minecraftSavePath))}'`,
      initialValue: true,
    })

    if (p.isCancel(res) || !res) {
      p.log.info(
        "If this save instance is incorrect, change the 'minecraftSavePath' in the .ccsync.yaml to point to the one you want."
      )
      gracefulExit()
    }

    // Choose mode
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

    const syncManager = new SyncManager(config)

    // Handle process termination signals
    const cleanup = async () => {
      await syncManager.stop()
      gracefulExit()
    }

    process.on("SIGINT", cleanup) // Ctrl+C
    process.on("SIGTERM", cleanup) // Termination request

    try {
      if (mode === "manual") {
        await syncManager.startManualMode()
      } else {
        await syncManager.startWatchMode()
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
    if (error instanceof AppError) {
      await handleFatalError(error)
    } else {
      p.log.error(`Fatal error: ${getErrorMessage(error)}`)
      process.exit(1)
    }
  }
}

main().catch((error) => {
  // Last resort error handling - should rarely get here
  console.error(`Unhandled error in main process: ${getErrorMessage(error)}`)
  if (error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
})
