import {
  Storage,
  NetworkType,
  ColorMode,
  NodeDistributions,
  AnalyticsInterface,
  Network
} from '@ecadlabs/beacon-types'
import { BeaconEvent, BeaconEventType, BeaconEventHandlerFunction } from '../events'
import { BlockExplorer } from '../utils/block-explorer'

type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>
  }[Keys]

/**
 * @category DApp
 */
export interface DAppClientOptions {
  /**
   * Name of the application
   */
  name: string

  /**
   * Description of the application
   */
  description?: string

  /**
   * A URL to the icon of the application
   */
  iconUrl?: string

  /**
   * A URL to the website of the application
   */
  appUrl?: string

  /**
   * The storage that will be used by the SDK
   */
  storage?: Storage

  /**
   * An object that will be used to overwrite default event handler behaviour.
   *
   * If you plan to overwrite all default events, use "disableDefaultEvents" instead.
   *
   * This will overwrite the default event handler, so this can lead to unexpected behavior in some cases.
   * We recommend that you overwrite all handlers if you want to use your own UI.
   *
   * If you simply want to be notified of events happening, but do not want to overwrite the default behavior,
   * please use `subscribeToEvent()` on the DAppClient instead.
   */
  eventHandlers?: {
    [key in BeaconEvent]?: {
      handler: BeaconEventHandlerFunction<BeaconEventType[key]>
    }
  }

  /**
   * Disable all default Events and UI elements. If passed together with "eventHandlers",
   * the default eventHandlers will be removed, and the ones passed by the user will be added.
   */
  disableDefaultEvents?: boolean

  /**
   * Configure built-in UI. Custom event handlers and subscribers still run.
   * disableDefaultEvents takes precedence and disables pairing and modal alerts too.
   */
  uiOptions?: {
    /** Show built-in request toasts. Defaults to true; false preserves pairing and modal alerts. */
    enableToasts?: boolean
  }

  /**
   * A list of matrix nodes to connect to. If a non-empty array is passed, the default options will be overwritten.
   * One node will be randomly selected based on the local keypair and the other nodes will be used as a fallback in case the primary node goes down.
   *
   * Only provide the hostname, no https:// prefix. Eg. { [Regions.EU1]: ['matrix.example.com'] }
   */
  matrixNodes?: NodeDistributions

  /**
   * The block explorer used by the SDK
   */
  blockExplorer?: BlockExplorer

  /**
   * Indicates on which network the DApp is running on.
   */
  network?: Network

  /**
   * @deprecated Please use "network" instead.
   * Indicates on which network the DApp is planning to run. This is currently used to adjust the URLs of web-wallets in the pairing alert if they use different URLs for testnets.
   * You will still have to define the network you intend to use during the permission request.
   */
  preferredNetwork?: NetworkType

  /**
   * Set the color mode for the UI elements (alerts and toasts)
   */
  colorMode?: ColorMode

  /**
   * A disclaimer text that will be displayed in the pairing alert
   */
  disclaimerText?: string

  /**
   * A list of contracts that the DApp is using. Allows to attach human readable error messages for to error codes
   */
  errorMessages?: Record<string, Record<string | number, string>>

  /**
   * Configuration that is passed to the WalletConnect transport.
   *
   * This is required to enable WalletConnect connections.
   */
  walletConnectOptions?: RequireAtLeastOne<{
    /**
     * The projectId of the application. Has to be obtained from https://cloud.walletconnect.com/
     */
    projectId?: string

    /**
     * The relay server to connect to
     */
    relayUrl?: string
  }>

  /**
   * The analytics instance that will be used by the SDK
   */
  analytics?: AnalyticsInterface

  /**
   * The wallets that will be featured in the UI.
   */
  featuredWallets?: string[]

  /**
   * @deprecated Ignored. Built-in telemetry has been removed.
   */
  enableMetrics?: boolean

  /**
   * Automatically switch between apps on Mobile Devices (Enabled by Default)
   */
  enableAppSwitching?: boolean

  /**
   * Maximum time in milliseconds to wait for a wallet acknowledge or response before rejecting
   * the request with PEER_UNREACHABLE.
   *
   * When this is not set, only permission requests have a deadline (60_000). Operation, sign,
   * broadcast, proof-of-event and V3 blockchain requests have no dApp deadline: Beacon has no
   * way to cancel a request at the wallet, so a timed-out request can still be approved there,
   * and retrying it can submit an operation twice. Mobile wallets often only receive a request
   * once the app is opened, and WalletConnect acknowledges cannot be matched to a Beacon request,
   * so a deadline over WalletConnect covers the whole approval.
   *
   * Without a deadline, a request to a wallet that never answers stays pending: indefinitely over
   * P2P and postMessage, and over WalletConnect until WalletConnect's own request expiry of five
   * minutes. That expiry rejects the request with PEER_UNREACHABLE and `errorOrigin: 'local'`.
   * The wallet may still act on the request afterwards, and WalletConnect drops any later reply,
   * so no late response is reported for it.
   *
   * When this is set, it applies to every request type. Over WalletConnect the effective deadline
   * is the shorter of this value and the five minute expiry. Set 0 or a negative value to disable
   * the dApp deadline entirely.
   *
   * A wallet response that arrives after a non-permission request timed out is reported once
   * through BeaconEvent.LATE_RESPONSE_RECEIVED. With several tabs over WalletConnect, it is
   * reported in the tab that made the request. Rejections carry `errorOrigin: 'local'` when the
   * dApp produced them (timeout, abort, WalletConnect expiry) and `errorOrigin: 'wallet'` when
   * they arrived on the response path. A local timeout or abort does not mean the wallet refused:
   * check chain state before retrying an operation.
   */
  requestTimeoutMs?: number

  /**
   * Time in milliseconds to wait for a correlated wallet acknowledge before emitting
   * BeaconEvent.WAITING_FOR_WALLET_ACK. Defaults to 5_000. Set 0 or a negative value to disable.
   * Does not fire over WalletConnect where correlated ACKs are not supported.
   */
  ackTimeoutMs?: number
}
