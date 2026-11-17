import React from 'react'
import { getBeaconMessages } from '@ecadlabs/beacon-types'
import { Info } from '../../../../../../components/info'
import { WCInitErrorProps } from '../../../../../common'
import { getWalletConnectErrorCopy } from '../../../../../../i18n/messages'

const WCInitError: React.FC<WCInitErrorProps> = ({ title, reason }) => {
  const { ui } = getBeaconMessages()
  const resolvedTitle = title ?? ui.scanQrCode
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

  return <Info title={resolvedTitle} description={description} border />
}

export { WCInitError }
