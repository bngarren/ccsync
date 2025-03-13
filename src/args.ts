import * as p from "@clack/prompts"
import { findConfig, createDefaultConfig } from "./config"
import { theme } from "./theme"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { version } from "./version"
import { README_ADDRESS, LOG_LEVELS } from "./constants"
import { type LogLevel } from "./log"

export type Command = "init"

export interface ParsedArgs {
  verbose: boolean
  logToFile: boolean
  logLevel: LogLevel
  smokeTest: boolean
  _?: Command[]
}

// ---- PARSE ARGS (YARGS) ----

/**
 * Parses the command line arguments and returns object with commands and options
 */
export const parseArgs = (): ParsedArgs => {
  return yargs(hideBin(process.argv))
    .scriptName("ccsync")
    .usage("Usage: $0 [COMMAND] [OPTIONS]")
    .command("$0", "run the program")
    .command(["init"], "create a config file")
    .option("verbose", {
      alias: "v",
      type: "boolean",
      description: "run with verbose output (for debugging)",
    })
    .option("logToFile", {
      alias: "f",
      type: "boolean",
      description: "log to file (overrides config)",
    })
    .option("logLevel", {
      alias: "l",
      type: "string",
      description: "log level (overrides config)",
      choices: LOG_LEVELS,
      requiresArg: true,
    })
    .option("smokeTest", {
      hidden: true,
      type: "boolean",
      alias: "smoke-test",
    })
    .help()
    .alias("help", "h")
    .version(version)
    .alias("version", "V")
    .strict()
    .showHelpOnFail(false, "Run ccsync --help for available options")
    .epilogue(`for more information, visit ${README_ADDRESS}`)
    .wrap(null)
    .parse() as ParsedArgs
}

export function getPrettyParsedArgs(parsedArgs: ParsedArgs): string {
  const keysToInclude: (keyof ParsedArgs)[] = [
    "verbose",
    "logToFile",
    "logLevel",
  ]

  const formattedArgs = keysToInclude
    .filter((key) => parsedArgs[key] != null)
    .map((key) => `${key}=${parsedArgs[key]}`)
    .join(" ")

  const commands = parsedArgs._?.length ? parsedArgs._.join(" ") + " " : ""

  return commands + formattedArgs
}

// ---- COMMANDS ----

/**
 * Runs handler for command present in the parsed args
 * @param parsedArgs
 */
export function handleCommands(parsedArgs: ParsedArgs): Promise<void> {
  if (parsedArgs._?.includes("init")) {
    return handleInitCommand()
  }
  return Promise.resolve()
}

async function handleInitCommand(): Promise<void> {
  // p.intro(`${color.cyanBright(`CC: Sync`)} v${version}`)

  // Check if config already exists
  const configs = await findConfig()
  if (configs.length > 0) {
    // Config already exists
    const overwrite = await p.confirm({
      message: theme.warn(
        `Configuration file already exists at ${configs[0].path}. Overwrite?`
      ),
      initialValue: false,
      inactive: "Cancel",
    })

    if (p.isCancel(overwrite) || !overwrite) {
      p.outro("Config creation cancelled.")
      process.exit(0)
    }
  }

  await createDefaultConfig(process.cwd())
  p.log.success(`Created default config at ${process.cwd()}/.ccsync.yaml`)
  p.log.info("Please edit the configuration file and run the program again.")
  process.exit(0)
}
