# Beacon SDK (ECAD-maintained line)

> **This repository is the ECAD-maintained Beacon SDK package line.**
>
> It descends from [airgap-it/beacon-sdk](https://github.com/airgap-it/beacon-sdk),
> the original upstream Beacon project. ECAD publishes this fork under the neutral
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
> | `taquito-patches` | Main ECAD maintenance branch for the fork. |
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
> - Workspace versioning is synchronized from the root manifest into every
>   published package before release
>
> ### How Taquito consumes this
>
> Taquito currently depends on `@ecadlabs/beacon-*` packages directly. This keeps
> the supported Beacon integration under ECAD control while leaving room to
> reassess package sourcing in the future.
>
> ### Publishing a new version
>
> 1. Apply or merge the desired fix on `taquito-patches`
> 2. Set the release version, for example:
>    `npm version 4.8.1-ecad.N --no-git-tag-version && npm run version:sync`
> 3. Refresh the lockfile: `npm install --package-lock-only --ignore-scripts`
> 4. Tag and push: `git tag v4.8.1-ecad.N && git push origin taquito-patches --tags`
> 5. GitHub Actions publishes the `@ecadlabs/beacon-*` packages to the public npm registry through npm Trusted Publishers
>
> ### Reassessing package sourcing
>
> If the external maintenance line becomes stable and appropriate for our needs,
> ECAD may choose to consume or adopt a different package line in the future.
> That decision should be made explicitly and separately from routine patch work.

---

[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

> Connect Wallets with dApps on Tezos

[Beacon](https://walletbeacon.io) is the implementation of the wallet interaction standard [tzip-10](https://gitlab.com/tzip/tzip/blob/master/proposals/tzip-10/tzip-10.md) which describes the connnection of a dApp with a wallet.

## Intro

The `beacon-sdk` simplifies and abstracts the communication between dApps and wallets over different transport layers.

Developers that plan to develop complex smart contract interactions can use [Taquito](https://github.com/ecadlabs/taquito) with the `BeaconWallet`, which uses this SDK under the hood, but provides helpful methods to interact with contracts.

Besides this Typescript SDK, we also provide SDKs for native iOS and Android Wallets:

- [Beacon Android SDK (Kotlin)](https://github.com/airgap-it/beacon-android-sdk)
- [Beacon iOS SDK (Swift)](https://github.com/airgap-it/beacon-ios-sdk)

## Documentation

The repository README is the canonical maintenance overview for the ECAD package
line. API documentation is generated from this repo and intended to be published
via GitHub Pages at
[ecadlabs.github.io/beacon-sdk-taquito-patches](https://ecadlabs.github.io/beacon-sdk-taquito-patches/).

## Installation

```
npm i --save @ecadlabs/beacon-sdk
```

## Example DApp integration

```ts
import { DAppClient } from '@ecadlabs/beacon-sdk'

const dAppClient = new DAppClient({ name: 'My Sample DApp' })

// Listen for all the active account changes
dAppClient.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, async (account) => {
  // An active account has been set, update the dApp UI
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

For a more complete example, take a look at the `example-dapp.html` file.

## Example Wallet integration

```ts
const client = new WalletClient({ name: 'My Wallet' })
await client.init() // Establish P2P connection

client
  .connect(async (message) => {
    // Example: Handle PermissionRequest. A wallet should handle all request types
    if (message.type === BeaconMessageType.PermissionRequest) {
      // Show a UI to the user where he can confirm sharing an account with the DApp

      const response: PermissionResponseInput = {
        type: BeaconMessageType.PermissionResponse,
        network: message.network, // Use the same network that the user requested
        scopes: [PermissionScope.OPERATION_REQUEST], // Ignore the scopes that have been requested and instead give only operation permissions
        id: message.id,
        publicKey: 'tezos public key'
      }

      // Send response back to DApp
      await client.respond(response)
    }
  })
  .catch((error) => console.error('connect error', error))
```

For a more complete example, take a look at the `example-wallet.html` file.

## Adding a wallet to beacon-sdk

Please create a PR and add your wallet in
[`scripts/generate-wallet-list.ts`](./scripts/generate-wallet-list.ts).

For iOS wallets, the wallet needs to define a custom url scheme to support the same-device functionality.

## Development

```
$ npm ci
$ npm run check:versions
$ npm run build
$ npm run test
$ npm run e2e
```

Once the SDK is built, you can open the `dapp.html` or `wallet.html` file in your browser and try out the basic functionality. To support browser extensions as well, the file should be viewed over a webserver. You can navigate to the example folder and easily start one with `python -m SimpleHTTPServer 8000` (or `python3 -m http.server 8000` with Python 3.x) and then open the examples with `http://localhost:8000/`.
