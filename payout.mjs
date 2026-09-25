// Sends SOL from the payout wallet. The private key only ever lives in the server environment.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, SendTransactionError } from '@solana/web3.js';
import bs58 from 'bs58';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
// Left in the wallet after every payout: the network fee plus the rent minimum, since a balance below it cannot be left behind.
const FEE_RESERVE = 900_000;

export function parseSecretKey(value) {
  const text = String(value || '').trim();
  const bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text);
  if (bytes.length !== 64) throw new Error('PAYOUT_PRIVATE_KEY must be a 64-byte Solana secret key (base58 or JSON array).');
  return Keypair.fromSecretKey(bytes);
}

// Live SOL/USD price from Jupiter, with CoinGecko as a fallback. Out-of-range prices are refused.
export async function solPrice(fetcher = fetch) {
  const sources = [
    ['https://lite-api.jup.ag/price/v3?ids=' + SOL_MINT, data => data?.[SOL_MINT]?.usdPrice],
    ['https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', data => data?.solana?.usd],
  ];
  for (const [url, read] of sources) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(6000) });
      const price = Number(read(response.ok ? await response.json() : null));
      if (price > 1 && price < 100000) return price;
    } catch {}
  }
  throw new Error('SOL price is unavailable.');
}

export const lamportsFor = (cents, price) => Math.round(cents / 100 / price * LAMPORTS_PER_SOL);

// Takes the secret key from the environment, or an already derived keypair (a launched coin's wallet).
export function createPayer({ rpcUrl, secretKey, keypair = parseSecretKey(secretKey) }) {
  const connection = new Connection(rpcUrl, 'confirmed');
  return {
    address: keypair.publicKey.toBase58(),
    balance: () => connection.getBalance(keypair.publicKey),
    async canAfford(lamports) { return await connection.getBalance(keypair.publicKey) >= lamports + FEE_RESERVE; },
    // Signs first so the signature can be saved before broadcasting; a crash can then be reconciled without paying twice.
    async prepare(to, lamports) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight })
        .add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(to), lamports }));
      transaction.sign(keypair);
      const signature = bs58.encode(transaction.signature);
      return {
        signature, lastValidBlockHeight,
        // Resolves 'confirmed' or 'failed'. Throws { rejected: true } when the network refused it outright (never landed).
        async send() {
          try { await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 5 }); }
          catch (error) { if (error instanceof SendTransactionError) throw Object.assign(error, { rejected: true }); throw error; }
          const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
          return result.value.err ? 'failed' : 'confirmed';
        },
      };
    },
    // 'confirmed' | 'failed' | 'expired' (can never land) | 'pending'
    async status(signature, lastValidBlockHeight) {
      const { value: [found] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      if (found?.confirmationStatus === 'confirmed' || found?.confirmationStatus === 'finalized') return found.err ? 'failed' : 'confirmed';
      if (found) return 'pending';
      return await connection.getBlockHeight('confirmed') > lastValidBlockHeight ? 'expired' : 'pending';
    },
  };
}
