#!/usr/bin/env node
/**
 * recover-link.cjs — Emergency sweep of a private payment link.
 * 
 * Final revised version with extended timeouts and deep diagnostics.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const urlMod = require("url");
const { Connection, Keypair, PublicKey, Transaction, SystemProgram } = require("@solana/web3.js");
const { 
  getAssociatedTokenAddressSync, 
  createAssociatedTokenAccountIdempotentInstruction, 
  createTransferInstruction, 
  createCloseAccountInstruction 
} = require("@solana/spl-token");
const bs58 = require("bs58");

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
      blob:        async () => ({ arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }),
    };
  }
  return _nativeFetch(input, init);
};

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const linkUrl = get("--link");
const toAddr = get("--to");
const network = get("--network") || "mainnet";

if (!linkUrl || !toAddr) {
  console.log("Usage: node recover-link.cjs --link \"<url>\" --to <your_address>");
  process.exit(1);
}

const TOKEN_CONFIG = {
  SOL:   { mint: "So11111111111111111111111111111111111111112",          decimals: 9 },
  USDC:  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",       decimals: 6 },
  USDT:  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",       decimals: 6 },
  UMBRA: { mint: "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta",        decimals: 6 },
  CASH:  { mint: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",      decimals: 6 },
};

const RPC = network === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
const INDEXER = network === "mainnet" ? "https://utxo-indexer.api.umbraprivacy.com" : "https://utxo-indexer.api-devnet.umbraprivacy.com";
const RELAYER = "https://relayer.api.umbraprivacy.com";
const CDN_BASE = "https://d3j9fjdkre529f.cloudfront.net";
const ZK_CACHE = path.join(os.homedir(), ".veilpay", "zk-cache");

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
        const res = await _nativeFetch(`${CDN_BASE}/manifest.json`);
        manifest = await res.json();
      }
      const entry = manifest.assets[type];
      let rawUrl = (variant && !("url" in entry)) ? entry[variant]?.url : entry.url;
      const fullZkeyUrl = rawUrl.startsWith("http") ? rawUrl : `${CDN_BASE}/${rawUrl}`;
      const key = crypto.createHash("md5").update(fullZkeyUrl).digest("hex");
      const zkeyPath = path.join(ZK_CACHE, `${key}.zkey`);
      const wasmPath = path.join(ZK_CACHE, `${key}.wasm`);
      if (!fs.existsSync(zkeyPath)) {
        process.stdout.write(`  Downloading ${type}.zkey… `);
        await downloadFile(fullZkeyUrl, zkeyPath);
        process.stdout.write("done\n");
      }
      if (!fs.existsSync(wasmPath)) {
        process.stdout.write(`  Downloading ${type}.wasm… `);
        await downloadFile(fullZkeyUrl.replace(/\.zkey$/i, ".wasm"), wasmPath);
        process.stdout.write("done\n");
      }
      return { zkeyUrl: `file://${zkeyPath}`, wasmUrl: `file://${wasmPath}` };
    },
  };
}

(async () => {
  const { 
    createSignerFromPrivateKeyBytes, getUmbraClient, getUmbraRelayer,
    getClaimableUtxoScannerFunction, getEncryptedBalanceQuerierFunction,
    getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction,
    getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
    getPollingTransactionForwarder, getPollingComputationMonitor,
    pollClaimUntilTerminal
  } = require("@umbra-privacy/sdk");
  const { getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver } = require("@umbra-privacy/web-zk-prover");

  // Parse link
  const hash = linkUrl.split("#")[1];
  if (!hash) throw new Error("No hash found in link");
  const parts = hash.split(":");
  const claimSecretB58 = parts[0];
  const symbol = (parts[1] || "USDC").toUpperCase();
  const cfg = TOKEN_CONFIG[symbol];
  if (!cfg) throw new Error(`Unsupported token: ${symbol}`);

  const secretBytes = bs58.decode(claimSecretB58);
  const ephemeralKeypair = Keypair.fromSeed(secretBytes.slice(0, 32));
  const recipientPubkey = new PublicKey(toAddr);

  console.log(`\n--- Emergency Sweep ---`);
  console.log(`Ephemeral: ${ephemeralKeypair.publicKey.toString()}`);
  console.log(`Recipient: ${toAddr}`);
  console.log(`Token:     ${symbol}\n`);

  const connection = new Connection(RPC, "confirmed");
  const signer = await createSignerFromPrivateKeyBytes(ephemeralKeypair.secretKey);
  const client = await getUmbraClient(
    { signer, network, rpcUrl: RPC, rpcSubscriptionsUrl: RPC.replace("https://", "wss://"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: getPollingTransactionForwarder({ rpcUrl: RPC }),
      computationMonitor: getPollingComputationMonitor({ rpcUrl: RPC }) }
  );

  const querier = getEncryptedBalanceQuerierFunction({ client });
  const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({ client });

  // 1. Check for Encrypted Balance
  console.log("Checking indexer for current balance…");
  const balMap = await querier([cfg.mint]);
  const balResInitial = balMap.get(cfg.mint);
  let hasEncrypted = balResInitial?.state === "shared" && BigInt(balResInitial.balance.toString()) > 0n;

  if (!hasEncrypted) {
    // 2. Scan for UTXO
    console.log("Scanning shielded pool for UTXOs…");
    const scanner = getClaimableUtxoScannerFunction({ client });
    const trees = [0n, 1n, 2n];
    let utxo = null;
    for (const tree of trees) {
        const { publicReceived } = await scanner(tree, 0n);
        if (publicReceived.length > 0) { utxo = publicReceived[0]; break; }
    }

    if (!utxo) {
      console.log("❌ No unclaimed UTXO or encrypted balance found.");
      console.log("   If you just claimed on the site, the indexer might be catching up.");
      console.log("   Wait 2 minutes and try this script again.");
      process.exit(1);
    }

    console.log(`Found UTXO: ${utxo.amount} ${symbol}. Claiming via ZK proof…`);
    
    // 3. Claim (ZK Proof)
    const relayer = getUmbraRelayer({ apiEndpoint: RELAYER });
    const assetProvider = makeNodeZkAssetProvider();
    const claimProver = getClaimReceiverClaimableUtxoIntoEncryptedBalanceProver({ assetProvider });
    
    const claim = getReceiverClaimableUtxoToEncryptedBalanceClaimerFunction({ client }, { 
      fetchBatchMerkleProof: client.fetchBatchMerkleProof,
      zkProver: claimProver,
      relayer 
    });

    const res = await claim([utxo]);
    const requestId = [...res.batches.values()][0].requestId;
    
    console.log(`Waiting for proof verification (Request ${requestId})…`);
    await pollClaimUntilTerminal((rid) => relayer.pollClaimStatus(rid), requestId);
    console.log("✅ Claimed into encrypted balance.");
  } else {
    console.log(`✅ Found ${balResInitial.balance} ${symbol} in encrypted balance.`);
  }

  // 4. Persistence loop for indexer sync
  console.log("\nWaiting for indexer to reflect balance (this can take up to 5 minutes)…");
  let amountToWithdraw = 0n;
  const startTime = Date.now();
  const FIVE_MIN_MS = 5 * 60 * 1000;

  while (Date.now() - startTime < FIVE_MIN_MS) {
    const freshMap = await querier([cfg.mint]);
    const res = freshMap.get(cfg.mint);
    const state = res?.state || "none";
    const balance = res?.balance?.toString() || "0";
    
    process.stdout.write(`\r   [${Math.floor((Date.now() - startTime)/1000)}s] State: ${state.padEnd(8)} Balance: ${balance.padEnd(10)}`);
    
    if (state === "shared" && BigInt(balance) > 0n) {
      amountToWithdraw = BigInt(balance);
      console.log("\n✅ Indexer synced!");
      break;
    }
    
    await new Promise(r => setTimeout(r, 4000));
  }

  if (amountToWithdraw === 0n) {
    console.log("\n\n❌ Timeout: Indexer is still lagging.");
    console.log("   The funds are safe on-chain but the indexer hasn't seen the Arcium update.");
    console.log("   PLEASE WAIT 5 MINUTES AND RUN THE SCRIPT AGAIN.");
    process.exit(1);
  }

  // 5. Withdraw to Ephemeral Public Wallet
  console.log("Withdrawing to ephemeral public wallet…");
  
  if (symbol !== "SOL") {
    const ata = getAssociatedTokenAddressSync(new PublicKey(cfg.mint), ephemeralKeypair.publicKey, true);
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      console.log("   Creating ephemeral ATA…");
      const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
        ephemeralKeypair.publicKey, ata, ephemeralKeypair.publicKey, new PublicKey(cfg.mint)
      ));
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = ephemeralKeypair.publicKey;
      tx.sign(ephemeralKeypair);
      await connection.sendRawTransaction(tx.serialize());
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  try {
    await withdraw(ephemeralKeypair.publicKey.toString(), cfg.mint, amountToWithdraw);
    console.log("✅ Withdrawn to ephemeral public wallet.");
  } catch (e) {
    console.error("\n❌ Withdrawal failed:", e.message);
    console.log("   This usually means the Arcium MPC is still processing the claim.");
    console.log("   WAIT 2 MINUTES AND RUN THE SCRIPT AGAIN.");
    process.exit(1);
  }

  // 6. Sweep to Recipient
  console.log("\nSweeping everything to recipient…");
  const sweepTx = new Transaction();
  
  if (symbol !== "SOL") {
    const ephAta = getAssociatedTokenAddressSync(new PublicKey(cfg.mint), ephemeralKeypair.publicKey, true);
    const recAta = getAssociatedTokenAddressSync(new PublicKey(cfg.mint), recipientPubkey, true);
    
    let tokenBal = 0n;
    process.stdout.write("   Waiting for tokens to land in public ATA…");
    for (let i = 0; i < 20; i++) {
      try {
        const info = await connection.getTokenAccountBalance(ephAta);
        tokenBal = BigInt(info.value.amount);
        if (tokenBal > 0n) break;
      } catch {}
      process.stdout.write(".");
      await new Promise(r => setTimeout(r, 3000));
    }
    console.log(" done.");

    if (tokenBal > 0n) {
      sweepTx.add(
        createAssociatedTokenAccountIdempotentInstruction(ephemeralKeypair.publicKey, recAta, recipientPubkey, new PublicKey(cfg.mint)),
        createTransferInstruction(ephAta, recAta, ephemeralKeypair.publicKey, tokenBal),
        createCloseAccountInstruction(ephAta, recipientPubkey, ephemeralKeypair.publicKey)
      );
    }
  }

  const sol = await connection.getBalance(ephemeralKeypair.publicKey);
  const { blockhash } = await connection.getLatestBlockhash();
  sweepTx.recentBlockhash = blockhash;
  sweepTx.feePayer = ephemeralKeypair.publicKey;

  const dummyTx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: ephemeralKeypair.publicKey, toPubkey: recipientPubkey, lamports: 1000
  }));
  dummyTx.recentBlockhash = blockhash;
  dummyTx.feePayer = ephemeralKeypair.publicKey;
  const feeCalc = await connection.getFeeForMessage(dummyTx.compileMessage(), "confirmed");
  const fee = BigInt(feeCalc.value || 5000);

  sweepTx.add(SystemProgram.transfer({
    fromPubkey: ephemeralKeypair.publicKey,
    toPubkey: recipientPubkey,
    lamports: BigInt(sol) - fee
  }));

  sweepTx.sign(ephemeralKeypair);
  const sig = await connection.sendRawTransaction(sweepTx.serialize());
  console.log(`\n🚀 ALL FUNDS RECOVERED!`);
  console.log(`Signature: ${sig}`);
  console.log(`Explorer:  https://solscan.io/tx/${sig}`);
  process.exit(0);
})().catch(e => {
  console.error("\n❌ Error:", e.message);
  process.exit(1);
});
