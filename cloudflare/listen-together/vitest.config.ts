import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['cloudflare/listen-together/**/*.test.mjs'], testTimeout: 20000, hookTimeout: 30000 } });
