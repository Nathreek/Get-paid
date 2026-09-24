// Builds the store from environment variables. Shared by server.mjs (local/VPS) and api/ (Vercel).
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './dist/config.js';
import { createStore } from './store.mjs';
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
  });
}

// Local convenience: load .env if present (hosts set real environment variables instead).
export function loadLocalEnv() {
  const file = fileURLToPath(new URL('./.env', import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}
