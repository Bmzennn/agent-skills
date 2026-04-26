#!/usr/bin/env node
/**
 * pay-invoice.cjs — Pay an x402 invoice with a shielded Umbra deposit.
 *
 * Use this when an API responds with HTTP 402 Payment Required.
 * Parse the invoice from the response, pass it here, and get back the
 * Authorization header value to retry the request.
 *
 * Usage:
 *   node pay-invoice.cjs '<invoice_json>' [--network devnet|mainnet]
 *
 * Invoice JSON format (from a 402 response body):
 *   { "amount": 0.1, "token": "SOL", "destination": "<pubkey>", "invoiceId": "<hex>" }
 *
 * Output (on success):
 *   AUTHORIZATION: x402 <proofTxSig>:<depositTxSig>:<invoiceId>
 *   Use this value as the Authorization header when retrying the request.
 *
 * Key loading (in order of priority):
 *   1. VEILPAY_WALLET_PATH env var  → reads base64 secretKey from wallet.cjs format
 *   2. AGENT_SECRET_KEY env var      → accepts base58 or base64 raw secret key
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const urlMod = require("url");

// ─── Runtime patch: file:// fetch support ────────────────────────────────────
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

const args      = process.argv.slice(2);
const invoiceArg = args.find((a) => !a.startsWith("--"));
const get       = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const network    = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const walletPath = process.env.VEILPAY_WALLET_PATH || path.join(os.homedir(), ".veilpay", "wallet.json");

if (!invoiceArg) {
  console.error('Usage: node pay-invoice.cjs \'{"amount":0.1,"token":"SOL","destination":"...","invoiceId":"..."}\' [--network devnet|mainnet]');
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC = network === "mainnet"
  ? (process.env.VEILPAY_RPC_URL || "https://api.mainnet-beta.solana.com")
  : (process.env.VEILPAY_RPC_URL || "https://api.devnet.solana.com");

const INDEXER = network === "mainnet"
  ? "https://utxo-indexer.api.umbraprivacy.com"
  : "https://utxo-indexer.api-devnet.umbraprivacy.com";

const TOKEN_DECIMALS = { SOL: 9, USDC: 6, USDT: 6 };

const ZK_CACHE_DIR = path.join(os.homedir(), ".veilpay", "zk-cache");
const CDN_BASE     = "https://d3j9fjdkre529f.cloudfront.net";

// ─── Secure fetch (no global monkey-patch) ────────────────────────────────────
// Handles file:// URLs for local ZK circuit files without touching global.fetch.

async function secureFetch(input, init) {
  const inputUrl = typeof input === "string" ? input : input.url;

  if (inputUrl.startsWith("file://")) {
    const filePath    = urlMod.fileURLToPath(inputUrl);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(ZK_CACHE_DIR))) {
      throw new Error(`Security: file access outside ZK cache dir is forbidden (${resolvedPath})`);
    }
    const buffer = fs.readFileSync(filePath);
    return {
      ok: true, status: 200,
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      json:        async () => JSON.parse(buffer.toString()),
      blob:        async () => new Blob([buffer]),
    };
  }

  if (!inputUrl.startsWith("https://")) {
    throw new Error(`Security: only HTTPS URLs allowed (got: ${inputUrl})`);
  }

  // Inject User-Agent — CloudFront CDN returns 403 on headless/bot requests
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; VeilPayAgent/1.0)", ...(init?.headers || {}) };
  return global.fetch(input, { ...init, headers });
}

// ─── ZK Asset Provider ────────────────────────────────────────────────────────

const assetProvider = {
  async getAssetUrls(type, variant) {
    fs.mkdirSync(ZK_CACHE_DIR, { recursive: true, mode: 0o700 });

    const res      = await secureFetch(`${CDN_BASE}/manifest.json`);
    const manifest = await res.json();
    const entry    = manifest.assets[type];
    if (!entry) throw new Error(`ZK type '${type}' not in manifest`);

    const urlPath  = variant && !("url" in entry) ? entry[variant]?.url : entry.url;
    const fileName = path.basename(urlPath); // basename prevents directory traversal
    const wasmName = fileName.replace(/\.zkey$/i, ".wasm");

    const zkeyPath = path.join(ZK_CACHE_DIR, fileName);
    const wasmPath = path.join(ZK_CACHE_DIR, wasmName);

    const download = async (remoteUrl, localPath) => {
      if (fs.existsSync(localPath)) return urlMod.pathToFileURL(localPath).href;
      process.stdout.write(`  Downloading ${path.basename(localPath)} (cached after first run)… `);
      const resp   = await secureFetch(remoteUrl.startsWith("http") ? remoteUrl : `${CDN_BASE}/${remoteUrl}`);
      const buffer = await resp.arrayBuffer();
      fs.writeFileSync(localPath, Buffer.from(buffer));
      process.stdout.write("done\n");
      return urlMod.pathToFileURL(localPath).href;
    };

    const fullZkeyUrl = urlPath.startsWith("http") ? urlPath : `${CDN_BASE}/${urlPath}`;
    const fullWasmUrl = fullZkeyUrl.replace(/\.zkey$/i, ".wasm");

    const [zkeyUrl, wasmUrl] = await Promise.all([
      download(fullZkeyUrl, zkeyPath),
      download(fullWasmUrl, wasmPath),
    ]);
    return { zkeyUrl, wasmUrl };
  },
};

// ─── Key loading ──────────────────────────────────────────────────────────────
// Supports wallet.cjs format (base64) and legacy AGENT_SECRET_KEY (base58/base64).

function loadSecretKey() {
  // Priority 1: wallet.cjs file
  if (fs.existsSync(walletPath)) {
    const data = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    return Buffer.from(data.secretKey, "base64");
  }

  // Priority 2: AGENT_SECRET_KEY env var (base58 or base64)
  const raw = process.env.AGENT_SECRET_KEY;
  if (raw) {
    // Try base64 first
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 64 || b64.length === 32) return b64;
    // Fall back to bs58
    const bs58 = require("bs58");
    const b58  = bs58.default || bs58;
    return Buffer.from(b58.decode(raw));
  }

  console.error(`No key found. Either:`);
  console.error(`  1. Create a wallet: node wallet.cjs create`);
  console.error(`  2. Set AGENT_SECRET_KEY env var`);
  process.exit(1);
}

// ─── Invoice validation ───────────────────────────────────────────────────────

function validateInvoice(data) {
  if (!data.invoiceId || typeof data.invoiceId !== "string" || !/^[0-9a-fA-F]{64}$/.test(data.invoiceId))
    throw new Error("invoiceId must be a 64-char hex string");
  if (typeof data.amount !== "number" || data.amount <= 0)
    throw new Error("amount must be a positive number");
  if (!data.destination || typeof data.destination !== "string" || data.destination.length < 32)
    throw new Error("destination must be a valid Solana address");
  if (!data.token || !TOKEN_DECIMALS[data.token])
    throw new Error(`token must be one of: ${Object.keys(TOKEN_DECIMALS).join(", ")}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const {
    createSignerFromPrivateKeyBytes, getUmbraClient,
    getUserAccountQuerierFunction, getUserRegistrationFunction,
    getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
    getPollingTransactionForwarder, getPollingComputationMonitor,
  } = require("@umbra-privacy/sdk");
  const {
    getCreateReceiverClaimableUtxoFromPublicBalanceProver,
    getUserRegistrationProver,
  } = require("@umbra-privacy/web-zk-prover");
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

  // Load keypair
  const secretBytes = loadSecretKey();
  const keypair     = secretBytes.length === 64
    ? Keypair.fromSecretKey(secretBytes)
    : Keypair.fromSeed(secretBytes.slice(0, 32));
  const signer = await createSignerFromPrivateKeyBytes(keypair.secretKey);

  console.log(`\nPaying invoice ${invoice.invoiceId.slice(0, 12)}…`);
  console.log(`  Amount:      ${invoice.amount} ${invoice.token}`);
  console.log(`  Destination: ${invoice.destination.slice(0, 8)}…`);
  console.log(`  Network:     ${network}`);

  const client = await getUmbraClient(
    { signer, network, rpcUrl: RPC,
      rpcSubscriptionsUrl: RPC.replace("https://", "wss://"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: getPollingTransactionForwarder({ rpcUrl: RPC }),
      computationMonitor:   getPollingComputationMonitor({ rpcUrl: RPC }) }
  );

  // Register sender if first time (required by Umbra before creating a UTXO)
  const querier = getUserAccountQuerierFunction({ client });
  const state   = await querier(signer.address);
  if (state.state !== "exists" ||
      !state.data.isUserCommitmentRegistered ||
      !state.data.isUserAccountX25519KeyRegistered) {
    process.stdout.write("  Registering Umbra account (first time only)… ");
    const regProver  = getUserRegistrationProver({ assetProvider });
    const register   = getUserRegistrationFunction({ client }, { zkProver: regProver });
    await register({ confidential: true, anonymous: true });
    console.log("done");
  }

  // Generate ZK proof and create the shielded UTXO
  process.stdout.write("  Generating ZK proof (10–30s)… ");
  const prover    = getCreateReceiverClaimableUtxoFromPublicBalanceProver({ assetProvider });
  const createUtxo = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
    { client },
    { zkProver: prover }
  );

  const TOKEN_MINTS = {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  };

  const result = await createUtxo(
    { destinationAddress: invoice.destination, mint: TOKEN_MINTS[invoice.token], amount: amountRaw },
    { optionalData: new Uint8Array(Buffer.from(invoice.invoiceId, "hex")) }
  );
  console.log("done");

  const authValue = `x402 ${result.createProofAccountSignature}:${result.createUtxoSignature}:${invoice.invoiceId}`;

  console.log("\n✅ Invoice paid.");
  console.log(`\nAUTHORIZATION: ${authValue}`);
  console.log("\nRetry your request with:");
  console.log(`  -H "Authorization: ${authValue}"`);
})().catch((e) => {
  console.error("\n❌ Payment failed:", e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
