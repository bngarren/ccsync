import neostandard, { resolveIgnoresFromGitignore } from "neostandard"
import eslintConfigPrettier from "eslint-config-prettier"

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...neostandard({
    ignores: resolveIgnoresFromGitignore(),
    noStyle: true,
    ts: true,
  }),
  eslintConfigPrettier,
]
