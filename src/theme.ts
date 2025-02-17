import color from "picocolors";

export const theme = {
  success: (s: string) => color.green(s),
  warn: (s: string) => color.yellow(s),
  error: (s: string) => color.red(s),
  info: (s: string) => color.cyan(s),
  accent: (s: string) => color.magentaBright(s),
  dim: (s: string) => color.dim(s),
  bold: (s: string) => color.bold(s),
  gray: (s: string) => color.gray(s)
};
