# Contributing

## Node.js support

CI builds and tests the SDK on Node.js 22, 24 and 26 LTS. Dependency installs
use npm 11.12.1.
Use Node.js 24 for local development and release tooling. The minimum
workspace version remains Node.js 22.12.0. Maintenance LTS releases remain
supported; end-of-life and Current releases are outside the tested matrix.

See [Node.js support](docs/node-support.md) for installed package checks and
how Node loads imports. On the Node.js 22 line, ESLint 10 requires at least 22.13.0.

This repository is the ECAD-maintained Beacon SDK package line published under
the `@ecadlabs/beacon-*` scope.

## Ground rules

- Open a pull request against `taquito-patches`, do not push feature work
  directly to the branch.
- Keep changes scoped and explain the user-visible impact.
- If you port behavior from a published `octez.connect` release or another
  external source, record that provenance in the commit message and pull request.
- Prefer targeted fixes and tests over bulk syncs from external repos.

## Local workflow

```bash
npm ci
npm run check:versions
npm run build
npm run test
npm run e2e:smoke
```

Use `npm run e2e` when you need the full suite, including the longer reconnect
scenarios that are not part of the required CI smoke gate.

## TypeScript projects

The root `tsconfig.json` supplies shared compiler options and the project for
type-aware lint. Each package builds from `src`. The package `tsconfig.json`
and `tsconfig-cjs.json` emit ESM and CommonJS respectively. Beacon UI uses
Rollup for both formats and `tsconfig.build.json` for production declarations.
Package tests use separate `tsconfig.tests.json` projects. Run
`npm run typecheck` after building to check production, tests and tooling;
`npm run check:typecheck-coverage` verifies file ownership without running the
compiler. The wallet lifecycle typecheck uses
`packages/beacon-wallet/__tests__/tsconfig.typecheck.json` so it can import
shared test fixtures outside the wallet source tree.

## Formatting

Run `npm run format:check` to check formatting without writing files. Run
`npm run format` to apply the installed Prettier version and `.prettierrc` options.
`npm run prettier` remains an alias for the write command and forwards extra flags.

These commands select Prettier-supported repository files, including source,
tests, scripts, examples, configuration and the authored Markdown guides in
`docs/`. Root `.gitignore` and `.prettierignore` exclude generated SDK files and
generator-managed package READMEs, package locks, build output,
coverage, browser reports and minified bundles. The SDK generator is
`npm run prebuild`. `scripts/sync-package-readmes.mjs` owns the package README
scaffolds. Keep formatting changes to generated portions in their generator.

CI checks formatting once, in the Node 24 build job before package compilation.
Keep formatting-only normalization separate from behavior changes.

## Versioning

The workspace root version is the source of truth for the published package
version. Before release, synchronize every workspace package and the Beacon
runtime constant with:

```bash
npm version 4.8.1-ecad.N --no-git-tag-version
npm run version:sync
npm run readmes:sync
npm install --package-lock-only --ignore-scripts
```

## Trusted Publisher releases

Releases are published from GitHub Actions using npm Trusted Publishers. The npm
package settings must point at `.github/workflows/release.yml` in this repo.
Avoid introducing long-lived npm publish tokens back into the workflow.
Prerelease versions publish under the prerelease identifier as the npm dist-tag,
for example `4.8.1-ecad.4` publishes with the `ecad` tag.

## Declaration lint policy

Write explicit accessibility modifiers on class members. Public members keep
public visibility; this policy does not require redesigning existing interfaces.

Keep each pairing type beside its extended variant. The logger adapter and
facade also stay together, as do the WalletConnect error classes. ESLint allows
only their current class counts in those named files. Other files retain the
one-class limit. Splitting these families solely to satisfy the file limit would
scatter the declarations without changing their responsibilities.

## Async callbacks in tests and tooling

The tooling lint gate checks promises passed to void-returning callbacks. Keep spy targets typed
with their real asynchronous method signatures so test gates retain promise ownership.
Rejection-isolation fixtures use explained, local exceptions when they deliberately pass an async
callback through a legacy void contract. Their assertions must still verify rejection handling.
