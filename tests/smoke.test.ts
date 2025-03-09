import { test, describe, afterEach, beforeEach, expect } from "bun:test"
import path from "path"
import {
  TempCleaner,
  createUniqueTempDir,
  createTestSave,
} from "./test-helpers"
import * as fs from "node:fs/promises"
import { stringify } from "yaml"
import { withDefaultConfig } from "../src/config"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

describe("Main App Smoke Test", () => {
  let tempDir: string
  let sourceDir: string
  let savePath: string

  const cleanup = TempCleaner.getInstance()

  beforeEach(async () => {
    tempDir = createUniqueTempDir()
    cleanup.add(tempDir)

    sourceDir = path.join(tempDir, "src")
    savePath = path.join(tempDir, "mc/saves/test_world")

    // Setup test environment
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.mkdir(path.dirname(savePath), { recursive: true })
    await createTestSave(savePath)
  })

  afterEach(async () => {
    // Ensure synchronous cleanup
    try {
      await cleanup.cleanDir(tempDir)
      // Verify directory was actually removed
      const exists = await fs
        .access(tempDir)
        .then(() => true)
        .catch(() => false)

      if (exists) {
        console.warn(`Warning: Failed to clean up test directory ${tempDir}`)
      }
    } catch (err) {
      console.warn(`Error during cleanup: ${err}`)
    } finally {
      //   mock.restore()
    }
  })
  test("app starts without immediate errors", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["1"],
        },
      ],
    })

    const configContent = stringify(configObject)
    await fs.writeFile(configPath, configContent)

    // Get path to the index.ts entry point
    const indexPath = path.join(process.cwd(), "src", "index.ts")

    // Run the app synchronously with a timeout and capture both stdout and stderr
    try {
      await fs.access(indexPath).catch(() => {
        throw new Error(`Entry file not found: ${indexPath}`)
      })

      // Create typed promisified version of exec
      const execAsync = promisify(execFile) as (
        command: string,
        args?: string[],
        options?: {
          cwd?: string
          env?: NodeJS.ProcessEnv
          timeout?: number
        }
      ) => Promise<{ stdout: string; stderr: string }>

      const { stdout, stderr } = await execAsync(
        "bun",
        ["run", indexPath, "--smoke-test"],
        {
          cwd: tempDir,
          env: { ...process.env, NODE_ENV: "test" },
          timeout: 3000,
        }
      )

      // Log the captured output
      //   console.debug("Application stdout:", stdout)
      if (stderr) {
        console.debug("Application stderr:", stderr)
      }

      const containsAny = (text: string, keywords: string[]): boolean =>
        keywords.some((keyword) => text.includes(keyword))

      const errorKeywords = ["error", "unhandled exception", "fatal"]
      expect(containsAny(stdout.toLowerCase(), errorKeywords)).toBe(false)
      expect(containsAny(stderr.toLowerCase(), errorKeywords)).toBe(false)

      // If we get here, it means the command executed without error
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error("Process error (timed out?):", error.message)
        // Try to extract stdout and stderr if they exist on the error object
        const execError = error as Error & { stdout?: string; stderr?: string }
        console.debug("Captured stdout:", execError.stdout || "<empty>")
        console.error("Captured stderr:", execError.stderr || "<empty>")
      } else {
        console.error("Unknown error:", error)
      }
      throw new Error("Application exited with error")
    }
  })
})
