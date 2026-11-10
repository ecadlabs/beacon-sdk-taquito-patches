# Node.js support

The tested Node.js LTS majors are 22, 24 and 26, matching Taquito's
[merged Node 26 support](https://github.com/ecadlabs/taquito/pull/3504). Node 22 and 24 remain supported during Maintenance LTS.
Use Node 24 for development, browser tests and release tooling. `.nvmrc` and
the development container select that version.

The private workspace requires Node >=22.12.0 and npm >=11.0.0. Install dependencies with
npm 11.12.1 through `scripts/npm11.sh`. Published package manifests do not
declare a Node engine restriction. This change does not raise the minimum
or prohibit other Node majors from installing the packages. End-of-life and
Current releases are outside the tested support matrix.

## Checks

| Check | Node versions |
| --- | --- |
| Locked install, package and browser-bundle build, script and unit tests | 22, 24, 26 |
| Installed package checks with import and require | 22, 24, 26 |
| Chromium smoke tests | 24 |
| Release build and pre-publication checks | 24 |

Run the installed-package checks after building:

```sh
./scripts/npm11.sh ci --include=optional
./scripts/npm11.sh run build
./scripts/npm11.sh run test
./scripts/npm11.sh run test:node-consumers
```

The consumer runner packs each public workspace, installs those tarballs in
an isolated directory and checks that `import` and `require` expose the same
public exports. It also checks crypto and serialization without a DOM mock.

The SDK remains a browser wallet integration. Successful package loading in
Node does not provide DOM, extension messaging, browser storage or a complete
server-side wallet client. Node's web-like globals do not supply those features.

## Importing from Node

Node's `import` and `require` load the same CommonJS build. This lets both
forms share module state. Browser bundlers use the ESM build.

## Source compatibility

Keep Node typings at the oldest supported runtime, currently Node 22. A Node
26 runtime does not require Node 26 typings or a TypeScript upgrade. The SDK
also runs in browsers, so do not introduce Node 26-only globals into shared
source or raise browser output targets as part of runtime support work.
Keep the WalletConnect 2.18.0 pin. Kukai iOS depends on it, so only replace
it with an upgrade that has been tested against Kukai iOS.
`scripts/check-security-deps.mjs` enforces the exact version in the package
manifests, root overrides and lockfile.

Node 26 entered LTS on October 28, 2026 and receives updates through April
2029. Its official Linux binaries require `libatomic`, as do Node 25 binaries.
See the [Node 26 LTS announcement](https://nodejs.org/en/blog/release/v26.13.0)
and [Node release schedule](https://github.com/nodejs/Release) when updating
the support matrix. Include both Active LTS and Maintenance LTS; future LTS
majors are not necessarily even-numbered.
