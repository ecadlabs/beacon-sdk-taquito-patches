# Typecheck coverage

`npm run typecheck` checks parsed target ownership, then runs the production,
test and tooling projects with `--noEmit`. The named groups can also run as
`typecheck:production`, `typecheck:tests` and `typecheck:tooling`.
Run the normal package build first so workspace declaration dependencies exist.
The checks use the root's pinned TypeScript compiler.

The canonical `getWorkspacePackages()` catalog owns the required production
projects. Every catalogued package must have a `tsconfig.json`; deleting a config
fails coverage rather than removing that package from the inventory.
These projects select source files and do not provide Vitest globals. The UI source config matches the
source-only selection already used by Rollup; test files belong to its separate
test config. Production emit targets, module formats and output paths are
unchanged by the no-emit checks.

The nine packages with Vitest tests have `tsconfig.tests.json`. Each selects
its tests, helpers, compiler-only fixtures, setup file where needed and source ambient
declarations. They provide Vitest, Node and Chrome types, use bundler resolution,
and preserve strict mode and both unused-code checks. Their ES2024 library
models the supported Node 22+ test runtime, including `Promise.withResolvers`;
it does not change the production browser target. Cross-package helpers can be
imported without placing them under a production `rootDir`.

All targets check declaration files. Six packages no longer load unused DOM
matcher setup files. Their tests use Vitest's own matchers; utilities retain
their crypto setup and UI retains its required DOM matchers.

The shared DOM matcher setup imports
jest-dom's standalone matchers and extends Vitest's public `Matchers` interface.
The package's `/vitest` augmentation currently declares a one-parameter
`Assertion`, incompatible with Vitest 5's two-parameter declaration. Using the
standalone integration preserves the same runtime `expect.extend` registration
without skipping declaration diagnostics. The root compatibility project owns
this shared test helper.

| Project                | Ownership and environment                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `tsconfig.tools.json`  | UI Vite TS config; ES modules, bundler resolution, Node types                                           |
| `tsconfig.e2e.json`    | Playwright configuration, browser tests and e2e helpers; NodeNext resolution, Node/Chrome types and DOM |
| `tsconfig.server.json` | Legacy `server.ts`; NodeNext resolution and Node types                                                  |
| `tsconfig.compat.json` | Root compatibility fixtures and shared test helpers; Node/Chrome types                                  |

These tooling projects have no Vitest globals. Compiler-backed negative tests
still run through their existing test cases, including the narrow Wallet
lifecycle typecheck. The broad no-emit targets also own the tracked negative
fixtures; do not exclude them to obtain a passing check.

`npm run check:typecheck-coverage` parses the actual configs and rejects missing,
invalid or empty targets and TypeScript files without target ownership. It scans
the working tree, including untracked `.ts`, `.tsx`, `.mts` and `.cts` files;
importing a file does not establish root ownership. It excludes production
`packages/*/src` from this nonproduction inventory, and ignores dependency,
generated build, coverage and browser-report directories:
`node_modules`, `dist`, `.git`, `webpack_builds`, `coverage`, `test-results`
and `playwright-report`. New intended tests or tooling need a parsed target,
even when their runtime test runner already discovers them.

Package Vitest configs are `.mjs` after #268. They remain under lint and
runtime checks, outside these TypeScript targets.

JavaScript scripts, tests, config files and mocks are explicitly outside this
static typecheck policy: `allowJs` and `checkJs` are false in the new targets.
Their existing lint and runtime checks still apply. In particular, checking
`server.ts` does not typecheck the JavaScript helper it loads with `require`.

The async tooling lint profile uses these same projects to resolve test and
tooling types. Compiler-only negative fixtures keep their existing scoped lint
policy; ordinary tests retain promise/await checks.

These targets use TypeScript 6.0.3 after the compiler/configuration migration
in #249. No deprecation bypass is used. New package tests and authored
TypeScript under docs/ must have an explicit target owner.

The UI test project includes Vite's client asset declarations. Vite is also an
explicit root development dependency at the UI-compatible version so the React
plugin and the UI dev configuration share one type owner. The dev configuration
keeps its normal `vite` import; no Vitest-specific configuration helper is used.
