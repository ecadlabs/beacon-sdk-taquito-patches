# WalletConnect (Reown) project ID setup and migration

`DAppClient` uses WalletConnect v2 to pair WalletConnect-enabled Tezos wallets such as Kukai Mobile (iOS) and the Kukai QR code. Browser extensions (such as Temple) use `postMessage`, and TZIP-10 P2P wallets (such as the Kukai Web link, Temple Mobile, and Umami) use Matrix relay nodes (`matrixNodes`).

## Deprecation and removal of the built-in demo `projectId`

In `@ecadlabs/beacon-*` `4.9.0-ecad`, the built-in fallback WalletConnect `projectId` is deprecated (#181):

- **In `4.9.0-ecad`:** Constructing `DAppClient` without `walletConnectOptions.projectId` emits a runtime warning via [`reportDiagnostic`](logging.md) and falls back to the legacy demo `projectId`.
- **In the next minor release (`4.10.0-ecad` / `5.0.0-ecad`):** The built-in fallback `projectId` is removed.

### Migration note (when upgrading to the release that removes the default)

> **Action required for dApps using WalletConnect:** The built-in demo WalletConnect `projectId` has been removed. Every dApp must now pass its own Reown project ID via `walletConnectOptions: { projectId }` when constructing `DAppClient` (or `BeaconWallet` in `@taquito/beacon-wallet`).
>
> **What happens if `walletConnectOptions.projectId` is omitted:**
>
> - WalletConnect v2 pairings (such as Kukai Mobile and scanning the Kukai QR code) are disabled and cannot generate a pairing URI.
> - Browser extension wallets (`postMessage`, such as the Temple browser extension) and Matrix P2P wallets (such as the Kukai Web wallet link, Temple Mobile, and Umami) are unaffected and continue to work normally.

## Why the shared default is being removed

1. **Shared rate-limit and revocation risk:** Every dApp that omitted `projectId` shared a single third-party Reown project, meaning one quota limit, account change, or revocation could break WalletConnect pairing across all unconfigured dApps simultaneously.
2. **No origin isolation:** Domain allowlists are enforced per Reown `projectId`, which is impossible when an entire ecosystem shares one credential.
3. **Reown Terms of Service compliance:** Under the [Reown Terms of Service](https://reown.com/terms-of-service) (_Part A, Section 1: Registration and Account_), each application must register and use its own project credentials.

## Step-by-step setup

1. **Register a project at [dashboard.reown.com](https://dashboard.reown.com/):**
   - The free Starter plan is sufficient. It allows **one project and one member per team**, so create a separate team for each application (and for separate CI or staging harnesses if needed).
   - Disable **Social & Email**, **Onramp**, and **Swaps** in the project's feature settings; Beacon only uses the WalletConnect v2 relay (`SignClient`).
2. **Pass `projectId` from an environment variable:**

   ```ts
   import { DAppClient } from '@ecadlabs/beacon-sdk'

   const dAppClient = new DAppClient({
     name: 'My Sample DApp',
     walletConnectOptions: {
       projectId: import.meta.env.VITE_REOWN_PROJECT_ID
     }
   })
   ```

   If you use Taquito's `@taquito/beacon-wallet`:

   ```ts
   import { BeaconWallet } from '@taquito/beacon-wallet'

   const wallet = new BeaconWallet({
     name: 'My Sample DApp',
     network: { type: 'shadownet' },
     walletConnectOptions: {
       projectId: import.meta.env.VITE_REOWN_PROJECT_ID
     }
   })
   ```

3. **Configure the domain allowlist in Reown Cloud:**
   - **Empty allowlist:** Permits all origins. Always add your production domains before launch so other sites cannot use your quota.
   - **`localhost`:** Always allowed by the relay, even when an allowlist is set.
   - **Apex vs. wildcard subdomains:** `https://*.example.com` does **not** match `https://example.com`. Add both if your app is reachable at both hosts.
   - **Preview deployments and tunnels:** Add explicit entries for preview URLs. Never add a wildcard for a shared tunnel provider (such as `*.trycloudflare.com`).
   - **Propagation delay:** Changes to the allowlist can take several minutes to take effect.
   - **Rejected origin behavior:** When the relay rejects an origin (WebSocket close code `3000`), the Beacon pairing modal displays **`"Origin not allowed."`** (#216 / #245; on `@ecadlabs/beacon-* <= 4.9.0-ecad-beta.3`, it displayed `"A network error occurred."`).
4. **Verify your allowlist:**
   - Test WalletConnect pairing from your allowed production or staging domain.
   - Also test from an origin that is **not** on your allowlist (for example, a temporary tunnel URL) and confirm that pairing fails with `"Origin not allowed."` (since `localhost` and an empty allowlist will otherwise pass silently).
