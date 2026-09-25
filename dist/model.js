// Shared by the browser and the server.
const invalid = message => Object.assign(new Error(message), { status: 400 });
export function normalizePost(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw invalid('Paste a complete X or Twitter post URL.'); }
  if (url.protocol !== 'https:' || !['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com','mobile.x.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}\/?$/.test(url.pathname)) {
    throw invalid('Use a link like https://x.com/handle/status/12345.');
  }
  return `https://x.com${url.pathname.replace(/\/$/, '')}`;
}
export const tweetIdOf = post => normalizePost(post).split('/').at(-1);

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Length(value) {
  let bytes = [];
  for (const char of value) {
    let carry = BASE58.indexOf(char);
    if (carry < 0) return -1;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 255; carry >>= 8; }
    while (carry) { bytes.push(carry & 255); carry >>= 8; }
  }
  for (const char of value) { if (char !== '1') break; bytes.push(0); }
  return bytes.length;
}
export function normalizeWallet(value) {
  const wallet = String(value).trim();
  if (!wallet) throw invalid('Enter your Solana wallet address.');
  const bad = [...new Set(wallet.match(/[^1-9A-HJ-NP-Za-km-z]/g) || [])];
  if (bad.length) throw invalid(`Remove ${bad.map(char => char === ' ' ? 'spaces' : `“${char}”`).join(', ')} — a Solana address only uses letters and numbers (no 0, O, I or l).`);
  if (wallet.length < 32 || wallet.length > 44 || base58Length(wallet) !== 32) throw invalid('That is not a valid Solana wallet address.');
  return wallet;
}
// Transaction signatures come back from wallets as bytes; Solana shows them in base58.
export function encodeBase58(bytes) {
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] * 256; digits[i] = carry % 58; carry = Math.floor(carry / 58); }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + digits.reverse().map(digit => BASE58[digit]).join('');
}
export const shortWallet =wallet => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
export const formatUsd = cents => `$${(cents / 100).toFixed(2)}`;
