import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { version } from "./version"
import { README_ADDRESS, LOG_LEVELS } from "./constants"
import { type LogLevel } from "./log"

export type Command = "init" | "computers"

export type ComputersCommand = "find" | "clear"

export interface ParsedArgs {
  verbose?: boolean
  logToFile?: boolean
  logLevel?: LogLevel
  smokeTest?: boolean
  command?: string
  computersCommand?: ComputersCommand
  _?: Command[]
}

// ---- PARSE ARGS (YARGS) ----

/**
 * Parses the command line arguments and returns object with commands and options
 */
export const parseArgs = async (): Promise<ParsedArgs> => {
  const parser = yargs(hideBin(process.argv))
    .scriptName("ccsync")
    .usage("Usage: $0 [COMMAND] [OPTIONS]")
    .command("$0", "- run the program")
    .command({
      command: "init",
      describe: "- initialize a new config (or overwrite current)",
      handler: () => {
        // Just capture the command, don't run logic
      },
    })
    .command({
      command: "computers <find|clear>",
      describe: "- computer related commands",
      builder: (yargs) => {
        return yargs
          .command({
            command: "find",
            describe:
              "- identify Minecraft computers in the current save directory",
            handler: () => {
              // Just capture the command, don't run logic
            },
          })
          .demandCommand(1, "You must specifiy a 'computers' subcommand")
        // Add other computer commands as needed
      },
      handler: () => {
        // Just capture the command, don't run logic
      },
    })
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
    .version(version)
    .alias("version", "V")
    .strict(true)
    .showHelpOnFail(false, "Run ccsync --help for available options")
    .epilogue(`for more information, visit ${README_ADDRESS}`)
    .wrap(null)
    .help()
    .alias("help", "h")

  const parsed = await parser.parse()

  // Extract the primary command and computer subcommand
  const parsedArgs: ParsedArgs = {
    verbose: parsed.verbose,
    logToFile: parsed.logToFile,
    logLevel: parsed.logLevel as LogLevel,
    smokeTest: parsed.smokeTest,
    _: parsed._ as Command[],
  }

  // Extract command and sub-command
  if (parsed._.includes("init")) {
    parsedArgs.command = "init"
  } else if (parsed._.includes("computers")) {
    parsedArgs.command = "computers"
    // Get the computer subcommand (assuming it comes right after 'computers')
    const computerCommandIndex = parsed._.indexOf("computers") + 1
    if (parsed._[computerCommandIndex] === "find") {
      parsedArgs.computersCommand = "find"
    }
  }

  return parsedArgs
}

export function getPrettyParsedArgs(parsedArgs: ParsedArgs): string {
  const keysToInclude: (keyof ParsedArgs)[] = [
    "verbose",
    "logToFile",
    "logLevel",
  ]

  const formattedArgs = keysToInclude
    .filter((key) => parsedArgs[key] != null)
    .map((key) => `${key}=${JSON.stringify(parsedArgs[key])}`)
    .join(" ")

  const commands = parsedArgs._?.length ? parsedArgs._.join(" ") + " " : ""

  return commands + formattedArgs
}
