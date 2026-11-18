import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import importPlugin from 'eslint-plugin-import-x'
import globals from 'globals'

const root = import.meta.dirname
const dependencyRule = (packageDir) => ['error', { devDependencies: true, packageDir }]

// Tests and tools need correctness checks without the production style/mock policy.
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/src/**',
      '**/coverage/**',
      'examples/**',
      'docs/**',
      'webpack_builds/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'e2e/output/**'
    ]
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: { globals: { ...globals.es2021, ...globals.node } },
    plugins: { import: importPlugin },
    rules: {
      'constructor-super': 'error',
      'no-async-promise-executor': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': 'error',
      'no-debugger': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-duplicate-imports': 'error',
      'no-empty-character-class': 'error',
      'no-empty-pattern': 'error',
      'no-ex-assign': 'error',
      'no-fallthrough': 'error',
      'no-invalid-regexp': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-prototype-builtins': 'error',
      'no-self-assign': 'error',
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-useless-backreference': 'error',
      'require-yield': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'import/no-extraneous-dependencies': dependencyRule([root])
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser }
  },
  {
    files: ['**/*.{ts,tsx}'],
    // These files contain compiler-only calls and never run as tests.
    ignores: ['**/type-fixtures/**', 'test-fixtures/client-options/**'],
    languageOptions: { parserOptions: { project: './tsconfig.json', tsconfigRootDir: root } },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error'
    }
  },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: { sourceType: 'commonjs' }
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: { 'no-undef': 'error' }
  },
  {
    files: ['packages/*/__tests__/**/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'it',
          'test',
          'expect',
          'describe',
          'vi',
          'beforeEach',
          'afterEach',
          'beforeAll',
          'afterAll'
        ].map((name) => [name, 'readonly'])
      )
    }
  },
  {
    // This consumer test exercises the SDK's own package exports.
    files: ['packages/beacon-sdk/__tests__/node-import.test.mjs'],
    settings: { 'import-x/internal-regex': '^@ecadlabs/beacon-sdk(?:/|$)' }
  },
  ...readdirSync(resolve(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      files: [`packages/${entry.name}/**/*.{js,mjs,cjs,ts,tsx}`],
      rules: {
        'import/no-extraneous-dependencies': dependencyRule([
          resolve(root, 'packages', entry.name),
          root
        ])
      }
    }))
]
