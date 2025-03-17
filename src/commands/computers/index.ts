import { type Argv } from "yargs"
import { type ParsedArgs } from "../../args"
import * as findCommand from "./find"

export const command = "computers <command>"
export const desc = "Manage computers in the Minecraft save directory"

export const builder = (args: Argv) => {
  return (
    args
      .command(findCommand)
      // .command(require("./clear"))
      .demandCommand(1, "You must specify a subcommand")
  )
}

export const handler = (argv: any) => {
  // Main command doesn't need a handler as it uses subcommands
}
