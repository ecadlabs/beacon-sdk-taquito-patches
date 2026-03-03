# Beacon SDK (ECAD Labs Taquito Patches)

> **This is a patched fork, not the upstream Beacon SDK.**
>
> This branch (`taquito-patches`) exists so ECAD Labs can ship same-day bug fixes
> for [Taquito](https://github.com/ecadlabs/taquito) without waiting on upstream
> release cycles. Packages are renamed from `@airgap/beacon-*` to
> `@ecadlabs/beacon-*` and published to the **public npm registry**.
>
> **Upstream**: [airgap-it/beacon-sdk](https://github.com/airgap-it/beacon-sdk)
>
> ### Branch strategy
>
> | Branch | Purpose |
> |--------|---------|
> | `master` | Tracks upstream. Periodically synced via `git fetch upstream && git merge upstream/master`. |
> | `fix/*` | Individual bug fixes branched off master. PRs go to upstream. Keep `@airgap` names. |
> | `taquito-patches` | **This branch.** Accumulates fixes not yet merged upstream. Has the `@airgap` -> `@ecadlabs` rename. Tagged and published to the public npm registry. Fixes are dropped as upstream merges them. |
>
> ### How Taquito consumes this
>
> `@taquito/beacon-wallet` declares `@ecadlabs/beacon-dapp` directly in its
> dependencies (using `"@airgap/beacon-dapp": "npm:@ecadlabs/beacon-dapp@^4.8.1-ecad"`),
> so users get the patched fork automatically on `npm install`. No overrides or
> `.npmrc` configuration is needed.
>
> ### Publishing a new version
>
> 1. Apply fix to this branch (or merge a `fix/*` branch in)
> 2. Bump version: `npx lerna version 4.8.1-ecad.N --no-push --exact --yes`
> 3. Tag: `git tag v4.8.1-ecad.N && git push origin taquito-patches --tags`
> 4. GitHub Actions publishes to the public npm registry automatically on tag push
>
> ### Dropping this fork
>
> When upstream ships the fix: update `@taquito/beacon-wallet` to depend on
> `@airgap/beacon-dapp` directly instead of the `npm:@ecadlabs/beacon-dapp` alias,
> run `npm install`, done.

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

The documentation can be found [here](https://docs.walletbeacon.io/), technical documentation can be found [here](https://typedocs.walletbeacon.io/).

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

Please create a PR and add your wallet [here](https://github.com/airgap-it/beacon-sdk/blob/master/scripts/generate-wallet-list.ts).

For iOS wallets, the wallet needs to define a custom url scheme to support the same-device functionality.

## Development

```
$ npm i
$ npm run build
$ npm run test
```

Once the SDK is built, you can open the `dapp.html` or `wallet.html` file in your browser and try out the basic functionality. To support browser extensions as well, the file should be viewed over a webserver. You can navigate to the example folder and easily start one with `python -m SimpleHTTPServer 8000` (or `python3 -m http.server 8000` with Python 3.x) and then open the examples with `http://localhost:8000/`.
