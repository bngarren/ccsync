import * as p from "@clack/prompts"
import { createDefaultConfig, type Config, findConfig } from "./config"
import { clearComputers, findMinecraftComputers } from "./utils"
import { theme } from "./theme"
import { type ProcessedArgs } from "./args"
import type { Logger } from "pino"
import { setTimeout } from "node:timers/promises"
import path from "node:path"

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
      p.outro("Config creation cancelled.")
    }
  } catch (err) {
    await createDefaultConfig(process.cwd())
    p.log.success(`Created default config at ${process.cwd()}/.ccsync.yaml`)
    p.log.info("Please edit the configuration file and run the program again.")
  }
}

/**
 * Identifies computers in the configured `minecraftSavePath` and prints to the screen
 */
export async function handleComputersFindCommand(
  processedArgs: ProcessedArgs,
  config: Config,
  _log: Logger
): Promise<void> {
  const log = _log.child({ component: "CLI" })
  log.info("running 'computers find' command")

  const computers = await findMinecraftComputers(config.minecraftSavePath)
  const computerIds = computers.map((c) => c.id).join(", ")
  const minecraftSaveText = "Minecraft save at:"
  const { dir, name } = path.parse(config.minecraftSavePath)
  const minecraftSaveDirText = theme.dim(`${dir}${path.sep}`)
  const minecraftSaveNameText = theme.bold(name)
  const foundText = "Found the following computers:"

  const s = p.spinner()

  s.start("Finding computers...")
  // p.log.step("Finding computers...")
  await setTimeout(800)
  s.stop(`${minecraftSaveText} ${minecraftSaveDirText}${minecraftSaveNameText}`)
  if (computerIds.length === 0) {
    p.outro(theme.warning("Did not find any computers in this world!"))
  } else {
    p.outro(`${foundText} ${theme.success(computerIds)}`)
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

  const result = await clearComputers(config, ids)

  log.info(`Successfully cleared: ${result.join(",")}`)
}
