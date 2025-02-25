// tests/version.test.ts
import { expect, test, describe, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "path"
import {
  loadConfig,
  DEFAULT_CONFIG,
  CONFIG_VERSION,
  ConfigErrorCategory,
} from "../src/config"
import { createUniqueTempDir, TempCleaner, writeConfig } from "./test-helpers"
import yaml from "yaml"

describe("Version compatibility", () => {
  const tempCleaner = TempCleaner.getInstance()
  let tempDir: string
  let configPath: string

  beforeEach(async () => {
    tempDir = createUniqueTempDir()
    tempCleaner.add(tempDir)
    await mkdir(tempDir, { recursive: true })
    configPath = path.join(tempDir, ".ccsync.yaml")
  })

  afterEach(async () => {
    await tempCleaner.cleanDir(tempDir)
  })

  test("accepts valid config version", async () => {
    await writeConfig(configPath)
    const { config, errors } = await loadConfig(configPath, {
      skipPathValidation: true,
    })
    expect(errors).toHaveLength(0)
    expect(config?.version).toBe(CONFIG_VERSION)
  })

  test("rejects incompatible major version", async () => {
    await writeConfig(configPath, { version: "2.0" })
    const { config, errors } = await loadConfig(configPath)

    expect(errors).toHaveLength(1)
    expect(errors[0].category).toBe(ConfigErrorCategory.VERSION)
    expect(errors[0].message).toContain(
      `Config version ${CONFIG_VERSION} is required`
    )
    expect(config).toBeNull()
  })

  test("rejects missing version", async () => {
    const { version, ...configWithoutVersion } = DEFAULT_CONFIG
    await writeFile(configPath, yaml.stringify(configWithoutVersion))

    const { config, errors } = await loadConfig(configPath)

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("Config version is required")
    expect(config).toBeNull()
  })
})
