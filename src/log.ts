import { theme } from "./theme"

interface LogConfig {
  verbose?: boolean
}

export interface Logger {
  verbose: (msg: string) => void
  info: (msg: string) => void
  step: (msg: string) => void
  success: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  status: (msg: string) => void
}

export const createLogger = (config?: LogConfig): Logger => ({
  verbose: (msg: string) => {
    if (config?.verbose) {
      console.log(theme.dim(msg))
    }
  },
  info: (msg: string) => console.log(theme.info(msg)),
  step: (msg: string) => console.log(theme.info(msg)),
  success: (msg: string) => console.log(theme.success(`${msg}`)),
  warn: (msg: string) => console.log(theme.warn(`${msg}`)),
  error: (msg: string) => console.log(theme.error(`${msg}`)),
  status: (msg: string) => console.log(theme.accent(msg)),
})
