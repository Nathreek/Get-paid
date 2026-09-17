export const STORAGE_KEY = 'route.submissions.v1';
export function normalizeHandle(value) {
  const handle = String(value).trim().replace(/^@/, '');
  if (!handle) throw new Error('Enter your X handle, for example your_name.');
  if (handle.length > 15) throw new Error('An X handle can contain at most 15 characters.');
  const invalid = [...new Set(handle.match(/[^A-Za-z0-9_]/g) || [])];
  if (invalid.length) throw new Error(`Remove ${invalid.map(char => char === ' ' ? 'spaces' : `“${char}”`).join(', ')} from your X handle. Only letters, numbers, and underscores are allowed.`);
  return handle.toLowerCase();
}
export function normalizePost(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Paste a complete X or Twitter post URL.'); }
  if (url.protocol !== 'https:' || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(url.pathname)) {
    throw new Error('Use a link like https://x.com/handle/status/12345.');
  }
  return `https://x.com${url.pathname.replace(/\/$/, '')}`;
}
export function randomDelay(min, max, random = Math.random) { return Math.floor(random() * (max - min + 1)) + min; }
export function readRecords(storage, now = Date.now()) {
  const raw = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
  if (!Array.isArray(raw)) throw new Error('Invalid saved list');
  return raw.filter(r => {
    try { return typeof r.id === 'string' && r.id.length < 80 && normalizeHandle(r.handle) === r.handle && normalizePost(r.post) === r.post && typeof r.displayName === 'string' && r.displayName.length > 0 && r.displayName.length <= 80 && Number.isFinite(r.createdAt) && r.createdAt <= now && Number.isFinite(r.revealAt) && r.revealAt >= r.createdAt && r.revealAt - r.createdAt <= 25000; } catch { return false; }
  });
}
