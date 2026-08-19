export const PORTAL_ACTIVATE_HOME_MESSAGE = 'portal:activate-home'
export const PORTAL_OPEN_RESOURCE_MESSAGE = 'portal:open-resource'

export type PortalOpenResourceMessage = {
  type: typeof PORTAL_OPEN_RESOURCE_MESSAGE
  href: string
  preserveExisting?: boolean
}

export function openPortalResource(href: string, options: { preserveExisting?: boolean } = {}) {
  if (window.parent !== window) {
    const message: PortalOpenResourceMessage = {
      type: PORTAL_OPEN_RESOURCE_MESSAGE,
      href,
      preserveExisting: options.preserveExisting,
    }
    window.parent.postMessage(message, window.location.origin)
    return
  }
  window.location.assign(href)
}

export function activatePortalHome() {
  if (window.parent !== window) {
    window.parent.postMessage({ type: PORTAL_ACTIVATE_HOME_MESSAGE }, window.location.origin)
    return
  }
  window.location.assign('/')
}
