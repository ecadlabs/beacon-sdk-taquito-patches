# Contributing

## Node.js support

CI builds and tests the SDK on Node.js 22, 24 and 26 LTS. Dependency installs
use npm 11.12.1.
Use Node.js 24 for local development and release tooling. The minimum
workspace version remains Node.js 22.12.0. Maintenance LTS releases remain
supported; end-of-life and Current releases are outside the tested matrix.

See [Node.js support](docs/node-support.md) for installed package checks and
how Node loads imports.

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
