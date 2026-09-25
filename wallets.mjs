// Every launched coin gets its own payout wallet, derived from one MASTER_SEED.
// Wallet #i uses the path m/44'/501'/i'/0' — the same one Phantom and Solflare use for account i —
// so importing the seed phrase into a wallet app shows every coin's payout wallet.
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

// MASTER_SEED is a 12/24-word seed phrase, or 64 random bytes as hex (128 characters).
export function parseMasterSeed(value) {
  const text = String(value || '').trim();
  if (/^[0-9a-f]{128}$/i.test(text)) return Buffer.from(text, 'hex');
  const words = text.toLowerCase().split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every(word => /^[a-z]+$/.test(word)))
    return pbkdf2Sync(words.join(' ').normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');
  throw new Error('MASTER_SEED must be a 12 or 24-word seed phrase, or 128 hex characters.');
}

// SLIP-0010 ed25519 derivation; every level is hardened.
function derive(seed, path) {
  let digest = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  for (const index of path) {
    const data = Buffer.alloc(37);
    digest.copy(data, 1, 0, 32);
    data.writeUInt32BE((index | 0x80000000) >>> 0, 33);
    digest = createHmac('sha512', digest.subarray(32)).update(data).digest();
  }
  return digest.subarray(0, 32);
}

export const coinKeypair = (seed, index) => Keypair.fromSeed(derive(seed, [44, 501, index, 0]));
