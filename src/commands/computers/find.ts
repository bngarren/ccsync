import * as p from "@clack/prompts"
import type { Argv } from "yargs"
import type { CommandHandler, ParsedArgs } from "../../args"
import { initConfig, presentConfigErrors } from "../../index.ts"
import { getLogger, initializeLogger } from "../../log"

export const command = "find"
export const desc = "Find computers in the Minecraft save directory"

export const builder = (args: Argv) => {
  return args
}

export const handler: CommandHandler = async (argv: ParsedArgs) => {
  console.debug(argv)

  const { config, errors } = await initConfig(argv)

  if (errors.length > 0) {
    presentConfigErrors(errors, argv.verbose)
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

  const log = getLogger().child({ component: "CLI" })

  log.info("Running 'Computers > Find' command")
  process.exit(0)
}
