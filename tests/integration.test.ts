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
} from "./test-helpers";
import { testLog } from "./setup";
import { stringify } from 'yaml';

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
    const configContent = `
  sourcePath: "${sourceDir}"
  minecraftSavePath: "${savePath}"
  files:
    - source: "program.lua"
      target: "/program.lua"
      computers: ["1"]
  `;
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

  test.skip("watch mode syncs on file changes", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml");
    const configContent = `
  sourcePath: "${sourceDir}"
  minecraftSavePath: "${savePath}"
  files:
    - source: "*.lua"
      target: "/"
      computers: ["1", "2"]
  `;
    await fs.writeFile(configPath, configContent);
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true });
    await fs.mkdir(path.join(computersDir, "2"), { recursive: true });

    const config = await loadConfig(configPath);
    const syncManager = new SyncManager(config);

    // DEBUG Verify source files exist before starting
    // const sourceFiles = await fs.readdir(sourceDir);
    // testLog("Source files:", sourceFiles);

    return new Promise<void>(async (resolve, reject) => {
      try {
        const watchLoop = await syncManager.startWatchMode();

        // First wait for initial sync to complete
        watchLoop.once("initialSyncComplete", async ({ successCount, errorCount, missingCount }) => {
          try {
            testLog(`Initial sync complete - Success: ${successCount}, Errors: ${errorCount}, Missing: ${missingCount}`)
            // Verify initial sync - check all files were copied
            for (const computer of ["1", "2"]) {
                // DEBUG
                const computerPath = path.join(computersDir, computer);
                const files = await fs.readdir(computerPath);
                testLog(`Files in computer ${computer}:`, files)
              expect(
                await fs.exists(
                  path.join(computersDir, computer, "program.lua")
                )
              ).toBe(true);
              expect(
                await fs.exists(
                  path.join(computersDir, computer, "startup.lua")
                )
              ).toBe(true);
              expect(
                await fs.exists(
                  path.join(computersDir, computer, "lib/utils.lua")
                )
              ).toBe(true);
            }
            expect(successCount).toBe(2); // Both computers synced

            // Listen for the file sync event
            watchLoop.once(
              "fileSync",
              async ({ path: syncedPath, successCount }) => {
                try {
                  expect(path.basename(syncedPath)).toBe("newfile.lua");
                  expect(successCount).toBe(2); // Both computers synced

                  // Verify new file was copied to both computers
                  expect(
                    await fs.exists(path.join(computersDir, "1", "newfile.lua"))
                  ).toBe(true);
                  expect(
                    await fs.exists(path.join(computersDir, "2", "newfile.lua"))
                  ).toBe(true);

                  // Verify file contents
                  const computer1Content = await fs.readFile(
                    path.join(computersDir, "1", "newfile.lua"),
                    "utf8"
                  );
                  const computer2Content = await fs.readFile(
                    path.join(computersDir, "2", "newfile.lua"),
                    "utf8"
                  );
                  expect(computer1Content).toBe("print('new file')");
                  expect(computer2Content).toBe("print('new file')");

                  // Clean up
                  await watchLoop.stop();
                  await syncManager.stop();
                  resolve();
                } catch (err) {
                  await syncManager.stop();
                  reject(err);
                }
              }
            );

            // Create a new file to trigger watch sync
            const newFilePath = path.join(sourceDir, "newfile.lua");
            await fs.writeFile(newFilePath, "print('new file')");

            // Handle any sync errors
            watchLoop.once("fileSyncError", async (error) => {
              await syncManager.stop();
              reject(error);
            });
          } catch (err) {
            await syncManager.stop();
            reject(err);
          }
        });

        // Handle initial sync errors
        watchLoop.once("initialSyncError", async (error) => {
          await syncManager.stop();
          reject(error);
        });
      } catch (err) {
        await syncManager.stop();
        reject(err);
      }
    });
  });

  // DEBUG TEST

  test.only("watch mode syncs on file changes", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml");
    const configObject = {
        sourcePath: sourceDir,
        minecraftSavePath: savePath,
        files: [
          {
            source: "program.lua",
            target: "program.lua",
            computers: ["1", "2"]
          },
          {
            source: "startup.lua",
            target: "startup.lua",
            computers: ["1", "2"]
          },
          {
            source: "lib/*.lua",
            target: "lib/",
            computers: ["1", "2"]
          }
        ],
        advanced: {
          verbose: true
        }
      };
    
      const configContent = stringify(configObject);
      await fs.writeFile(configPath, configContent);
    
    // Create computer directories
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true });
    await fs.mkdir(path.join(computersDir, "2"), { recursive: true });
  
    // Verify source file creation
    await createTestFiles(sourceDir);
    
    // Log directory structure before sync
    const checkDir = async (dir: string, indent = ''): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        testLog(`${indent}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory()) {
          await checkDir(path.join(dir, entry.name), indent + '  ');
        }
      }
    };
  
    testLog('Source directory structure:');
    await checkDir(sourceDir);
  
    const config = await loadConfig(configPath);
    testLog('Config loaded:', {
      sourcePath: config.sourcePath,
      minecraftSavePath: config.minecraftSavePath,
      files: config.files
    });
  
    // Validate the setup
    testLog('Verifying computers directory exists:', await fs.exists(computersDir));
    testLog('Verifying computer 1 directory exists:', await fs.exists(path.join(computersDir, "1")));
    testLog('Verifying computer 2 directory exists:', await fs.exists(path.join(computersDir, "2")));
  
    const syncManager = new SyncManager(config);
  
    return new Promise<void>(async (resolve, reject) => {
      try {
        const watchLoop = await syncManager.startWatchMode();
  
        watchLoop.on('syncValidation', (validation) => {
          testLog('Validation result:', {
            resolvedFiles: validation.resolvedFiles.map(f => ({
              sourcePath: f.sourcePath,
              targetPath: f.targetPath,
              computers: f.computers
            })),
            targetComputers: validation.targetComputers.map(c => c.id),
            missingComputerIds: validation.missingComputerIds,
            errors: validation.errors
          });
        });
  
        // First wait for initial sync to complete
        watchLoop.once('initialSyncComplete', async ({ successCount, errorCount, missingCount }) => {
          try {
            testLog(`Initial sync complete - Success: ${successCount}, Errors: ${errorCount}, Missing: ${missingCount}`);
            
            // Check computer directories after sync
            testLog('Computer 1 directory after sync:');
            await checkDir(path.join(computersDir, "1"));
            testLog('Computer 2 directory after sync:');
            await checkDir(path.join(computersDir, "2"));
            
            // Verify initial sync - check all files were copied
            for (const computer of ["1", "2"]) {
              const computerPath = path.join(computersDir, computer);
              testLog(`Checking files in computer ${computer}`);
              
              const programPath = path.join(computerPath, "program.lua");
              const startupPath = path.join(computerPath, "startup.lua");
              const utilsPath = path.join(computerPath, "lib", "utils.lua");
              
              // Check directories exist
              await fs.mkdir(path.join(computerPath, "lib"), { recursive: true });
              
              testLog(`Checking paths:
                program.lua: ${programPath} (exists: ${await fs.exists(programPath)})
                startup.lua: ${startupPath} (exists: ${await fs.exists(startupPath)})
                lib/utils.lua: ${utilsPath} (exists: ${await fs.exists(utilsPath)})
              `);
              
              expect(await fs.exists(programPath)).toBe(true);
              expect(await fs.exists(startupPath)).toBe(true);
              expect(await fs.exists(utilsPath)).toBe(true);
            }
            
            // ... rest of the test remains the same
          } catch (err) {
            testLog('Error during file verification:', err);
            await syncManager.stop();
            reject(err);
          }
        });
  
        watchLoop.once('initialSyncError', async (error) => {
          testLog('Initial sync error:', error);
          await syncManager.stop();
          reject(error);
        });
  
        // Add error handlers for more specific errors
        watchLoop.on('error', (error) => {
          testLog('Watch loop error:', error);
        });
  
        watchLoop.on('validationError', (error) => {
          testLog('Validation error:', error);
        });
  
        watchLoop.on('syncError', (error) => {
          testLog('Sync error:', error);
        });
  
      } catch (err) {
        testLog('General error:', err);
        await syncManager.stop();
        reject(err);
      }
    });
  });
});
