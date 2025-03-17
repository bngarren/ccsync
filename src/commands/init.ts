import * as p from "@clack/prompts"
import { findConfig, createDefaultConfig } from "../config.js"
import { theme } from "../theme.js"
import type { CommandModule } from "yargs"

export const initCommand: CommandModule<unknown, unknown> = {
  command: "init",
  describe: "Initialize a new config (or overwrite current)",
  builder: (yargs) => {},
  handler: async (args) => {
    // Check if config already exists
    const configs = await findConfig()
    if (configs.length > 0) {
      // Config already exists
      const overwrite = await p.confirm({
        message: theme.warning(
          `Configuration file already exists at ${configs[0].path}. Overwrite?`
        ),
        initialValue: false,
        inactive: "Cancel",
      })

      if (p.isCancel(overwrite) || !overwrite) {
        p.outro("Config creation cancelled.")
      }
    }

    await createDefaultConfig(process.cwd())
    p.log.success(`Created default config at ${process.cwd()}/.ccsync.yaml`)
    p.log.info("Please edit the configuration file and run the program again.")
  },
}
