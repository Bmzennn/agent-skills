#!/usr/bin/env node
/**
 * check-link.cjs — Check the status of a VeilPay private payment link.
 *
 * Usage:
 *   node check-link.cjs --link "<full_claim_url>" [--network devnet|mainnet]
 *
 * Returns: pending | claimed | delivered | not_found
 */

"use strict";

const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");

// ─── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const linkArg = get("--link");
const network = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";

if (!linkArg) {
  console.error("Usage: node check-link.cjs --link <url> [--network devnet|mainnet]");
  process.exit(1);
}

// ─── Parse claim secret from URL ─────────────────────────────────────────────

const hashIdx = linkArg.indexOf("#");
if (hashIdx === -1) {
  console.error("Error: No claim key found in link (missing # fragment).");
  process.exit(1);
}

const fragment = linkArg.slice(hashIdx + 1);
const firstColon = fragment.indexOf(":");
const claimSecretB58 = firstColon === -1 ? fragment : fragment.slice(0, firstColon);
const rest = firstColon === -1 ? "" : fragment.slice(firstColon + 1);
const secondColon = rest.indexOf(":");
const token = secondColon === -1 ? rest : rest.slice(0, secondColon);
const memo = secondColon === -1 ? null : decodeURIComponent(rest.slice(secondColon + 1));

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC = network === "mainnet"
  ? (process.env.VEILPAY_RPC_URL || "https://api.mainnet-beta.solana.com")
  : (process.env.VEILPAY_RPC_URL || "https://api.devnet.solana.com");

const INDEXER = network === "mainnet"
  ? "https://utxo-indexer.api.umbraprivacy.com"
  : "https://utxo-indexer.api-devnet.umbraprivacy.com";

const RELAYER = network === "mainnet"
  ? "https://relayer.api.umbraprivacy.com"
  : "https://relayer.api-devnet.umbraprivacy.com";

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const { createSignerFromPrivateKeyBytes, getUmbraClient,
          getClaimableUtxoScannerFunction, getEncryptedBalanceQuerierFunction,
          getPollingTransactionForwarder, getPollingComputationMonitor } = require("@umbra-privacy/sdk");
  const { ReadServiceClient } = require("@umbra-privacy/indexer-read-service-client");
  const { Keypair } = require("@solana/web3.js");

  console.log(`Checking link status on ${network}…`);

  // Reconstruct ephemeral signer
  const ephemeralPrivateKey = bs58.default ? bs58.default.decode(claimSecretB58) : bs58.decode(claimSecretB58);
  const keypair = Keypair.fromSeed(
    ephemeralPrivateKey.length === 32 ? ephemeralPrivateKey : ephemeralPrivateKey.slice(0, 32)
  );
  const secretKey64 = keypair.secretKey;

  const signer = await createSignerFromPrivateKeyBytes(secretKey64);

  const client = await getUmbraClient(
    { signer, network, rpcUrl: RPC, rpcSubscriptionsUrl: RPC.replace("https://", "wss://"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: getPollingTransactionForwarder({ rpcUrl: RPC }),
      computationMonitor: getPollingComputationMonitor({ rpcUrl: RPC }) }
  );

  // Check SOL balance — a near-zero balance means funds were swept (claimed + delivered)
  const connection = new Connection(RPC, "confirmed");
  const solBalance = await connection.getBalance(new PublicKey(signer.address.toString()), "confirmed");

  if (solBalance < 5_000_000) { // < 0.005 SOL
    console.log("\nStatus: delivered");
    console.log("The ephemeral wallet has been swept — payment reached the recipient.");
    return;
  }

  // ── Gate 2: Encrypted balance ─────────────────────────────────────────────
  // Check this BEFORE the indexer. After a ZK claim, the encrypted balance
  // updates within seconds, but the indexer can lag 30–120s and still show
  // the UTXO as unspent — causing a false "pending" if checked first.
  const TOKEN_MINTS = {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  };
  const mint = TOKEN_MINTS[token] || TOKEN_MINTS.SOL;
  const querier = getEncryptedBalanceQuerierFunction({ client });
  const balMap = await querier([mint]);
  const bal = balMap.get(mint);
  if (bal?.state === "shared" && BigInt(bal.balance.toString()) > 0n) {
    const decimals = token === "USDC" || token === "USDT" ? 6 : 9;
    const human = (Number(BigInt(bal.balance.toString())) / 10 ** decimals).toFixed(decimals === 6 ? 2 : 4);
    console.log("\nStatus: claimed");
    console.log(`Amount: ${human} ${token || "SOL"}`);
    console.log("ZK proof accepted — funds are in the ephemeral encrypted balance, sweep in progress.");
    process.exit(0);
  }

  // ── Gate 3: Indexer UTXO ─────────────────────────────────────────────────
  // Slowest source of truth — check last. Indexer lags behind on-chain state.
  const readClient = new ReadServiceClient({ endpoint: INDEXER });
  const stats = await readClient.getStats();
  const MAX_LEAVES = 1n << 20n;

  let hasUtxo = false;
  let utxoAmount = null;
  if (stats.latest_absolute_index !== null) {
    // Cast to BigInt — indexer returns Number, MAX_LEAVES is BigInt literal.
    // Mixed arithmetic throws: "Cannot mix BigInt and other types".
    const current = BigInt(stats.latest_absolute_index) / MAX_LEAVES;
    const indices = current > 0n ? [current, current - 1n] : [0n];
    const scanner = getClaimableUtxoScannerFunction({ client });
    for (const idx of indices) {
      const result = await scanner(idx, 0n);
      if (result.publicReceived.length > 0) {
        hasUtxo = true;
        utxoAmount = result.publicReceived[0].amount;
        break;
      }
    }
  }

  if (hasUtxo) {
    const decimals = token === "USDC" || token === "USDT" ? 6 : 9;
    const human = (Number(utxoAmount) / 10 ** decimals).toFixed(decimals === 6 ? 2 : 4);
    console.log("\nStatus: pending");
    console.log(`Amount: ${human} ${token || "SOL"}`);
    console.log("Funds are in the shielded pool, waiting to be claimed.");
    if (memo) console.log(`Memo: "${memo}"`);
    process.exit(0);
  }

  console.log("\nStatus: not_found");
  console.log("No payment detected. The link may have expired, already been fully claimed, or the key is incorrect.");
  process.exit(0);
})().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
