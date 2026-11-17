import React, { useId, useLayoutEffect, useRef } from 'react'
import { getBeaconMessages } from '@ecadlabs/beacon-types'
import { CloseIcon, LeftIcon, LogoIcon } from '../icons'
import { Loader } from '../loader'
import { AlertProps } from '../../ui/common'
import { useIsMobile } from '../../ui/alert/hooks/useIsMobile'
import { ButtonIcon } from '../button-icon/button-icon'
import { ensureDialogFocus, getDialogFocusables, getRootActiveElement } from '../../utils/focus'

const Alert: React.FC<React.PropsWithChildren<AlertProps>> = (props) => {
  const isMobile = useIsMobile()
  const { ui, aria } = getBeaconMessages()
  const modalRef = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const fallbackTitleId = `${headingId}-fallback`

  useLayoutEffect(() => {
    const modal = modalRef.current
    if (!modal) {
      return
    }
    const heading = modal.querySelector<HTMLElement>(
      '.info-title, .top-wallets-info h3, .qr-left h3'
    )
    if (heading) {
      if (!heading.id) {
        heading.id = headingId
      }
      modal.setAttribute('aria-labelledby', heading.id)
    } else {
      modal.setAttribute('aria-labelledby', fallbackTitleId)
    }
  })

  const handleModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!props.open) {
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onCloseClick()

      return
    }
    if (e.key !== 'Tab') {
      return
    }
    const modal = modalRef.current
    if (!modal) {
      return
    }
    const focusables = getDialogFocusables(modal)
    if (focusables.length === 0) {
      e.preventDefault()
      modal.focus()

      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = getRootActiveElement(modal)

    if (e.shiftKey) {
      if (!active || active === first || active === modal || !modal.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else if (!active || active === last || !modal.contains(active)) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className={props.open ? 'alert-wrapper-show' : 'alert-wrapper-hide'}
      onClick={() => {
        if (!props.closeOnBackdropClick) {
          return
        }

        props.onCloseClick()
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal={props.open ? 'true' : undefined}
        aria-hidden={props.open ? undefined : 'true'}
        aria-busy={props.loading ? 'true' : undefined}
        aria-labelledby={fallbackTitleId}
        tabIndex={-1}
        className={props.open ? 'alert-modal-show' : 'alert-modal-hide'}
        onClick={(e) => {
          e.stopPropagation()
        }}
        onKeyDown={handleModalKeyDown}
      >
        <span id={fallbackTitleId} className="alert-sr-only">
          {ui.connectWallet}
        </span>
        <div className="alert-header">
          {props.onBackClick ? (
            <ButtonIcon
              ariaLabel={aria.goBack}
              onClick={() => {
                props.onBackClick?.()
                const modal = modalRef.current
                if (modal) {
                  queueMicrotask(() => {
                    if (props.open) {
                      ensureDialogFocus(modal)
                    }
                  })
                }
              }}
            >
              <LeftIcon />
            </ButtonIcon>
          ) : (
            <div className="alert-button-icon-empty"></div>
          )}
          <div className="alert-logo">
            <LogoIcon />
          </div>
          <ButtonIcon ariaLabel={aria.closeModal} onClick={props.onCloseClick}>
            <CloseIcon />
          </ButtonIcon>
        </div>
        <div
          className="alert-modal-loading-wrapper"
          aria-hidden={!props.loading}
          style={
            props.loading
              ? {
                  opacity: 1,
                  transition: 'all ease 0.3s',
                  height: '14px',
                  overflow: 'unset',
                  width: 'unset'
                }
              : {
                  opacity: 0,
                  transition: 'all ease 0.3s',
                  height: 0,
                  overflow: 'hidden',
                  width: 0
                }
          }
        >
          <Loader />
        </div>
        <div className="alert-body" style={{ marginBottom: props.extraContent ? '' : '1.8em' }}>
          {props.children}
          {!isMobile && (
            <div
              className={props.showMore ? 'alert-body-extra-show' : 'alert-body-extra-hide'}
              aria-hidden={!props.showMore}
            >
              {props.extraContent && <div className="alert-divider"></div>}
              {props.showMore && props.extraContent}
            </div>
          )}
        </div>
        {!isMobile && props.extraContent && (
          <div
            className="alert-footer"
            role="button"
            tabIndex={props.open ? 0 : -1}
            aria-expanded={Boolean(props.showMore)}
            onClick={() => props.onClickShowMore && props.onClickShowMore()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                props.onClickShowMore?.()
              }
            }}
          >
            {props.showMore ? ui.showLess : ui.showMore}
          </div>
        )}
      </div>
    </div>
  )
}

export { Alert }
