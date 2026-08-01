import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./tests/globalSetup.ts",
    fileParallelism: false, // كلهم بيشتركوا بنفس قاعدة البيانات
    testTimeout: 15000,
  },
});