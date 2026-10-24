import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    // test/fixtures holds scan inputs (e.g. extract's ts-app has a *.test.ts), not tests
    // out/ holds generated QA output and the cloned qa:extract corpus (other projects' *.test.* files)
    exclude: [...configDefaults.exclude, ".claude/**", "test/fixtures/**", "out/**"],
  },
});
