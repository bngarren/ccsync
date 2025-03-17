import yargs, { type ArgumentsCamelCase } from "yargs"
import { hideBin } from "yargs/helpers"
import { version } from "./version"
import { README_ADDRESS, LOG_LEVELS } from "./constants"
import { type LogLevel } from "./log"

import { initCommand } from "./commands/init.ts"
import { clearScreen } from "./utils.ts"

export type Command = "init" | "computers"

export type ComputerCommand = "find" | "clear"

export interface ParsedArgs {
  verbose: boolean
  logToFile: boolean
  logLevel: LogLevel
  smokeTest: boolean
  _?: Command[]
  computers?: {
    command?: ComputerCommand
    ids?: string
  }
}

// ---- PARSE ARGS (YARGS) ----

/**
 * Parses the command line arguments and returns object with commands and options
 */
export const parseArgs = async (): Promise<{
  parsedArgs: ParsedArgs
  isCommandInvoked: boolean
}> => {
  // Flag to track if a command handler was invoked
  let commandWasInvoked = false

  // Type-safe wrapper for tracking command invocation
  const wrapCommand = <T>(
    handler: (args: ArgumentsCamelCase<T>) => void | Promise<void>
  ) => {
    return (args: ArgumentsCamelCase<T>) => {
      commandWasInvoked = true

      // Skip clearing screen for certain commands to make output easier to read
      if (
        !args._.some((command) => {
          return ["init", "command"].includes(String(command))
        })
      ) {
        clearScreen()
        process.stdout.write("\n\n")
      }

      return handler(args)
    }
  }

  const parsed = (await yargs(hideBin(process.argv))
    .scriptName("ccsync")
    .usage("Usage: $0 [COMMAND] [OPTIONS]")
    .command("$0", "run the program")
    .command({
      ...initCommand,
      handler: wrapCommand(initCommand.handler),
    })
    /* .command(computersCommands) */
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
    .strict(true)
    .showHelpOnFail(false, "Run ccsync --help for available options")
    .epilogue(`for more information, visit ${README_ADDRESS}`)
    .wrap(null)
    .parse()) as ParsedArgs

  return {
    parsedArgs: parsed,
    isCommandInvoked: commandWasInvoked,
  }
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
