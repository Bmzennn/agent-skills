#!/usr/bin/env node
/**
 * claim-link.cjs — Claim a VeilPay private payment link to the agent's wallet.
 *
 * Usage:
 *   node claim-link.cjs --link "<full_claim_url>" [--network devnet|mainnet] [--wallet <path>]
 *
 * The agent's wallet (from wallet.cjs) is used as the recipient.
 * ZK circuit files are downloaded and cached in ~/.veilpay/zk-cache/ on first run (~100MB).
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const https = require("https");
const crypto = require("crypto");

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const linkArg    = get("--link");
const network    = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const walletPath = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");

if (!linkArg) {
  console.error("Usage: node claim-link.cjs --link <url> [--network devnet|mainnet]");
  process.exit(1);
}

// ─── Parse claim URL ─────────────────────────────────────────────────────────

const hashIdx = linkArg.indexOf("#");
if (hashIdx === -1) { console.error("No claim key in URL (missing # fragment)."); process.exit(1); }

const fragment    = linkArg.slice(hashIdx + 1);
const firstColon  = fragment.indexOf(":");
const claimSecretB58 = firstColon === -1 ? fragment : fragment.slice(0, firstColon);
const rest        = firstColon === -1 ? "" : fragment.slice(firstColon + 1);
const secondColon = rest.indexOf(":");
const token       = (secondColon === -1 ? rest : rest.slice(0, secondColon)) || "SOL";
const memo        = secondColon === -1 ? null : (() => { try { return decodeURIComponent(rest.slice(secondColon + 1)); } catch { return null; } })();

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

const TOKEN_CONFIG = {
  SOL:  { mint: "So11111111111111111111111111111111111111112",  decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
};

const CDN_BASE    = "https://d3j9fjdkre529f.cloudfront.net";
const ZK_CACHE    = path.join(os.homedir(), ".veilpay", "zk-cache");
const SOLANA_NETWORK_SUFFIX = network === "mainnet" ? "" : `?cluster=${network}`;

// ─── ZK Asset Provider (Node.js — downloads to ~/.veilpay/zk-cache) ──────────

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + ".tmp";
    const file = fs.createWriteStream(tmp);
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      res.pipe(file);
      file.on("finish", () => { file.close(); fs.renameSync(tmp, dest); resolve(); });
      file.on("error", (e) => { fs.unlinkSync(tmp); reject(e); });
    }).on("error", reject);
  });
}

function makeNodeZkAssetProvider() {
  fs.mkdirSync(ZK_CACHE, { recursive: true });
  let manifest = null;

  return {
    async getAssetUrls(type, variant) {
      if (!manifest) {
        const res = await fetch(`${CDN_BASE}/manifest.json`);
        if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
        manifest = await res.json();
      }

      const entry = manifest.assets[type];
      if (!entry) throw new Error(`ZK type '${type}' not in manifest`);

      let rawUrl;
      if (variant && !("url" in entry)) rawUrl = entry[variant]?.url;
      else rawUrl = entry.url;
      if (!rawUrl) throw new Error(`No URL for ZK type '${type}' variant '${variant}'`);

      const fullZkeyUrl = rawUrl.startsWith("http") ? rawUrl : `${CDN_BASE}/${rawUrl}`;
      const fullWasmUrl = fullZkeyUrl.replace(/\.zkey$/i, ".wasm");

      const key       = crypto.createHash("md5").update(fullZkeyUrl).digest("hex");
      const zkeyPath  = path.join(ZK_CACHE, `${key}.zkey`);
      const wasmPath  = path.join(ZK_CACHE, `${key}.wasm`);

      if (!fs.existsSync(zkeyPath)) {
        const sizeMb = type.includes("claim") ? "~70MB" : "~50MB";
        process.stdout.write(`  Downloading ${type}.zkey (${sizeMb}, cached after first run)… `);
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

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  // Load SDK
  const bs58 = require("bs58");
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction,
          sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
  const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
          createTransferInstruction, createCloseAccountInstruction } = require("@solana/spl-token");
  const {
    createSignerFromPrivateKeyBytes, getUmbraClient, getUmbraRelayer,
    getClaimableUtxoScannerFunction, getEncryptedBalanceQuerierFunction,
    getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
    getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
    pollClaimUntilTerminal,
    getPollingTransactionForwarder, getPollingComputationMonitor,
  } = require("@umbra-privacy/sdk");
  const { getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver } = require("@umbra-privacy/web-zk-prover");
  const { ReadServiceClient } = require("@umbra-privacy/indexer-read-service-client");

  // Load agent wallet (recipient)
  if (!fs.existsSync(walletPath)) {
    console.error(`No wallet at ${walletPath}. Run: node wallet.cjs create`);
    process.exit(1);
  }
  const walletData    = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const recipientAddr = walletData.publicKey;
  console.log(`\nAgent wallet: ${recipientAddr}`);
  console.log(`Claiming on:  ${network}`);
  if (memo) console.log(`Memo:         "${memo}"`);

  // Reconstruct ephemeral signer
  const decoded = bs58.default ? bs58.default.decode(claimSecretB58) : bs58.decode(claimSecretB58);
  const seed32  = decoded.length === 32 ? decoded : decoded.slice(0, 32);
  const ephKeypair  = Keypair.fromSeed(seed32);
  const ephSecret64 = ephKeypair.secretKey;
  const ephSigner   = await createSignerFromPrivateKeyBytes(ephSecret64);

  const connection = new Connection(RPC, "confirmed");

  // Fast-path: if ephemeral SOL balance is near zero, already claimed
  const solBal = await connection.getBalance(ephKeypair.publicKey, "confirmed");
  if (solBal < 5_000_000) {
    console.log("\n⚠️  This link has already been claimed and swept.");
    process.exit(0);
  }

  // Build Umbra client for the ephemeral signer
  const client = await getUmbraClient(
    { signer: ephSigner, network, rpcUrl: RPC,
      rpcSubscriptionsUrl: RPC.replace("https://", "wss://"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: getPollingTransactionForwarder({ rpcUrl: RPC }),
      computationMonitor: getPollingComputationMonitor({ rpcUrl: RPC }) }
  );

  // ── Scan for UTXO ──────────────────────────────────────────────────────────
  console.log("\n[1/5] Scanning shielded pool…");

  const readClient  = new ReadServiceClient({ endpoint: INDEXER });
  const stats       = await readClient.getStats();
  const MAX_LEAVES  = 1n << 20n;
  const scanner     = getClaimableUtxoScannerFunction({ client });

  let utxo = null;
  if (stats.latest_absolute_index !== null) {
    const cur     = stats.latest_absolute_index / MAX_LEAVES;
    const indices = cur > 0n ? [cur, cur - 1n] : [0n];
    for (const idx of indices) {
      const result = await scanner(idx, 0n);
      if (result.publicReceived.length > 0) { utxo = result.publicReceived[0]; break; }
    }
  }

  const tokenCfg  = TOKEN_CONFIG[token] || TOKEN_CONFIG.SOL;
  const mintAddr  = tokenCfg.mint;
  const querier   = getEncryptedBalanceQuerierFunction({ client });

  // Check if already past the claim step (has encrypted balance)
  const balMap    = await querier([mintAddr]);
  const existing  = balMap.get(mintAddr);
  const hasEncBal = existing?.state === "shared" && BigInt(existing.balance.toString()) > 0n;

  if (!utxo && !hasEncBal) {
    console.log("No unclaimed payment found. The link may have expired or already been claimed.");
    process.exit(0);
  }

  let originalAmountRaw = 0n;

  if (utxo) {
    originalAmountRaw = BigInt(utxo.amount.toString());
    const human = (Number(originalAmountRaw) / 10 ** tokenCfg.decimals).toFixed(tokenCfg.decimals === 6 ? 2 : 4);
    console.log(`    Found: ${human} ${token}`);

    // ── ZK Claim via relayer ───────────────────────────────────────────────
    console.log("\n[2/5] Generating ZK proof (this takes 20–60s)…");
    const assetProvider = makeNodeZkAssetProvider();
    const claimProver   = getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver({ assetProvider });
    const relayer       = getUmbraRelayer({ apiEndpoint: RELAYER });

    const claimer = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction(
      { client },
      { fetchBatchMerkleProof: client.fetchBatchMerkleProof, zkProver: claimProver, relayer }
    );

    const claimResult = await claimer([utxo]);

    console.log("\n[3/5] Waiting for on-chain ZK verification…");
    for (const [, batch] of claimResult.batches) {
      await pollClaimUntilTerminal(
        (rid) => relayer.pollClaimStatus(rid),
        batch.requestId,
        { onProgress: ({ status }) => { process.stdout.write(`    ${status}\r`); } }
      );
    }
    console.log("    Verified ✓                    ");

    // Give RPC time to propagate the claim state
    process.stdout.write("    Waiting for RPC sync… ");
    await new Promise((r) => setTimeout(r, 10_000));
    console.log("done");
  } else {
    console.log("\n[2-3/5] Resuming from encrypted balance (ZK claim already complete)…");
    if (existing?.state === "shared") {
      originalAmountRaw = BigInt(existing.balance.toString());
    }
  }

  // ── Ensure ephemeral ATA ──────────────────────────────────────────────────
  console.log("\n[4/5] Preparing token account…");
  const mintPubkey = new PublicKey(mintAddr);
  const ephAta     = getAssociatedTokenAddressSync(mintPubkey, ephKeypair.publicKey, true);
  const ataInfo    = await connection.getAccountInfo(ephAta, "confirmed");
  if (!ataInfo) {
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        ephKeypair.publicKey, ephAta, ephKeypair.publicKey, mintPubkey
      )
    );
    await sendAndConfirmTransaction(connection, ataTx, [ephKeypair], { skipPreflight: true });
    console.log("    ATA created ✓");
  } else {
    console.log("    ATA exists ✓");
  }

  // ── Withdraw to ephemeral ──────────────────────────────────────────────────
  console.log("\n[5/5] Withdrawing to your wallet…");
  const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({ client });

  let withdrawResult;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const freshMap  = await querier([mintAddr]);
      const freshBal  = freshMap.get(mintAddr);
      if (!freshBal || freshBal.state !== "shared" || BigInt(freshBal.balance.toString()) === 0n) {
        if (attempt < 5) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        throw new Error("Encrypted balance not available after waiting.");
      }
      const amount = BigInt(freshBal.balance.toString());
      withdrawResult = await withdraw(ephSigner.address, mintAddr, amount);
      break;
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ── Sweep ephemeral → agent wallet ────────────────────────────────────────
  const recipientPubkey = new PublicKey(recipientAddr);
  const sweepTx = new Transaction();
  let tokenBalance = 0n;

  if (token !== "SOL") {
    // Poll for tokens to arrive in ephemeral ATA
    for (let i = 0; i < 30; i++) {
      try {
        const info = await connection.getTokenAccountBalance(ephAta, "confirmed");
        tokenBalance = BigInt(info.value.amount);
        if (tokenBalance > 0n) break;
      } catch { /* ATA not yet funded */ }
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (tokenBalance > 0n) {
      const recipientAta = getAssociatedTokenAddressSync(mintPubkey, recipientPubkey, true);
      sweepTx.add(
        createAssociatedTokenAccountIdempotentInstruction(ephKeypair.publicKey, recipientAta, recipientPubkey, mintPubkey),
        createTransferInstruction(ephAta, recipientAta, ephKeypair.publicKey, tokenBalance),
        createCloseAccountInstruction(ephAta, recipientPubkey, ephKeypair.publicKey)
      );
    }
  }

  // Sweep remaining SOL (wait for increase if SOL link)
  let currentSol = await connection.getBalance(ephKeypair.publicKey, "confirmed");
  if (token === "SOL") {
    for (let i = 0; i < 20; i++) {
      currentSol = await connection.getBalance(ephKeypair.publicKey, "confirmed");
      if (currentSol > solBal + 1_000_000) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  sweepTx.recentBlockhash = blockhash;
  sweepTx.feePayer = ephKeypair.publicKey;

  // Estimate fee with a dummy transfer
  sweepTx.add(SystemProgram.transfer({ fromPubkey: ephKeypair.publicKey, toPubkey: recipientPubkey, lamports: 1000 }));
  const feeCalc = await connection.getFeeForMessage(sweepTx.compileMessage(), "confirmed");
  const fee = BigInt(feeCalc.value || 5000);
  sweepTx.instructions.pop(); // remove dummy

  const availableSol = BigInt(currentSol) - fee;
  if (availableSol > 0n) {
    sweepTx.add(SystemProgram.transfer({
      fromPubkey: ephKeypair.publicKey,
      toPubkey: recipientPubkey,
      lamports: availableSol,
    }));
  }

  if (sweepTx.instructions.length > 0) {
    await sendAndConfirmTransaction(connection, sweepTx, [ephKeypair], { skipPreflight: true });
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  const sig = withdrawResult?.callbackSignature?.toString() ?? withdrawResult?.queueSignature?.toString() ?? "";
  const human = (Number(originalAmountRaw) / 10 ** tokenCfg.decimals).toFixed(tokenCfg.decimals === 6 ? 2 : 4);

  console.log("\n✅ Claimed successfully!");
  console.log(`   Amount:    ${human} ${token}`);
  console.log(`   Delivered: ${recipientAddr}`);
  if (sig) console.log(`   Explorer:  https://solscan.io/tx/${sig}${SOLANA_NETWORK_SUFFIX}`);
})().catch((e) => {
  console.error("\n❌ Claim failed:", e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
