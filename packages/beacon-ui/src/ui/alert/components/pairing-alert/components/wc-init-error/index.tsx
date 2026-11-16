import React from 'react'
import { Info } from '../../../../../../components/info'
import { WCInitErrorProps } from '../../../../../common'
import { getWalletConnectErrorCopy } from '../../../../../../i18n/messages'

const WCInitError: React.FC<WCInitErrorProps> = ({ title = 'Scan QR code', reason }) => {
  const copy = getWalletConnectErrorCopy(reason)
  const description = (
    <>
      <h3 style={{ color: '#FF4136', margin: '0.6px' }}>{copy.heading}</h3>
      <span>
        {copy.body}
        {copy.link ? (
          <>
            {' '}
            <a href={copy.link.url} target="_blank" rel="noopener noreferrer">
              {copy.link.label}
            </a>
            .
          </>
        ) : null}
      </span>
    </>
  )

  return <Info title={title} description={description} border />
}

export { WCInitError }
