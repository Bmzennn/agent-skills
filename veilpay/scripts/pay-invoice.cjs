#!/usr/bin/env node
/**
 * pay-invoice.cjs — Pay an x402 invoice via direct confidential deposit.
 *
 * Uses getPublicBalanceToEncryptedBalanceDirectDepositorFunction (same path
 * as a regular confidential transfer) instead of receiver-claimable UTXOs.
 * This means the server receives funds in "shared" mode — readable and
 * withdrawable normally — with no Arcium mxe state dependency.
 *
 * Usage:
 *   node pay-invoice.cjs '<invoice_json>' [--network devnet|mainnet]
 *
 * Invoice JSON (from a 402 response body):
 *   { "amount": 0.1, "token": "SOL", "destination": "<pubkey>", "invoiceId": "<hex>" }
 *
 * Output:
 *   AUTHORIZATION: x402 <depositTxSig>:<invoiceId>
 *
 * Key loading (priority order):
 *   1. VEILPAY_WALLET_PATH env var / ~/.veilpay/wallet.json  (base64 secretKey)
 *   2. AGENT_SECRET_KEY env var                              (base58 or base64)
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const urlMod = require("url");

// ─── Runtime patch: file:// fetch for ZK circuits ────────────────────────────
const _nativeFetch = global.fetch;
global.fetch = async (input, init) => {
  const inputUrl = typeof input === "string" ? input : input?.url;
  if (inputUrl?.startsWith("file://")) {
    const filePath = urlMod.fileURLToPath(inputUrl);
    const buffer   = fs.readFileSync(filePath);
    return {
      ok: true, status: 200,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      json:        async () => JSON.parse(buffer.toString()),
      blob:        async () => new Blob([buffer]),
    };
  }
  return _nativeFetch(input, init);
};

// ─── Args ─────────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const invoiceArg = args.find((a) => !a.startsWith("--"));
const get        = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const network    = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const walletPath = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");

if (!invoiceArg) {
  console.error('Usage: node pay-invoice.cjs \'{"amount":0.1,"token":"SOL","destination":"...","invoiceId":"..."}\' [--network devnet|mainnet]');
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const TOKEN_DECIMALS = { SOL: 9, USDC: 6, USDT: 6 };
const TOKEN_MINTS    = {
  SOL:  "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

const RPC = network === "mainnet"
  ? (process.env.VEILPAY_RPC_URL || "https://api.mainnet-beta.solana.com")
  : (process.env.VEILPAY_RPC_URL || "https://api.devnet.solana.com");

const INDEXER = network === "mainnet"
  ? "https://utxo-indexer.api.umbraprivacy.com"
  : "https://utxo-indexer.api-devnet.umbraprivacy.com";

// ─── Invoice validation ───────────────────────────────────────────────────────

function validateInvoice(data) {
  if (!data.invoiceId || typeof data.invoiceId !== "string" || !/^[0-9a-fA-F]{64}$/.test(data.invoiceId))
    throw new Error("invoiceId must be a 64-char hex string");
  if (typeof data.amount !== "number" || data.amount <= 0)
    throw new Error("amount must be a positive number");
  if (!data.destination || typeof data.destination !== "string")
    throw new Error("destination must be a valid Solana address");
  if (!data.token || !TOKEN_DECIMALS[data.token])
    throw new Error(`token must be one of: ${Object.keys(TOKEN_DECIMALS).join(", ")}`);
}

// ─── Key loading ──────────────────────────────────────────────────────────────

function loadSecretKey() {
  if (fs.existsSync(walletPath)) {
    const data = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    return Buffer.from(data.secretKey, "base64");
  }
  const raw = process.env.AGENT_SECRET_KEY;
  if (raw) {
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 64 || b64.length === 32) return b64;
    const bs58 = require("bs58");
    const b58  = bs58.default || bs58;
    return Buffer.from(b58.decode(raw));
  }
  console.error("No key found. Run: node wallet.cjs create  OR set AGENT_SECRET_KEY");
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const {
    createSignerFromPrivateKeyBytes, getUmbraClient,
    getUserAccountQuerierFunction, getUserRegistrationFunction,
    getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
    getPollingTransactionForwarder, getPollingComputationMonitor,
  } = require("@umbra-privacy/sdk");
  const { getUserRegistrationProver } = require("@umbra-privacy/web-zk-prover");
  const { Keypair } = require("@solana/web3.js");

  // Parse and validate invoice
  let invoice;
  try {
    invoice = JSON.parse(invoiceArg);
    validateInvoice(invoice);
  } catch (e) {
    console.error(`Invalid invoice: ${e.message}`);
    process.exit(1);
  }

  const decimals  = TOKEN_DECIMALS[invoice.token];
  const amountRaw = BigInt(Math.round(invoice.amount * 10 ** decimals));
  const mint      = TOKEN_MINTS[invoice.token];

  if (!mint) { console.error(`No mint for token: ${invoice.token}`); process.exit(1); }

  // Load payer keypair
  const secretBytes = loadSecretKey();
  const keypair     = secretBytes.length === 64
    ? Keypair.fromSecretKey(secretBytes)
    : Keypair.fromSeed(secretBytes.slice(0, 32));
  const signer = await createSignerFromPrivateKeyBytes(keypair.secretKey);

  console.log(`\nPayer:       ${signer.address}`);
  console.log(`Destination: ${invoice.destination}`);
  console.log(`Amount:      ${invoice.amount} ${invoice.token}`);
  console.log(`Invoice:     ${invoice.invoiceId.slice(0, 16)}…`);
  console.log(`Network:     ${network}`);

  const client = await getUmbraClient(
    { signer, network, rpcUrl: RPC,
      rpcSubscriptionsUrl: RPC.replace("https://", "wss://"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: getPollingTransactionForwarder({ rpcUrl: RPC }),
      computationMonitor:   getPollingComputationMonitor({ rpcUrl: RPC }) }
  );

  // Register payer with Umbra if first time (required for confidential deposits)
  const querier = getUserAccountQuerierFunction({ client });
  const state   = await querier(signer.address);
  if (state.state !== "exists" ||
      !state.data.isUserCommitmentRegistered ||
      !state.data.isUserAccountX25519KeyRegistered) {
    process.stdout.write("Registering payer with Umbra (first time only)… ");
    const prover   = getUserRegistrationProver({ assetProvider: { async getAssetUrls() { return { zkeyUrl: "", wasmUrl: "" }; } } });
    const register = getUserRegistrationFunction({ client }, { zkProver: prover });
    await register({ confidential: true, anonymous: true });
    console.log("done");
  }

  // Make direct confidential deposit — same mechanism as a confidential transfer.
  // Funds land in the server's encrypted balance as "shared" mode (no mxe state).
  console.log("\nSending confidential deposit…");
  console.log("⚠️  Wallet may show a simulation warning — normal for ZK/MPC transactions. Proceed anyway.\n");

  const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction({ client });
  const res     = await deposit(invoice.destination, mint, amountRaw);

  // Extract the deposit transaction signature
  const callbackSig = res?.callbackSignature?.toString() ?? null;
  const queueSig    = res?.queueSignature?.toString()    ?? null;
  const depositSig  = callbackSig || queueSig || "";

  if (!depositSig) {
    console.error("No transaction signature returned. Payment may not have been processed.");
    process.exit(1);
  }

  const authValue = `x402 ${depositSig}:${invoice.invoiceId}`;

  console.log("✅ Payment sent!");
  console.log(`\nAUTHORIZATION: ${authValue}`);
  console.log("\nRetry your request with:");
  console.log(`  -H "Authorization: ${authValue}"`);
  console.log("\n⏳ Wait 10–15 seconds before retrying — indexer sync window.");

  if (process.env.DEBUG) {
    const safe = (_, v) => typeof v === "bigint" ? v.toString() : v;
    console.log("\n[DEBUG] Raw response:", JSON.stringify(res, safe, 2));
  }

  process.exit(0);
})().catch((e) => {
  console.error("\n❌ Payment failed:", e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
