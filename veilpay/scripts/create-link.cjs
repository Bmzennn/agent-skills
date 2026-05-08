#!/usr/bin/env node
/**
 * create-link.cjs — Create a VeilPay private payment link from the agent's wallet.
 *
 * Usage:
 *   node create-link.cjs --amount 0.5 --token SOL [options]
 *
 * Options:
 *   --amount <number>     Amount to send (required)
 *   --token <SOL|USDC>    Token to send (default: SOL)
 *   --network <devnet|mainnet>  (default: mainnet)
 *   --memo "<text>"       Optional message encoded in the link (max 200 chars)
 *   --lock-to <address>   Lock claiming to a specific wallet address
 *   --wallet <path>       Path to agent wallet (default: ~/.veilpay/wallet.json)
 *   --expiry-days <n>     Link expiry in days (default: 7)
 *
 * The sender is the agent's own wallet. No browser or wallet adapter needed —
 * the agent signs all transactions directly with its raw keypair.
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const https  = require("https");
const crypto = require("crypto");
const urlMod = require("url");

// ─── Runtime patches ─────────────────────────────────────────────────────────
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

const args = process.argv.slice(2);
const get  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const amountArg   = get("--amount");
const token       = (get("--token") || "SOL").toUpperCase();
const network     = get("--network") || process.env.VEILPAY_NETWORK || "mainnet"; // mainnet is the production default
const memo        = get("--memo");
const lockTo      = get("--lock-to");
const walletPath  = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");
const expiryDays  = parseInt(get("--expiry-days") || "7", 10);

if (!amountArg || isNaN(parseFloat(amountArg))) {
  console.error("Usage: node create-link.cjs --amount <number> --token <SOL|USDC> [options]");
  process.exit(1);
}

const TOKEN_CONFIG = {
  SOL:   { mint: "So11111111111111111111111111111111111111112",          decimals: 9 },
  USDC:  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",       decimals: 6 },
  USDT:  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",       decimals: 6 },
  UMBRA: { mint: "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta",        decimals: 6 },
  CASH:  { mint: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",      decimals: 6 },
};

if (!TOKEN_CONFIG[token]) {
  console.error(`Unsupported token: ${token}. Use SOL, USDC, USDT, UMBRA, or CASH.`);
  process.exit(1);
}

const tokenCfg    = TOKEN_CONFIG[token];
const amountRaw   = BigInt(Math.round(parseFloat(amountArg) * 10 ** tokenCfg.decimals));

const RPC = network === "mainnet"
  ? (process.env.VEILPAY_RPC_URL || "https://api.mainnet-beta.solana.com")
  : (process.env.VEILPAY_RPC_URL || "https://api.devnet.solana.com");

const INDEXER = network === "mainnet"
  ? "https://utxo-indexer.api.umbraprivacy.com"
  : "https://utxo-indexer.api-devnet.umbraprivacy.com";

const CDN_BASE  = "https://d3j9fjdkre529f.cloudfront.net";
const ZK_CACHE  = path.join(os.homedir(), ".veilpay", "zk-cache");
const SITE_BASE = process.env.VEILPAY_SITE_URL || "https://veilpayments.xyz";

/** Minimum SOL to send to ephemeral account to cover registration + withdrawal fees (0.02 SOL) */
const EPHEMERAL_BUFFER = 20_000_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp  = dest + ".tmp";
    const file = fs.createWriteStream(tmp);
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
            headers: { "User-Agent": "Mozilla/5.0 (compatible; VeilPayAgent/1.0)" }
        });
        if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
        manifest = await res.json();
      }

      const entry = manifest.assets[type];
      if (!entry) throw new Error(`ZK type '${type}' not found in manifest`);

      let rawUrl = variant && !("url" in entry) ? entry[variant]?.url : entry.url;
      if (!rawUrl) throw new Error(`No URL for '${type}'`);

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
 * Custom transaction forwarder that skips preflight simulation.
 * Skips simulation to avoid false failures when sending multi-tx sequences
 * where earlier txs must be confirmed before later ones can be simulated.
 */
function makeAgentForwarder(connection) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async fireAndForget(tx) {
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
  const bs58 = require("bs58");
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
  const {
    createSignerFromPrivateKeyBytes, getUmbraClient,
    getUserRegistrationFunction, getUserAccountQuerierFunction,
    getPublicBalanceToReceiverClaimableUtxoCreatorFunction,
  } = require("@umbra-privacy/sdk");
  const {
    getUserRegistrationProver,
    getCreateReceiverClaimableUtxoFromPublicBalanceProver,
  } = require("@umbra-privacy/web-zk-prover");

  // ── Load agent wallet ──────────────────────────────────────────────────────
  if (!fs.existsSync(walletPath)) {
    console.error(`No wallet at ${walletPath}. Run: node wallet.cjs create`);
    process.exit(1);
  }
  const walletData    = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const senderSecret  = Buffer.from(walletData.secretKey, "base64");
  const senderSigner  = await createSignerFromPrivateKeyBytes(senderSecret);
  const senderAddress = senderSigner.address.toString();

  // Check Balance
  const connection   = new Connection(RPC, "confirmed");
  const balanceBefore = await connection.getBalance(new PublicKey(senderAddress), "confirmed");
  
  // SOL needed regardless of token:
  //   - Ephemeral buffer (0.02 SOL)
  //   - Proof buffer account rent (~0.005 SOL, paid from sender wallet, NOT ephemeral)
  //   - Transaction fees (~0.002 SOL across all steps)
  // For SOL links: additionally need the link amount itself
  const solOverhead = EPHEMERAL_BUFFER + (0.007 * LAMPORTS_PER_SOL); // buffer + proof + fees
  const solForAmount = token === "SOL" ? Number(amountRaw) : 0;       // SOL amount only for SOL links
  const totalRequiredSol = solOverhead + solForAmount;

  if (balanceBefore < totalRequiredSol) {
    console.error(`\n❌ Insufficient SOL. Agent has ${(balanceBefore / LAMPORTS_PER_SOL).toFixed(4)} SOL but needs at least ${(totalRequiredSol / LAMPORTS_PER_SOL).toFixed(4)} SOL for fees and the ephemeral buffer.`);
    if (token !== "SOL") console.error(`   (${token} tokens are sent from your token balance, not SOL.)`);
    process.exit(1);
  }

  console.log(`\nSender wallet: ${senderAddress}`);
  console.log(`Amount:        ${amountArg} ${token}`);
  console.log(`Network:       ${network}`);

  const assetProvider = makeNodeZkAssetProvider();

  // ── Step 1: Generate ephemeral keypair ────────────────────────────────────
  console.log("\n[1/4] Generating ephemeral keypair…");
  const ephemeralPrivKey = crypto.getRandomValues(new Uint8Array(32));
  const ephemeralKeypair = Keypair.fromSeed(ephemeralPrivKey);
  const ephemeralSigner  = await createSignerFromPrivateKeyBytes(ephemeralKeypair.secretKey);
  console.log(`      Ephemeral: ${ephemeralSigner.address}`);

  // ── Step 2: Fund ephemeral ────────────────────────────────────────────────
  console.log("\n[2/4] Funding ephemeral for registration fees…");
  const fundLamports = Math.round(EPHEMERAL_BUFFER);
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(senderAddress),
      toPubkey:   ephemeralKeypair.publicKey,
      lamports:   fundLamports,
    })
  );
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  fundTx.recentBlockhash = blockhash;
  fundTx.feePayer = new PublicKey(senderAddress);

  // Sign with raw keypair
  const senderKeypair = Keypair.fromSecretKey(senderSecret);
  fundTx.sign(senderKeypair);
  const fundSig = await connection.sendRawTransaction(fundTx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction({ signature: fundSig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`      Funded ✓ (${fundLamports / LAMPORTS_PER_SOL} SOL)`);

  // Save ephemeral key immediately after funding — before anything can fail.
  // If the script crashes from here, sweep-stranded.cjs can recover the SOL.
  const STRANDED_FILE = path.join(os.homedir(), ".veilpay", "stranded.json");
  const strandedEntry = {
    address:    ephemeralKeypair.publicKey.toString(),
    privateKey: Buffer.from(ephemeralPrivKey).toString("base64"),
    fundedAt:   Date.now(),
    amount:     fundLamports,
    network,
  };
  try {
    let stranded = [];
    if (fs.existsSync(STRANDED_FILE)) {
      try { stranded = JSON.parse(fs.readFileSync(STRANDED_FILE, "utf8")); } catch {}
    }
    stranded.push(strandedEntry);
    fs.mkdirSync(path.dirname(STRANDED_FILE), { recursive: true });
    fs.writeFileSync(STRANDED_FILE, JSON.stringify(stranded, null, 2));
    fs.chmodSync(STRANDED_FILE, 0o600);
  } catch { /* non-fatal — best effort */ }

  // ── Step 3: Register ephemeral + sender with Umbra ─────────────────────────
  console.log("\n[3/4] Registering privacy channels (ZK proofs)…");

  const forwarder = makeAgentForwarder(connection);

  // Register ephemeral
  const ephClient = await getUmbraClient(
    { signer: ephemeralSigner, network, rpcUrl: RPC,
      rpcSubscriptionsUrl: RPC.replace("http", "ws"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: forwarder }
  );

  const ephQuerier = getUserAccountQuerierFunction({ client: ephClient });
  const ephState   = await ephQuerier(ephemeralSigner.address);
  if (ephState.state !== "exists" ||
      !ephState.data.isUserCommitmentRegistered ||
      !ephState.data.isUserAccountX25519KeyRegistered) {
    process.stdout.write("      Registering ephemeral… ");
    const ephRegProver   = getUserRegistrationProver({ assetProvider });
    const ephRegister    = getUserRegistrationFunction({ client: ephClient }, { zkProver: ephRegProver });
    await ephRegister({ confidential: true, anonymous: true });
    console.log("done");
  } else {
    console.log("      Ephemeral already registered ✓");
  }

  // Register sender (if first time)
  const senderClient = await getUmbraClient(
    { signer: senderSigner, network, rpcUrl: RPC,
      rpcSubscriptionsUrl: RPC.replace("http", "ws"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: forwarder }
  );

  const senderQuerier = getUserAccountQuerierFunction({ client: senderClient });
  const senderState   = await senderQuerier(senderSigner.address);
  if (senderState.state !== "exists" ||
      !senderState.data.isUserCommitmentRegistered ||
      !senderState.data.isUserAccountX25519KeyRegistered) {
    process.stdout.write("      Registering sender (first time only)… ");
    const senderRegProver = getUserRegistrationProver({ assetProvider });
    const senderRegister  = getUserRegistrationFunction({ client: senderClient }, { zkProver: senderRegProver });
    await senderRegister({ confidential: true, anonymous: true });
    console.log("done");
  } else {
    console.log("      Sender already registered ✓");
  }

  // ── Step 4: Create UTXO ───────────────────────────────────────────────────
  console.log("\n[4/4] Depositing into shielded pool…");

  const utxoProver = getCreateReceiverClaimableUtxoFromPublicBalanceProver({ assetProvider });
  const createUtxo = getPublicBalanceToReceiverClaimableUtxoCreatorFunction(
    { client: senderClient },
    { zkProver: utxoProver }
  );

  await createUtxo({
    destinationAddress: ephemeralSigner.address,
    mint:               tokenCfg.mint,
    amount:             amountRaw,
  });
  console.log("      Deposited ✓");

  // ── Build claim URL ───────────────────────────────────────────────────────
  const secretB58    = (bs58.default || bs58).encode(ephemeralPrivKey);
  const memoSuffix   = memo ? `:${encodeURIComponent(memo.slice(0, 200))}` : "";
  const lockParam    = lockTo ? `&to=${encodeURIComponent(lockTo)}` : "";
  const expiresAt    = Date.now() + expiryDays * 24 * 60 * 60 * 1000;
  const linkId       = crypto.randomUUID();
  const url          = `${SITE_BASE}/claim?lid=${linkId}&exp=${expiresAt}${lockParam}#${secretB58}:${token}${memoSuffix}`;

  // Balance after deposit
  const balanceAfter   = await connection.getBalance(new PublicKey(senderAddress), "confirmed");
  const deltaLamports  = balanceAfter - balanceBefore;
  const deltaSign      = deltaLamports >= 0 ? "+" : "";
  const deltaSol       = (deltaLamports / LAMPORTS_PER_SOL).toFixed(6);
  const afterSol       = (balanceAfter / LAMPORTS_PER_SOL).toFixed(6);

  // Link created successfully — remove ephemeral from stranded list
  try {
    if (fs.existsSync(STRANDED_FILE)) {
      const stranded = JSON.parse(fs.readFileSync(STRANDED_FILE, "utf8"));
      const cleaned  = stranded.filter(e => e.address !== ephemeralKeypair.publicKey.toString());
      fs.writeFileSync(STRANDED_FILE, JSON.stringify(cleaned, null, 2));
    }
  } catch { /* non-fatal */ }

  console.log("\n✅ Private link created!");
  console.log(`\n   Link:    ${url}`);
  console.log(`   Amount:  ${amountArg} ${token}`);
  console.log(`   Expires: ${new Date(expiresAt).toLocaleDateString()}`);
  if (memo)   console.log(`   Memo:    "${memo}"`);
  if (lockTo) console.log(`   Locked:  ${lockTo}`);
  console.log(`\n   Balance before: ${(balanceBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`   Balance after:  ${afterSol} SOL  (${deltaSign}${deltaSol} SOL)`);
  console.log("\n   Share this link with the recipient.");
  console.log("   The claim key (after #) is private — keep it secret until you share it.");

  // Machine-readable JSON for agent consumption
  process.stdout.write("\n");
  console.log(JSON.stringify({
    url, linkId, amount: amountArg, token, expiresAt, lockTo, memo,
    balanceBefore: (balanceBefore / LAMPORTS_PER_SOL).toFixed(6),
    balanceAfter:  afterSol,
    balanceDelta:  `${deltaSign}${deltaSol}`,
  }, null, 2));

  // Force exit — Umbra SDK holds WebSocket connections open indefinitely
  process.exit(0);
})().catch((e) => {
  console.error("\n❌ Failed to create link:", e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
