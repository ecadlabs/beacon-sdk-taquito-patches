import { StorageKey } from '@ecadlabs/beacon-types'
import { Info } from '../../../../../../components/info'
import { WCInitErrorProps } from '../../../../../common'

const WCInitError: React.FC<WCInitErrorProps> = ({ title }) => {
  const getErrorMessage = (message: string) => {
    // now accepts strings or JSX fragments
    const getJSXMessage = (content: React.ReactNode) => <span>{content}</span>

    // non‐relayer errors stay the same
    if (!message.toLowerCase().includes('failed to connect to relayer')) {
      return getJSXMessage(message)
    }

    // for the relayer‐failed case, wrap "here" in a link
    return getJSXMessage(
      <>
        It looks like your network provider is blocking requests to the WalletConnect relayer. As a
        workaround try connecting through a VPN as shown{' '}
        <a
          href="https://docs.walletbeacon.io/guides/failed-to-connect"
          target="_blank"
          rel="noopener noreferrer"
        >
          here
        </a>
        .
      </>
    )
  }

  const errorMessage = localStorage ? localStorage.getItem(StorageKey.WC_INIT_ERROR) : undefined
  const description = (
    <>
      <h3 style={{ color: '#FF4136', margin: '0.6px' }}>A network error occurred.</h3>
      {errorMessage && getErrorMessage(errorMessage)}
    </>
  )

  return <Info title={title} description={description} border />
}

export { WCInitError }
