# Account restoration and disconnect

Startup restores the stored account only while that selection is current. Clearing the account, disconnecting, destroying the client or receiving a newer storage selection cancels older restoration work. A canceled restoration cannot select a peer or transport, write the active-account pointer or emit an active-account event.

Restoration checks that the shared pointer still names the account and that the account still exists. It does not rewrite the pointer. Explicit selections and clears order their active-account writes within each client, so a clear completes after an earlier write already in progress.

`clearActiveAccount()` may keep initialized transports available for pairing. `disconnect()` retires the client's transports and allows a later connection. `destroy()` retires the instance permanently. Stopping a pending Matrix login or sync also cancels its continuation, so it cannot restart polling or clear a newer connection's shared state.

Custom storage must deliver change notifications for writes from other clients. The storage interface has no conditional transaction operation, so it does not provide atomic ordering across clients using arbitrary asynchronous storage backends.

## Subscribe to active account changes

A wallet can switch accounts or disconnect after the initial permission request.
Subscribe to `BeaconEvent.ACTIVE_ACCOUNT_SET` when setting up the dApp, before
requesting permissions. The callback receives the selected account, or
`undefined` when the selection is cleared.

```ts
import { BeaconEvent, DAppClient } from '@ecadlabs/beacon-dapp'

export async function bindAccountLabel(client: DAppClient, label: HTMLElement) {
  return client.subscribeToEvent(BeaconEvent.ACTIVE_ACCOUNT_SET, (account) => {
    label.textContent = account?.address ?? 'No wallet connected'
  })
}
```

Pass your existing client and the element displaying the connected address to
`bindAccountLabel`. Await the result and call the returned unsubscribe function
when that view is removed. For a Taquito `BeaconWallet`, use `wallet.client`
to register the same event handler.

## Storage change subscriptions

`StorageChangeEvent` carries physical keys and serialized string values, including
the key prefix used by the storage adapter. Listener return values are ignored;
`LocalStorage` reports synchronous and asynchronous listener failures without
waiting for listeners to finish or preventing later notifications.

`LocalStorage` subscribes to changes from other documents sharing its local
storage area. It ignores session storage events. A prefixed instance forwards
only its physical `StorageKey` entries, plus notifications that the entire
storage area was cleared. An empty key is an entry change, not a clear.

`ChromeStorage` and `IndexedDBStorage` do not support external-change
subscriptions. They now reject registration instead of resolving without
registering a listener. Their read and write operations are unchanged. Callers must handle
registration failures; the built-in DApp and wallet clients already do so. Use `LocalStorage` or a custom adapter with external-change
notifications when cross-context account and peer synchronization is required.

[Chrome's native change event](https://developer.chrome.com/docs/extensions/reference/api/storage#event-onChanged) includes the writing context and has no writer
identifier. Forwarding it directly can cancel the client's own account update
or duplicate peer events. IndexedDB has no native cross-context change event,
and WalletConnect also writes its databases directly. Reliable support requires
more than notifying only writes made through these adapters.
