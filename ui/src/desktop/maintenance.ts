export const MAINTENANCE_START_HOUR = 22
export const MAINTENANCE_END_HOUR = 5
export const MAINTENANCE_SPLASH_DURATION_SECONDS = 15
export const MAINTENANCE_SPLASH_DURATION_MS = MAINTENANCE_SPLASH_DURATION_SECONDS * 1_000

export function isScheduledMaintenance(now = new Date()) {
  const hour = now.getHours()
  return hour >= MAINTENANCE_START_HOUR || hour < MAINTENANCE_END_HOUR
}
