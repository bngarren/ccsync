import { expect, test, describe, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs/promises";
import path from "path";
import { loadConfig } from "../src/config";
import { SyncManager } from "../src/sync";
import {
  TempCleaner,
  createUniqueTempDir,
  createTestSave,
  createTestFiles,
  spyOnClackPrompts,
  createTestComputer,
} from "./test-helpers";
import { testLog } from "./setup";
import { stringify } from "yaml";

describe("Integration: SyncManager", () => {
  let tempDir: string;
  let sourceDir: string;
  let savePath: string;
  let computersDir: string;

  let clackPromptsSpy: ReturnType<typeof spyOnClackPrompts>;
  const cleanup = TempCleaner.getInstance();

  beforeEach(async () => {
    tempDir = createUniqueTempDir();
    cleanup.add(tempDir);

    sourceDir = path.join(tempDir, "src");
    savePath = path.join(tempDir, "mc/saves/test_world");
    computersDir = path.join(savePath, "computercraft/computer");

    // Setup test environment
    await createTestSave(savePath);
    await createTestFiles(sourceDir);

    // Setup @clack/prompts spy
    clackPromptsSpy = spyOnClackPrompts();
  });

  afterEach(async () => {
    await cleanup.cleanDir(tempDir);
    mock.restore();
    clackPromptsSpy.cleanup();
  });

  test("performs manual sync", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml");
    const configObject = {
      sourcePath: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        { source: "program.lua", target: "/program.lua", computers: ["1"] },
      ],
    };

    const configContent = stringify(configObject);

    await fs.writeFile(configPath, configContent);
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true });

    const config = await loadConfig(configPath);
    const syncManager = new SyncManager(config);

    // Start manual mode and wait for first sync
    return new Promise<void>(async (resolve, reject) => {
      try {
        const manualLoop = await syncManager.startManualMode();

        manualLoop.on("syncComplete", async ({ successCount }) => {
          try {
            const targetFile = path.join(computersDir, "1", "program.lua");
            expect(await fs.exists(targetFile)).toBe(true);
            expect(successCount).toBe(1);
            await manualLoop.stop();
            syncManager.stop();
            resolve();
          } catch (err) {
            syncManager.stop();
            reject(err);
          }
        });

        manualLoop.on("syncError", (error) => {
          syncManager.stop();
          reject(error);
        });
      } catch (err) {
        syncManager.stop();
        reject(err);
      }
    });
  });

  test("handles file changes in watch mode", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml");
    const configObject = {
      sourcePath: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["1", "2"],
        }
      ],
      advanced: {
        verbose: true,
      },
    };
  
    const configContent = stringify(configObject);
    await fs.writeFile(configPath, configContent);
  
    // Create target computers
    await createTestComputer(computersDir, "1")
    await createTestComputer(computersDir, "2")
  
    const config = await loadConfig(configPath);
    const syncManager = new SyncManager(config);
  
    return new Promise<void>(async (resolve, reject) => {
      try {
        const watchController = await syncManager.startWatchMode();
        
        // Track test phases
        let initialSyncCompleted = false;
        let fileChangeDetected = false;
        let fileChangeSynced = false;
  
        // Listen for initial sync completion
        watchController.on("initialSyncComplete", async ({ successCount, errorCount, missingCount }) => {
          try {
            initialSyncCompleted = true;
            
            // Verify initial sync results
            expect(successCount).toBe(2); // Both computers synced
            expect(errorCount).toBe(0);
            expect(missingCount).toBe(0);
  
            // Verify files were copied
            expect(await fs.exists(path.join(computersDir, "1", "program.lua"))).toBe(true);
            expect(await fs.exists(path.join(computersDir, "2", "program.lua"))).toBe(true);
  
            // Modify source file to trigger watch
            await fs.writeFile(
              path.join(sourceDir, "program.lua"),
              "print('Updated')"
            );
            fileChangeDetected = true;
          } catch (err) {
            reject(err);
          }
        });
  
        // Listen for file change sync
        watchController.on("fileSync", async ({ path: changedPath, successCount, errorCount, missingCount }) => {
          if (!initialSyncCompleted || !fileChangeDetected || fileChangeSynced) {
            return; // Only handle the first file change after initial sync
          }
  
          try {
            fileChangeSynced = true;
  
            // Verify sync results
            expect(successCount).toBe(2);
            expect(errorCount).toBe(0);
            expect(missingCount).toBe(0);
            expect(changedPath).toContain("program.lua");
  
            // Verify updated content was copied
            const content1 = await fs.readFile(path.join(computersDir, "1", "program.lua"), "utf8");
            const content2 = await fs.readFile(path.join(computersDir, "2", "program.lua"), "utf8");
            expect(content1).toBe("print('Updated')");
            expect(content2).toBe("print('Updated')");
  
            // Test complete
            await syncManager.stop();
            resolve();
          } catch (err) {
            reject(err);
          }
        });
  
        // Handle errors
        watchController.on("fileSyncError", ({ path, error }) => {
          reject(new Error(`File sync error for ${path}: ${error}`));
        });
  
        watchController.on("watcherError", (error) => {
          reject(new Error(`Watcher error: ${error}`));
        });
  
        // Set timeout for test
        const timeout = setTimeout(() => {
          syncManager.stop();
          reject(new Error("Test timeout - watch events not received"));
        }, 5000);
  
        // Clean up timeout on success
        process.once("beforeExit", () => clearTimeout(timeout));
      } catch (err) {
        reject(err);
      }
    });
  });
});
