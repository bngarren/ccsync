import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { version } from "./version"
import { README_ADDRESS, LOG_LEVELS } from "./constants"
import { type LogLevel } from "./log"

export type Command = "init" | "computers"

export type ComputersCommand = "find" | "clear"

// Interface for what yargs actually returns
interface YargsArguments {
  [x: string]: unknown
  _: string[]
  $0: string
  verbose?: boolean
  logToFile?: boolean
  logLevel?: string
  smokeTest?: boolean
  ids?: (string | number)[] // Capture positional arguments for computers clear command
}

export interface ProcessedArgs {
  verbose?: boolean
  logToFile?: boolean
  logLevel?: LogLevel
  smokeTest?: boolean
  command?: Command
  computersCommand?: ComputersCommand
  computersClearIds?: number[]
  _?: string[]
}

// ---- PARSE ARGS (YARGS) ----

/**
 * Parses the command line arguments and returns object with commands and options
 */
export const parseArgs = async (): Promise<ProcessedArgs> => {
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
      command: "computers",
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
          .command({
            command: "clear [ids..]",
            describe: "- clear the contents of Minecraft computers",
            builder: (yargs) => {
              return yargs
                .positional("ids", {
                  type: "string",
                  desc: "Computer IDs to clear",
                  array: true,
                })
                .example(
                  "$0 computers clear 1 2 3",
                  "Clear computers with IDs 1, 2, and 3"
                )
                .example("$0 computers clear", "Clear all computers")
            },
            handler: () => {},
          })
          .demandCommand(1, "You must specifiy a 'computers' subcommand")
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

  const parsed = (await parser.parse()) as YargsArguments

  // console.debug({ parsed })

  // Extract the primary command and subcommands
  const parsedArgs: ProcessedArgs = {
    verbose: parsed.verbose,
    logToFile: parsed.logToFile,
    logLevel: parsed.logLevel as LogLevel,
    smokeTest: parsed.smokeTest,
    _: parsed._,
  }
  // Extract command using the first command in the array
  if (parsed._.length > 0) {
    const primaryCommand = parsed._[0]
    switch (primaryCommand) {
      case "init":
        parsedArgs.command = "init"
        break

      case "computers":
        parsedArgs.command = "computers"

        // Check for subcommand (should be the second item in the array)
        if (parsed._.length > 1) {
          const subCommand = parsed._[1]
          switch (subCommand) {
            case "find":
              parsedArgs.computersCommand = "find"
              break

            case "clear": {
              parsedArgs.computersCommand = "clear"
              // Handle computer IDs to clear
              // This will capture both space-separated and comma-separated IDs
              // i.e., both "clear 1 2 3" and "clear 1,2,3" work
              const idsToProcess = parsed.ids || []
              if (idsToProcess.length > 0) {
                parsedArgs.computersClearIds = idsToProcess
                  .flatMap((arg) => String(arg).split(","))
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0 && !isNaN(Number(s)))
                  .map(Number)
              } else {
                parsedArgs.computersClearIds = []
              }
              break
            }
          }
        }
        break
    }
  }
  return parsedArgs
}

export function getPrettyParsedArgs(parsedArgs: ProcessedArgs): string {
  const keysToInclude: (keyof ProcessedArgs)[] = [
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
