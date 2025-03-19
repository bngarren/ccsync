import * as p from "@clack/prompts"
import { createDefaultConfig, type Config, findConfig } from "./config"
import { findMinecraftComputers } from "./utils"
import { theme } from "./theme"
import { type ParsedArgs } from "./args"
import type { Logger } from "pino"

export async function handleInitCommand(
  parsedArgs: ParsedArgs,
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

export async function handleComputersFindCommand(
  parsedArgs: ParsedArgs,
  config: Config,
  _log: Logger
): Promise<void> {
  const log = _log.child({ component: "CLI" })

  log.info("running 'computers find' command")

  const computers = await findMinecraftComputers(config.minecraftSavePath)
  p.log.message(computers.map((c) => c.id).join(", "))
}
