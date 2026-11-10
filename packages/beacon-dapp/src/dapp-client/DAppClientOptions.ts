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
   * broadcast and proof-of-event requests wait for the wallet: Beacon has no way to cancel a
   * request at the wallet, so a timed-out request can still be approved there, and retrying it
   * can submit an operation twice. Mobile wallets often only receive a request once the app is
   * opened, and WalletConnect acknowledges cannot be matched to a Beacon request, so a deadline
   * over WalletConnect covers the whole approval.
   *
   * When this is set, it applies to every request type. Set 0 or a negative value to disable
   * deadlines entirely.
   *
   * A wallet response that arrives after a non-permission request timed out is reported through
   * BeaconEvent.LATE_RESPONSE_RECEIVED. Rejections carry `origin: 'local'` when the dApp
   * produced them (timeout, abort) and `origin: 'wallet'` when the wallet sent them.
   */
  requestTimeoutMs?: number
}
