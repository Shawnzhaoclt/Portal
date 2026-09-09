import { toast } from 'sonner'

export const ERROR_MESSAGE_MINIMUM_DURATION_MS = 15_000

function errorDuration(requestedDuration: number | undefined) {
  if (requestedDuration === Number.POSITIVE_INFINITY) return requestedDuration
  if (typeof requestedDuration !== 'number' || !Number.isFinite(requestedDuration)) {
    return ERROR_MESSAGE_MINIMUM_DURATION_MS
  }
  return Math.max(requestedDuration, ERROR_MESSAGE_MINIMUM_DURATION_MS)
}

let configured = false

/**
 * Applies one application-wide duration policy to Sonner error toasts.
 * Individual callers may request a longer duration or a persistent toast,
 * but no error toast may auto-dismiss in less than 15 seconds.
 */
export function configureErrorToastDuration() {
  if (configured) return
  configured = true

  const showErrorToast = toast.error.bind(toast)
  toast.error = ((message, options) => showErrorToast(message, {
    ...options,
    duration: errorDuration(options?.duration),
  })) as typeof toast.error
}
