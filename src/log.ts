import * as p from "@clack/prompts";
import { theme } from "./theme";

interface LogConfig {
  verbose?: boolean;
}

export interface Logger {
  verbose: (msg: string) => void;
  info: (msg: string) => void;
  step: (msg: string) => void;
  success: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  status: (msg: string) => void;
}

export const createLogger = (config?: LogConfig): Logger => ({
  verbose: (msg: string) => {
    if (config?.verbose) {
      p.log.info(theme.dim(msg));
    }
  },
  info: (msg: string) => p.log.info(theme.info(msg)),
  step: (msg: string) => p.log.step(theme.info(msg)),
  success: (msg: string) => p.log.success(theme.success(`${msg}`)),
  warn: (msg: string) => p.log.warn(theme.warn(`${msg}`)),
  error: (msg: string) => p.log.error(theme.error(`${msg}`)),
  status: (msg: string) => p.log.info(theme.accent(msg)),
});
