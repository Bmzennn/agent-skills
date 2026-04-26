#!/usr/bin/env node
/**
 * pay-invoice.cjs — Pay an x402 invoice via shielded UTXO (receiver-claimable).
 *
 * Uses getPublicBalanceToReceiverClaimableUtxoCreatorFunction to create a
 * receiver-claimable UTXO for the server. The server's Solana address does NOT
 * appear in the transaction — the destination is encrypted on-chain using the
 * server's X25519 public key. This provides full payer-server unlinkability.
 *
 * The invoiceId (32 bytes from the 402 response) is embedded as the UTXO's
 * optionalData, committing to the specific invoice being paid.
 *
 * Usage:
 *   node pay-invoice.cjs '<invoice_json>' [--network devnet|mainnet] [--no-wait]
 *
 * Invoice JSON (from a 402 response body):
 *   { "amount": 0.1, "token": "SOL", "destination": "<pubkey>", "invoiceId": "<hex>" }
 *
 * Output:
 *   AUTHORIZATION: x402 <proofAccountSig>:<utxoSig>:<invoiceId>
 *
 * Key loading (priority order):
 *   1. VEILPAY_WALLET_PATH env var / ~/.veilpay/wallet.json  (base64 secretKey)
 *   2. AGENT_SECRET_KEY env var                              (base58 or base64)
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const https  = require("https");
const crypto = require("crypto");
const urlMod = require("url");

// ─── Runtime patch: file:// fetch for ZK circuits ────────────────────────────
// Node.js native fetch (Undici) cannot handle file:// URIs.
// The ZK prover downloads circuits to ~/.veilpay/zk-cache/ then loads via file://.
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
const has        = (f) => args.includes(f);

const network    = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const walletPath = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");
const noWait     = has("--no-wait");

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

const CDN_BASE = "https://d3j9fjdkre529f.cloudfront.net";
const ZK_CACHE = path.join(os.homedir(), ".veilpay", "zk-cache");

// ─── Invoice validation ───────────────────────────────────────────────────────

function validateInvoice(invoice) {
  if (!invoice.amount || !invoice.token || !invoice.destination || !invoice.invoiceId) {
    throw new Error("Missing required invoice fields (amount, token, destination, invoiceId)");
  }
  if (!TOKEN_DECIMALS[invoice.token]) {
    throw new Error(`token must be one of: ${Object.keys(TOKEN_DECIMALS).join(", ")}`);
  }
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

// ─── ZK Asset Provider (Node.js, local cache) ────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp  = dest + ".tmp";
    const file = fs.createWriteStream(tmp);
    // User-Agent required — CloudFront returns 403 on headless/bot requests
    const opts = { headers: { "User-Agent": "Mozilla/5.0 (compatible; VeilPayAgent/1.0)" } };
    https.get(url, opts, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      res.pipe(file);
      file.on("finish", () => { file.close(); fs.renameSync(tmp, dest); resolve(); });
      file.on("error", (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
    }).on("error", reject);
  });
}

function makeNodeZkAssetProvider() {
  fs.mkdirSync(ZK_CACHE, { recursive: true });
  let manifest = null;

  return {
    async getAssetUrls(type, variant) {
      if (!manifest) {
        const res = await fetch(`${CDN_BASE}/manifest.json`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; VeilPayAgent/1.0)" },
        });
        if (!res.ok) throw new Error(`ZK manifest fetch failed: ${res.status}`);
        manifest = await res.json();
      }

      const entry = manifest.assets[type];
      if (!entry) throw new Error(`ZK type '${type}' not found in manifest`);

      let rawUrl = variant && !("url" in entry) ? entry[variant]?.url : entry.url;
      if (!rawUrl) throw new Error(`No URL for ZK type '${type}'`);

      const fullZkeyUrl = rawUrl.startsWith("http") ? rawUrl : `${CDN_BASE}/${rawUrl}`;
      const fullWasmUrl = fullZkeyUrl.replace(/\.zkey$/i, ".wasm");

      const key      = crypto.createHash("md5").update(fullZkeyUrl).digest("hex");
      const zkeyPath = path.join(ZK_CACHE, `${key}.zkey`);
      const wasmPath = path.join(ZK_CACHE, `${key}.wasm`);

      if (!fs.existsSync(zkeyPath)) {
        process.stdout.write(`  Downloading ${type}.zkey (cached after first run)… `);
        await downloadFile(fullZkeyUrl, zkeyPath);
        process.stdout.write("done\n");
      }
      if (!fs.existsSync(wasmPath)) {
        process.stdout.write(`  Downloading ${type}.wasm… `);
        await downloadFile(fullWasmUrl, wasmPath);
        process.stdout.write("done\n");
      }

      return { zkeyUrl: `file://${zkeyPath}`, wasmUrl: `file://${wasmPath}` };
    },
  };
}

/**
 * Custom transaction forwarder for AI agents that skips preflight simulation.
 * Essential for devnet reliability when sending multiple transactions in sequence.
 */
function makeAgentForwarder(connection) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async fireAndForget(tx) {
      // Re-encode from messageBytes + signatures to ensure exact bytes are preserved
      const sigs = Object.values(tx.signatures);
      
      const encodeU16 = (n) => {
        if (n < 0x80) return [n];
        return [(n & 0x7f) | 0x80, n >> 7];
      };

      const countBytes = new Uint8Array(encodeU16(sigs.length));
      const wire = new Uint8Array(countBytes.length + sigs.length * 64 + tx.messageBytes.length);
      wire.set(countBytes, 0);
      let off = countBytes.length;
      for (const sig of sigs) {
        wire.set(sig || new Uint8Array(64), off);
        off += 64;
      }
      wire.set(tx.messageBytes, off);

      return connection.sendRawTransaction(wire, { skipPreflight: true });
    },
    async forwardSequentially(transactions) {
      const sigs = [];
      for (const tx of transactions) sigs.push(await this.fireAndForget(tx));
      return sigs;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const {
    createSignerFromPrivateKeyBytes, getUmbraClient,
    getUserAccountQuerierFunction, getUserRegistrationFunction,
    getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
  } = require("@umbra-privacy/sdk");
  const {
    getUserRegistrationProver,
    getCreateReceiverClaimableUtxoFromPublicBalanceProver,
  } = require("@umbra-privacy/web-zk-prover");
  const { Keypair, Connection, LAMPORTS_PER_SOL } = require("@solana/web3.js");

  // Parse and validate invoice
  let invoice;
  try {
    invoice = JSON.parse(invoiceArg);
    validateInvoice(invoice);
  } catch (e) {
    console.error(`Invalid invoice: ${e.message}`);
    process.exit(1);
  }

  const decimals   = TOKEN_DECIMALS[invoice.token];
  const amountRaw  = BigInt(Math.round(invoice.amount * 10 ** decimals));
  const mint       = TOKEN_MINTS[invoice.token];

  if (!mint) { console.error(`No mint for token: ${invoice.token}`); process.exit(1); }

  // invoiceId bytes (32 bytes from 64-char hex)
  const invoiceIdMatch = invoice.invoiceId.match(/.{1,2}/g);
  if (!invoiceIdMatch) { console.error("Invalid invoiceId hex"); process.exit(1); }
  const invoiceBytes = new Uint8Array(invoiceIdMatch.map((b) => parseInt(b, 16)));

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

  // Check Balance
  const connection = new Connection(RPC, "confirmed");
  const balance = await connection.getBalance(keypair.publicKey, "confirmed");
  const balanceSol = balance / LAMPORTS_PER_SOL;
  const minRequired = invoice.amount + 0.02; // amount + buffer for fees/registration
  
  if (balanceSol < minRequired) {
    console.error(`\n❌ Insufficient SOL. Agent has ${balanceSol.toFixed(3)} SOL but needs at least ${minRequired.toFixed(3)} SOL.`);
    process.exit(1);
  }

  const assetProvider = makeNodeZkAssetProvider();

  const client = await getUmbraClient(
    { signer, network, rpcUrl: RPC,
      rpcSubscriptionsUrl: RPC.replace("http", "ws"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: makeAgentForwarder(connection) }
  );

  // Register payer if first time (UTXO creation requires sender commitment on-chain)
  const querier = getUserAccountQuerierFunction({ client });
  const state   = await querier(signer.address);
  if (state.state !== "exists" ||
      !state.data.isUserCommitmentRegistered ||
      !state.data.isUserAccountX25519KeyRegistered) {
    process.stdout.write("Registering payer with Umbra (first time only)… ");
    const regProver  = getUserRegistrationProver({ assetProvider });
    const register   = getUserRegistrationFunction({ client }, { zkProver: regProver });
    await register({ confidential: true, anonymous: true });
    console.log("done");
  }

  // Create shielded UTXO for the server with invoiceId in optionalData.
  // Two transactions: createProofAccount + createUtxo.
  // The server's Solana address does NOT appear in either transaction.
  console.log("\nComputing ZK proof (may take 15–30s)…");

  const utxoProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver({ assetProvider });
  const createUtxo = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
    { client },
    { zkProver: utxoProver }
  );

  const result = await createUtxo(
    { destinationAddress: invoice.destination, mint, amount: amountRaw },
    { optionalData: invoiceBytes }
  );

  const proofTxSig = result.createProofAccountSignature.toString();
  const depositSig = result.createUtxoSignature.toString();

  if (!proofTxSig || !depositSig) {
    console.error("No transaction signatures returned. Payment may not have been processed.");
    process.exit(1);
  }

  const authValue = `x402 ${proofTxSig}:${depositSig}:${invoice.invoiceId}`;

  console.log("✅ Shielded UTXO created!");
  console.log(`\nAUTHORIZATION: ${authValue}`);

  if (!noWait) {
    console.log("\n⏳ Waiting 15 seconds for indexer sync (mandatory for server verification)…");
    await new Promise(r => setTimeout(r, 15000));
    console.log("✅ Ready! Use the header below for your request.");
  } else {
    console.log("\n⏳ Skip-wait enabled. Ensure 10-15s passes before retrying.");
  }

  console.log(`\n  -H "Authorization: ${authValue}"`);

  if (process.env.DEBUG) {
    console.log("\n[DEBUG] Proof tx:  ", proofTxSig);
    console.log("[DEBUG] UTXO tx:   ", depositSig);
  }
})().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
