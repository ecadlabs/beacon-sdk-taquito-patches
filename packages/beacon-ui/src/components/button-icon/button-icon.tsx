import React from 'react'
import './button-icon.css'

interface ButtonIconProps {
  onClick?: () => void
  children: React.ReactNode
  className?: string
  ariaLabel?: string
}

export const ButtonIcon: React.FC<ButtonIconProps> = ({
  onClick,
  children,
  className = '',
  ariaLabel
}) => (
  <div
    className={`button-icon ${className}`}
    role="button"
    tabIndex={0}
    aria-label={ariaLabel}
    onClick={onClick}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onClick?.()
      }
    }}
  >
    {children}
  </div>
)
