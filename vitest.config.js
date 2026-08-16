import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // .test.ts added for the gate's verification engine, which is TypeScript.
    // Verifiers are written as pure functions over an injected fetch, so they
    // test under plain Node without a workers runtime.
    include: ['tests/**/*.test.js', 'tests/**/*.test.ts'],
  },
});
