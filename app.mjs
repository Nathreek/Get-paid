// Builds the store from environment variables. Shared by server.mjs (local/VPS) and api/ (Vercel).
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './dist/config.js';
import { createStore, TIERS, TIER_SIZE } from './store.mjs';
import { createVerifier } from './verify.mjs';
import { createPayer, solPrice } from './payout.mjs';

export async function createAppStore(env = process.env) {
  let url = env.TURSO_DATABASE_URL;
  if (!url) {
    if (env.VERCEL) throw new Error('TURSO_DATABASE_URL is required on Vercel; local files there are temporary.');
    const dir = fileURLToPath(new URL('./data/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    url = 'file:' + dir + 'get-paid.db';
  }
  const payer = env.PAYOUT_PRIVATE_KEY ? createPayer({ rpcUrl: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', secretKey: env.PAYOUT_PRIVATE_KEY }) : null;
  if (payer) console.log(`Payout wallet: ${payer.address}`);
  const payoutsEnabled = env.PAYOUTS_ENABLED === 'true';
  if (payoutsEnabled && !payer) console.warn('PAYOUTS_ENABLED is true but PAYOUT_PRIVATE_KEY is missing; nothing will be sent.');
  return createStore({
    url, authToken: env.TURSO_AUTH_TOKEN,
    verify: createVerifier({
      ticker: config.ticker, coinAddress: config.coinAddress,
      campaignStart: env.CAMPAIGN_START ? Date.parse(env.CAMPAIGN_START) || 0 : 0,
      llm: { apiKey: env.GROQ_API_KEY, baseUrl: env.LLM_BASE_URL || 'https://api.groq.com/openai/v1', model: env.LLM_MODEL || 'openai/gpt-oss-120b' },
    }),
    payer, price: solPrice, payoutsEnabled,
    cluster: /devnet/i.test(env.SOLANA_RPC_URL || '') ? 'devnet' : 'mainnet',
    payoutIntervalMs: Number(env.PAYOUT_INTERVAL_SECONDS || 10) * 1000,
    dailyCapCents: Math.round(Number(env.MAX_DAILY_PAYOUT_USD || 100) * 100),
    maxPerAccount: Number(env.MAX_PAYOUTS_PER_ACCOUNT || 1),
    ...payoutAmounts(env),
  });
}

const cents = usd => Math.round(Number(usd) * 100);
// PAYOUT_FIXED_USD=5 pays everyone $5. Otherwise PAYOUT_TIERS="3-5,6-10,..." (USD ranges) rises every PAYOUT_TIER_SIZE payouts.
export function payoutAmounts(env) {
  if (env.PAYOUT_FIXED_USD) {
    const fixedCents = cents(env.PAYOUT_FIXED_USD);
    if (!(fixedCents > 0)) throw new Error('PAYOUT_FIXED_USD must be a positive number, e.g. 5 or 2.50.');
    return { fixedCents };
  }
  const tierSize = env.PAYOUT_TIER_SIZE ? Number(env.PAYOUT_TIER_SIZE) : TIER_SIZE;
  if (!Number.isInteger(tierSize) || tierSize < 1) throw new Error('PAYOUT_TIER_SIZE must be a whole number of payouts, e.g. 30.');
  if (!env.PAYOUT_TIERS) return { tiers: TIERS, tierSize };
  const tiers = env.PAYOUT_TIERS.split(',').map(range => {
    const [low, high = low] = range.split('-').map(value => cents(value.trim().replace(/^\$/, '')));
    if (!(low > 0 && high >= low)) throw new Error(`PAYOUT_TIERS has an invalid range "${range.trim()}". Use e.g. 3-5,6-10,10-15.`);
    return [low, high];
  });
  return { tiers, tierSize };
}

// Local convenience: load .env if present (hosts set real environment variables instead).
export function loadLocalEnv() {
  const file = fileURLToPath(new URL('./.env', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}
