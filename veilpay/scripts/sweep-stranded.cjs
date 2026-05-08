#!/usr/bin/env node
/**
 * sweep-stranded.cjs — Recover SOL from ephemeral accounts that were funded
 * during a failed link creation but never used.
 *
 * When create-link.cjs funds an ephemeral account and then fails (network error,
 * ZK proof failure, timeout), the ephemeral's private key is saved to
 * ~/.veilpay/stranded.json. This script reads that file and sweeps the SOL
 * back to the agent wallet.
 *
 * Usage:
 *   node sweep-stranded.cjs                        # sweep all stranded entries
 *   node sweep-stranded.cjs --list                 # list without sweeping
 *   node sweep-stranded.cjs --address <pubkey>     # sweep one specific entry
 *   node sweep-stranded.cjs --network devnet|mainnet
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ─── Args ─────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const get     = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const has     = (f) => args.includes(f);

const listOnly      = has("--list");
const targetAddress = get("--address");
const network       = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const walletPath    = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");

const STRANDED_FILE = path.join(os.homedir(), ".veilpay", "stranded.json");

const RPC = network === "mainnet"
  ? (process.env.VEILPAY_RPC_URL || "https://api.mainnet-beta.solana.com")
  : (process.env.VEILPAY_RPC_URL || "https://api.devnet.solana.com");

// ─── Load stranded entries ────────────────────────────────────────────────────

function loadStranded() {
  if (!fs.existsSync(STRANDED_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(STRANDED_FILE, "utf8")); }
  catch { return []; }
}

function saveStranded(entries) {
  fs.writeFileSync(STRANDED_FILE, JSON.stringify(entries, null, 2));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");

  let entries = loadStranded();

  if (entries.length === 0) {
    console.log("No stranded ephemeral accounts found in ~/.veilpay/stranded.json");
    process.exit(0);
  }

  if (targetAddress) {
    entries = entries.filter(e => e.address === targetAddress);
    if (entries.length === 0) {
      console.error(`No stranded entry found for address: ${targetAddress}`);
      process.exit(1);
    }
  }

  const connection = new Connection(RPC, "confirmed");

  console.log(`\nFound ${entries.length} stranded ephemeral account(s):\n`);

  for (const entry of entries) {
    const balance = await connection.getBalance(new PublicKey(entry.address), "confirmed");
    const age     = Math.round((Date.now() - entry.fundedAt) / 60000);
    console.log(`  ${entry.address}`);
    console.log(`    Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`    Funded:  ${age} minutes ago`);
    console.log(`    Network: ${entry.network || "unknown"}`);
  }

  if (listOnly) {
    console.log("\n(Run without --list to sweep these back to your wallet)");
    process.exit(0);
  }

  // Load recipient (agent's own wallet)
  if (!fs.existsSync(walletPath)) {
    console.error(`\nNo wallet at ${walletPath}. Run: node wallet.cjs create`);
    process.exit(1);
  }
  const walletData     = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const recipientPubkey = new PublicKey(walletData.publicKey);

  console.log(`\nSweeping to agent wallet: ${walletData.publicKey}\n`);

  const allStranded = loadStranded();
  let sweptCount    = 0;

  for (const entry of entries) {
    console.log(`Processing ${entry.address.slice(0, 8)}…`);

    // Reconstruct ephemeral keypair from saved private key
    const privBytes     = Buffer.from(entry.privateKey, "base64");
    const seed          = privBytes.length === 32 ? privBytes : privBytes.slice(0, 32);
    const ephKeypair    = Keypair.fromSeed(seed);
    const ephPubkey     = ephKeypair.publicKey;

    if (ephPubkey.toString() !== entry.address) {
      console.log(`  ⚠️  Address mismatch — skipping (stranded.json may be corrupted)`);
      continue;
    }

    const balance = await connection.getBalance(ephPubkey, "confirmed");

    if (balance === 0) {
      console.log(`  ✓ Already empty — removing from stranded list`);
      const idx = allStranded.findIndex(e => e.address === entry.address);
      if (idx !== -1) allStranded.splice(idx, 1);
      continue;
    }

    // Build sweep transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: ephPubkey });

    // Estimate fee
    tx.add(SystemProgram.transfer({ fromPubkey: ephPubkey, toPubkey: recipientPubkey, lamports: 1000 }));
    const feeCalc = await connection.getFeeForMessage(tx.compileMessage(), "confirmed");
    const fee     = feeCalc.value ?? 5000;
    tx.instructions = [];

    const sweepAmount = balance - fee;
    if (sweepAmount <= 0) {
      console.log(`  ⚠️  Balance (${balance}) too low to cover fee (${fee}) — skipping`);
      continue;
    }

    tx.add(SystemProgram.transfer({ fromPubkey: ephPubkey, toPubkey: recipientPubkey, lamports: sweepAmount }));
    tx.sign(ephKeypair);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });

    // Confirm
    let confirmed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: false });
      const conf   = status.value?.confirmationStatus;
      if (conf === "confirmed" || conf === "finalized") { confirmed = true; break; }
      if (status.value?.err) { console.error(`  ❌ Sweep tx failed on-chain`); break; }
    }

    if (confirmed) {
      console.log(`  ✅ Swept ${(sweepAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL → ${walletData.publicKey.slice(0, 8)}…`);
      console.log(`     Sig: https://solscan.io/tx/${sig}${network === "mainnet" ? "" : `?cluster=${network}`}`);
      const idx = allStranded.findIndex(e => e.address === entry.address);
      if (idx !== -1) allStranded.splice(idx, 1);
      sweptCount++;
    } else {
      console.log(`  ⚠️  Not confirmed after 60s — check Solscan: https://solscan.io/tx/${sig}`);
    }
  }

  // Write cleaned stranded list
  saveStranded(allStranded);

  console.log(`\n${sweptCount} account(s) swept. ${allStranded.length} remaining in stranded list.`);
  process.exit(0);
})().catch(e => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
