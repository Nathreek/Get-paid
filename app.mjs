// Builds the store (and the coin launcher) from environment variables. Shared by server.mjs (local/VPS) and api/ (Vercel).
import { existsSync, mkdirSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { fileURLToPath } from 'node:url';
import { config } from './dist/config.js';
import { createStore, MAIN_COIN, TIERS, TIER_SIZE } from './store.mjs';
import { createVerifier, createRecheck } from './verify.mjs';
import { createPayer, parseSecretKey, solPrice } from './payout.mjs';
import { createFeeClaimer, createLauncher, createPinata } from './launch.mjs';
import { parseMasterSeed } from './wallets.mjs';

export async function createApp(env = process.env) {
  let url = env.TURSO_DATABASE_URL;
  if (!url) {
    if (env.VERCEL) throw new Error('TURSO_DATABASE_URL is required on Vercel; local files there are temporary.');
    const dir = fileURLToPath(new URL('./data/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    url = 'file:' + dir + 'get-paid.db';
  }
  const rpcUrl = env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const payer = env.PAYOUT_PRIVATE_KEY ? createPayer({ rpcUrl, secretKey: env.PAYOUT_PRIVATE_KEY }) : null;
  if (payer) console.log(`Payout wallet: ${payer.address}`);
  const payoutsEnabled = env.PAYOUTS_ENABLED === 'true';
  if (payoutsEnabled && !payer) console.warn('PAYOUTS_ENABLED is true but PAYOUT_PRIVATE_KEY is missing; nothing will be sent.');
  const treasuryKey = env.PAYOUT_PRIVATE_KEY ? parseSecretKey(env.PAYOUT_PRIVATE_KEY) : null;
  const treasury = treasuryKey ? createFeeClaimer({ rpcUrl }) : null;

  // Launched coins: one wallet each, derived from MASTER_SEED. Without it, launching is switched off.
  const seed = env.MASTER_SEED ? parseMasterSeed(env.MASTER_SEED) : null;
  let launcher = null;
  const coinPayers = new Map();
  const payerFor = coin => {
    if (coin.id === MAIN_COIN) return payer;
    if (!launcher) return null;
    if (!coinPayers.has(coin.id)) coinPayers.set(coin.id, createPayer({ rpcUrl, keypair: launcher.walletFor(coin.walletIndex) }));
    return coinPayers.get(coin.id);
  };

  const store = await createStore({
    url, authToken: env.TURSO_AUTH_TOKEN,
    verify: createVerifier({
      ticker: config.ticker, coinAddress: config.coinAddress,
      campaignStart: env.CAMPAIGN_START ? Date.parse(env.CAMPAIGN_START) || 0 : 0,
      llm: { apiKey: env.GROQ_API_KEY, baseUrl: env.LLM_BASE_URL || 'https://api.groq.com/openai/v1', model: env.LLM_MODEL || 'openai/gpt-oss-120b' },
    }),
    recheck: createRecheck(),
    mainCoin: { ticker: config.ticker, coinAddress: config.coinAddress, payoutWallet: payer?.address || null },
    payerFor,
    // Tops a coin's wallet up from its pump.fun creator rewards. For the site's own coin that is the treasury
    // (PAYOUT_PRIVATE_KEY): rewards it earned as the coin's creator, or its share if the dev set up fee sharing to it.
    claimFees: async coin => {
      if (coin.id !== MAIN_COIN) return launcher ? launcher.claimFees(coin.walletIndex) : false;
      if (!treasury) return false;
      const own = await treasury.claim(treasuryKey, 'the treasury');
      const shared = coin.coinAddress ? await treasury.distribute(new PublicKey(coin.coinAddress), treasuryKey, `$${coin.ticker}`) : false;
      return own || shared;
    },
    // What a coin can still pay out: its wallet balance plus its unclaimed creator rewards.
    feePool: async coin => {
      const wallet = payerFor(coin);
      if (!wallet) return null;
      const rewards = coin.id === MAIN_COIN ? treasury?.unclaimed(treasuryKey.publicKey) : launcher?.unclaimed(coin.walletIndex);
      const [balance, unclaimed] = await Promise.all([wallet.balance(), rewards ?? 0]);
      return balance + unclaimed;
    },
    price: solPrice, payoutsEnabled,
    cluster: /devnet/i.test(rpcUrl) ? 'devnet' : 'mainnet',
    payoutIntervalMs: Number(env.PAYOUT_INTERVAL_SECONDS || 10) * 1000,
    dailyCapCents: Math.round(Number(env.MAX_DAILY_PAYOUT_USD || 100) * 100),
    maxPerAccount: Number(env.MAX_PAYOUTS_PER_ACCOUNT || 1),
    ...payoutAmounts(env),
  });

  if (seed) {
    launcher = createLauncher({
      rpcUrl, seed, store,
      upload: env.PINATA_JWT ? createPinata({ jwt: env.PINATA_JWT, gateway: env.PINATA_GATEWAY || undefined }) : null,
      feePayer: treasuryKey,
    });
    if (env.PINATA_JWT) console.log(`Coin launches are on. Coin wallet #1: ${launcher.walletFor(1).publicKey.toBase58()}`);
    else console.warn('PINATA_JWT is missing: launched coins keep paying out, but new launches are off.');
  }
  return { store, launcher };
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
