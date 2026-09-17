export const SPOTLIGHT_WAIT_MS = 60_000;
export const spotlightReadyAt = record => record.revealAt + SPOTLIGHT_WAIT_MS;
export function submissionStatus(record, now = Date.now()) {
  if (now < record.revealAt) return 'queued';
  return Number.isFinite(record.sentAt) && record.sentAt >= spotlightReadyAt(record) && record.sentAt <= now ? 'sent' : 'pending';
}
