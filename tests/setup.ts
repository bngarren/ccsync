import { beforeAll, afterAll } from "bun:test";

import { mock } from "bun:test";

// Store original console.log
export const testLog = console.log;

mock.module("../src/log", () => ({
  createLogger: () => ({
    verbose: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    status: () => {},
  }),
}));

beforeAll(() => {
   // console.log = mock(() => {}); 
});

afterAll(() => {
  // global teardown
  mock.restore()

  // Restore original console.log
  console.log = testLog;
});