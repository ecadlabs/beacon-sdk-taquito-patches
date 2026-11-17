const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export const getActiveElementDeep = (): HTMLElement | null => {
  if (typeof document === 'undefined') {
    return null
  }
  let current: Element | null = document.activeElement
  while (current && current.shadowRoot && current.shadowRoot.activeElement) {
    current = current.shadowRoot.activeElement
  }

  return current instanceof HTMLElement ? current : null
}

export const getRootActiveElement = (node: HTMLElement): HTMLElement | null => {
  const root = node.getRootNode()
  if (root instanceof ShadowRoot || root instanceof Document) {
    if (root.activeElement instanceof HTMLElement) {
      return root.activeElement
    }
  }

  return getActiveElementDeep()
}

export const getDialogFocusables = (modal: HTMLElement): HTMLElement[] =>
  Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.getAttribute('aria-disabled') === 'true') {
      return false
    }
    if (el.closest('[aria-hidden="true"], [inert]')) {
      return false
    }
    if (el.style.display === 'none' || el.style.visibility === 'hidden') {
      return false
    }

    return true
  })

export const ensureDialogFocus = (modal: HTMLElement): void => {
  const body = modal.querySelector<HTMLElement>('.alert-body')
  const bodyFocusables = body ? getDialogFocusables(body) : []
  const active = getRootActiveElement(modal)
  if (active && modal.contains(active) && !active.closest('[aria-hidden="true"], [inert]')) {
    const isHeaderControl = Boolean(active.closest('.alert-header'))
    if (!isHeaderControl || bodyFocusables.length === 0) {
      return
    }
  }
  if (bodyFocusables.length > 0) {
    bodyFocusables[0].focus()

    return
  }
  const focusables = getDialogFocusables(modal)
  const target = focusables[0] ?? modal
  target.focus()
}
