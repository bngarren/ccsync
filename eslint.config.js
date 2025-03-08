import neostandard, { resolveIgnoresFromGitignore, plugins } from "neostandard"
import eslintConfigPrettier from "eslint-config-prettier"

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...neostandard({
    ignores: resolveIgnoresFromGitignore(),
    noStyle: true,
    ts: true,
  }),
  eslintConfigPrettier,
  ...plugins["typescript-eslint"].configs["strictTypeChecked"],
  {
    languageOptions: {
      parser: plugins["typescript-eslint"]["parser"], // Use the TypeScript parser
      parserOptions: {
        project: "./tsconfig.json", // Resolve path using import.meta.url
        tsconfigRootDir: ".",
      },
    },
    rules: {
      "@typescript-eslint/no-deprecated": "warn", // Enable warning for deprecated functions
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-spread": "off",
    },
  },
]
