# Beacon SDK (ECAD-maintained line)

> **This repository is the ECAD-maintained Beacon SDK package line.**
>
> It descends from [airgap-it/beacon-sdk](https://github.com/airgap-it/beacon-sdk),
> the original upstream Beacon project. ECAD publishes this line under the neutral
> `@ecadlabs/beacon-*` npm scope and uses it to support Taquito and related
> integrations.
>
> We also track [trilitech/octez.connect](https://github.com/trilitech/octez.connect),
> which continues the same SDK line under the `@tezos-x/*` scope. We may
> selectively import changes from that line when they fit our needs, while
> continuing to publish and support `@ecadlabs/beacon-*`.
>
> Where ECAD ports fixes from published `octez.connect` releases, we aim to keep
> that provenance explicit in our documentation, review notes, and history.
>
> A future move to `@tezos-x/*` packages remains possible, but it is not the
> default assumption for this repository today.
>
> ### Current branch and package strategy
>
> | Item | Role |
> |------|------|
> | `taquito-patches` | Main ECAD maintenance branch for the package line. |
> | `fix/*` | Short-lived ECAD fix branches when a focused patch is easier to stage separately. |
> | `@ecadlabs/beacon-*` | Public package names published from this repo. |
> | `trilitech` remote | External maintenance line we evaluate for import candidates. |
> | `upstream` remote | Historical AirGap lineage reference. |
>
> ### Release and review posture
>
> - Pull requests are the expected integration path for `taquito-patches`
> - CI runs on both `push` and `pull_request`
> - npm publication is handled from this repository through GitHub Actions using
>   npm Trusted Publishers, not long-lived npm automation tokens
> - We do not keep a root `CHANGELOG.md` that only redirects to external notes
> - Workspace versioning is synchronized from the root manifest into every
>   published package before release
> - Prerelease versions publish under the prerelease identifier as the npm
>   dist-tag, for example `4.8.1-ecad.4` publishes under `ecad`

### Published packages

Primary entry points:

- `@ecadlabs/beacon-sdk`
- `@ecadlabs/beacon-dapp`
- `@ecadlabs/beacon-wallet`

Lower-level packages also published from this repo:

- `@ecadlabs/beacon-types`
- `@ecadlabs/beacon-core`
- `@ecadlabs/beacon-utils`
- `@ecadlabs/beacon-ui`
- `@ecadlabs/beacon-transport-matrix`
- `@ecadlabs/beacon-transport-postmessage`
- `@ecadlabs/beacon-transport-walletconnect`
- `@ecadlabs/beacon-blockchain-tezos`
- `@ecadlabs/beacon-blockchain-tezos-sapling`
- `@ecadlabs/beacon-blockchain-substrate`

### How Taquito consumes this

Taquito currently depends on `@ecadlabs/beacon-*` packages directly. This keeps
the supported Beacon integration under ECAD control while leaving room to
reassess package sourcing in the future.

### Publishing a new version

1. Apply or merge the desired fix on `taquito-patches`
2. Set the release version, for example:
   `npm version 4.8.1-ecad.N --no-git-tag-version && npm run version:sync`
3. Refresh package README files: `npm run readmes:sync`
4. Refresh the lockfile: `npm install --package-lock-only --ignore-scripts`
5. Tag and push: `git tag v4.8.1-ecad.N && git push origin taquito-patches --tags`
6. GitHub Actions publishes the `@ecadlabs/beacon-*` packages to the public npm registry through npm Trusted Publishers

### Reassessing package sourcing

If the external maintenance line becomes stable and appropriate for our needs,
ECAD may choose to consume or adopt a different package line in the future.
That decision should be made explicitly and separately from routine patch work.

---

[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

> Connect wallets with dApps on Tezos

[Beacon](https://walletbeacon.io) is the implementation of the wallet interaction standard [TZIP-10](https://gitlab.com/tzip/tzip/blob/master/proposals/tzip-10/tzip-10.md), which describes communication between a dApp and a wallet.

## Intro

The `beacon-sdk` simplifies and abstracts communication between dApps and
wallets over different transport layers.

Developers building more complex smart contract interactions can use
[Taquito](https://github.com/ecadlabs/taquito) with `BeaconWallet`, which uses
this SDK under the hood and provides higher-level contract interaction helpers.

Besides this TypeScript SDK, there are also native Beacon SDKs for iOS and Android wallets:

- [Beacon Android SDK (Kotlin)](https://github.com/airgap-it/beacon-android-sdk)
- [Beacon iOS SDK (Swift)](https://github.com/airgap-it/beacon-ios-sdk)

## Installation

```sh
npm install @ecadlabs/beacon-sdk
```

## Example dApp integration

```ts
import { BeaconEvent, DAppClient } from '@ecadlabs/beacon-sdk'

const dAppClient = new DAppClient({ name: 'My Sample DApp' })

dAppClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, async (account) => {
  console.log(`${BeaconEvent.ACTIVE_ACCOUNT_SET} triggered: `, account)
})

try {
  console.log('Requesting permissions...')
  const permissions = await dAppClient.requestPermissions()
  console.log('Got permissions:', permissions.address)
} catch (error) {
  console.error('Got error:', error)
}
```

For a more complete example, see [`examples/dapp.html`](./examples/dapp.html).

## Example wallet integration

```ts
import {
  BeaconMessageType,
  PermissionResponseInput,
  PermissionScope,
  WalletClient
} from '@ecadlabs/beacon-sdk'

const client = new WalletClient({ name: 'My Wallet' })
await client.init()

client
  .connect(async (message) => {
    if (message.type === BeaconMessageType.PermissionRequest) {
      const response: PermissionResponseInput = {
        type: BeaconMessageType.PermissionResponse,
        network: message.network,
        scopes: [PermissionScope.OPERATION_REQUEST],
        id: message.id,
        publicKey: 'tezos public key'
      }

      await client.respond(response)
    }
  })
  .catch((error) => console.error('connect error', error))
```

For a more complete example, see [`examples/wallet.html`](./examples/wallet.html).

## Adding a wallet to Beacon SDK

Please create a PR and add your wallet in
[`scripts/blockchains/tezos.ts`](./scripts/blockchains/tezos.ts).

For iOS wallets, the wallet needs to define a custom URL scheme to support same-device functionality.

## Development

```sh
npm ci
npm run check:versions
npm run build
npm run test
npm run e2e
```

Once the SDK is built, you can open [`examples/dapp.html`](./examples/dapp.html) or
[`examples/wallet.html`](./examples/wallet.html) in your
browser and try the basic functionality. To support browser extensions, the
examples should be served over HTTP rather than opened directly from disk.
