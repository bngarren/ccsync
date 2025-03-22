import * as p from "@clack/prompts"
import { createDefaultConfig, type Config, findConfig } from "./config"
import { clearComputers, findMinecraftComputers } from "./utils"
import { theme } from "./theme"
import { type ProcessedArgs } from "./args"
import type { Logger } from "pino"
import { setTimeout } from "node:timers/promises"
import path from "node:path"
import type { Computer } from "./types"
import { AppError } from "./errors"

export async function handleInitCommand(
  processedArgs: ProcessedArgs,
  _log: Logger
): Promise<void> {
  const log = _log.child({ component: "CLI" })

  log.info("running 'init' command")

  // Check if config already exists
  try {
    const config = await findConfig()
    // Config already exists
    const overwrite = await p.confirm({
      message: theme.warning(
        `Configuration file already exists at ${config.path}. Overwrite?`
      ),
      initialValue: false,
      inactive: "Cancel",
    })

    if (p.isCancel(overwrite) || !overwrite) {
      const msg = `Config creation cancelled.`
      p.outro(msg)
      log.info(msg)
      return
    }
  } catch (err) {
    log.warn(`Overriting .ccsync.yaml with default config...`)
  }
  await createDefaultConfig(process.cwd())
  const msg = `Created default config at ${process.cwd()}/.ccsync.yaml`
  p.log.success(`${theme.success("Success.")} ${msg}`)
  p.outro("Edit the configuration file and run the program with `ccsync`.")
  log.info(msg)
}

/**
 * Identifies computers in the configured `minecraftSavePath` and prints to the screen
 */
export async function handleComputersFindCommand(
  processedArgs: ProcessedArgs,
  config: Config,
  _log: Logger,
  animationTimeout = 700
): Promise<void> {
  const log = _log.child({ component: "CLI" })
  log.info("running 'computers find' command")

  const computers = await findMinecraftComputers(config.minecraftSavePath)
  const computerIds = computers.map((c) => c.id).join(", ")
  const minecraftSaveText = "Searched Minecraft save at:"
  const { dir, name } = path.parse(config.minecraftSavePath)
  const minecraftSaveDirText = theme.dim(`${dir}${path.sep}`)
  const minecraftSaveNameText = theme.bold(name)
  const foundText = "Found the following computers:"

  const s = p.spinner()

  s.start("Finding computers...")
  await setTimeout(animationTimeout)
  s.stop(`${minecraftSaveText} ${minecraftSaveDirText}${minecraftSaveNameText}`)
  if (computerIds.length === 0) {
    p.outro(
      `${theme.warning("Warning:")} Did not find any computers in this world!`
    )
    log.warn("Did not find any computers in the world")
  } else {
    p.outro(
      `${theme.success("Success.")} ${foundText} ${theme.success(computerIds)}`
    )
    log.info(
      {
        foundComputers: computerIds,
        minecraftSavePath: config.minecraftSavePath,
      },
      "Successful 'find' command"
    )
  }
}

/**
 * Clears the contents of 'all' computers or only computers specified by ID
 */
export async function handleComputersClear(
  processedArgs: ProcessedArgs,
  config: Config,
  _log: Logger
) {
  const log = _log.child({ component: "CLI" })
  log.info("running 'computers clear' command")

  const ids = processedArgs.computersClearIds

  // find computers
  let computers: Computer[] = []
  try {
    computers = await findMinecraftComputers(config.minecraftSavePath)
  } catch (error: unknown) {
    log.fatal(error)
    throw AppError.fatal(`Failed to clear`, "clearComputers", error)
  }
  let computersToWipe = [...computers]
  if (ids && ids.length > 0) {
    computersToWipe = computers.filter((c) => ids.includes(Number(c.id)))
  }

  p.log.message(
    `This action will ${theme.warning("remove all content")} from the following computers: ${computersToWipe.map((c) => theme.warning(c.id)).join(", ")}`
  )
  const confirm = await p.confirm({
    message: `Proceed?`,
    initialValue: false,
  })

  if (p.isCancel(confirm) || !confirm) {
    p.outro("Aborted.")
    return
  }

  log.info(`Clearing computers: ${computersToWipe.map((c) => c.id).join(", ")}`)
  const result = await clearComputers(computersToWipe)

  log.info(`Successfully cleared: ${result.join(",")}`)

  p.outro(
    `${theme.success("Success.")} Successfully cleared the following computers: ${result.join(", ")}`
  )
}
