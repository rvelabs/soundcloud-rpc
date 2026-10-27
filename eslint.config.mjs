import { defineConfig } from 'eslint/config';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import { FlatCompat } from '@eslint/eslintrc';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});
export default defineConfig([
    {
        ignores: ['build*/**', 'release-source*/**', 'tsc/**', 'node_modules/**'],
    },
    {
        extends: compat.extends(
            'eslint:recommended',
            'plugin:@typescript-eslint/eslint-recommended',
            'plugin:@typescript-eslint/recommended',
        ),
        plugins: {
            '@typescript-eslint': typescriptEslint,
        },
        languageOptions: {
            parser: tsParser,
        },
        rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
    },
    {
        files: ['src/header/*.js', 'src/wave/*.js', 'src/settings/*.js'],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ['src/**/*.test.js'],
        languageOptions: { globals: { ...globals.node, Request: 'readonly' } },
    },
    {
        files: ['src/main.ts', 'src/network/cloudflareGateway.ts'],
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
]);
