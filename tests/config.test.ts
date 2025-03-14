import { expect, test, describe, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "path"
import {
  loadConfig,
  DEFAULT_CONFIG,
  findCircularGroupReferences,
  ConfigErrorCategory,
} from "../src/config"
import { createUniqueTempDir, TempCleaner } from "./test-helpers"
import yaml, { parse } from "yaml"

describe("Computer Group", () => {
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

  async function writeConfig(
    configChanges: Partial<typeof DEFAULT_CONFIG> = {}
  ) {
    const config = { ...DEFAULT_CONFIG, ...configChanges }
    await writeFile(configPath, yaml.stringify(config))
  }

  test("detects direct circular references", () => {
    const groups = {
      servers: {
        name: "Servers",
        computers: ["1", "2", "clients"],
      },
      clients: {
        name: "Clients",
        computers: ["3", "4", "servers"],
      },
    }

    const result = findCircularGroupReferences(groups)
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain("servers")
    expect(result).toContain("clients")
  })

  test("detects indirect circular references", () => {
    const groups = {
      webservers: {
        name: "Web Servers",
        computers: ["1", "2", "databases"],
      },
      databases: {
        name: "Database Servers",
        computers: ["3", "4", "monitors"],
      },
      monitors: {
        name: "Monitoring Servers",
        computers: ["5", "6", "webservers"],
      },
    }

    const result = findCircularGroupReferences(groups)
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBe(3) // All three groups in the cycle
  })

  test("returns empty array for no circular references", () => {
    const groups = {
      webservers: {
        name: "Web Servers",
        computers: ["1", "2", "databases"],
      },
      databases: {
        name: "Database Servers",
        computers: ["3", "4"],
      },
      monitors: {
        name: "Monitoring Servers",
        computers: ["5", "6"],
      },
    }

    const result = findCircularGroupReferences(groups)
    expect(result.length).toBe(0)
  })

  test("handles groups with numeric IDs correctly", () => {
    // This test ensures that computer IDs that look like numbers
    // don't cause false positives
    const groups = {
      "1": {
        name: "Group 1",
        computers: ["1", "2", "3"],
      },
      "2": {
        name: "Group 2",
        computers: ["4", "5", "1"], // References computer ID "1", not group "1"
      },
    }

    const result = findCircularGroupReferences(groups)
    expect(result.length).toBe(0)
  })

  test("config validation detects circular references", async () => {
    // Create a config with circular references
    await writeConfig({
      computerGroups: {
        servers: {
          name: "Servers",
          computers: ["1", "2", "clients"],
        },
        clients: {
          name: "Clients",
          computers: ["3", "4", "servers"],
        },
      },
    })

    const { errors } = await loadConfig(configPath, {
      skipPathValidation: true,
    })

    expect(errors.length).toBeGreaterThan(0)
    // Find the specific error
    const circularRefError = errors.find(
      (e) =>
        e.category === ConfigErrorCategory.COMPUTER &&
        e.message.includes("Circular references")
    )

    expect(circularRefError).toBeDefined()
    expect(circularRefError?.suggestion).toContain("Remove circular references")
  })
})

describe("YAML Config Parsing for Paths", () => {
  test("correctly parses POSIX paths", () => {
    const yamlWithPosixPath = `path: /home/user/directory`
    const parsed = parse(yamlWithPosixPath) as { path: string }
    expect(parsed.path).toBe("/home/user/directory")
  })

  test("correctly parses Windows paths", () => {
    // If Windows backslashes are put in quotes, you would have to double them
    const yamlWithWindowsPath = String.raw`path: "C:\\Users\\name\\Documents"`
    const parsed = parse(yamlWithWindowsPath) as { path: string }
    expect(parsed.path).toBe(String.raw`C:\Users\name\Documents`)
  })

  test("handles unquoted Windows paths with double backslashes", () => {
    // Without quotes, YAML may interpret backslashes
    // (this test confirms actual behavior)
    const yamlWithUnquotedWindowsPath = String.raw`path: C:\Users\name\Documents`
    const parsed = parse(yamlWithUnquotedWindowsPath) as { path: string }
    expect(parsed.path).toBe(String.raw`C:\Users\name\Documents`)
  })

  test("handles paths with special characters", () => {
    const yamlWithSpecialChars = `path: "/path with spaces/and-special_chars/"`
    const parsed = parse(yamlWithSpecialChars) as { path: string }
    expect(parsed.path).toBe("/path with spaces/and-special_chars/")
  })
})
