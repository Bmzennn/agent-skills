#!/usr/bin/env node
/**
 * wallet.cjs — Manage the agent's persistent Solana keypair.
 *
 * Wallet is stored at ~/.veilpay/wallet.json
 * Secret key is stored as base64 (standard Buffer encoding, no bs58 dependency).
 *
 * Usage:
 *   node wallet.cjs create    — generate and save a new keypair
 *   node wallet.cjs show      — print public address
 *   node wallet.cjs balance   — print SOL balance
 *   node wallet.cjs airdrop   — request devnet SOL (devnet only)
 */

"use strict";

const { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } = require("@solana/web3.js");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const WALLET_DIR  = path.join(os.homedir(), ".veilpay");
const WALLET_FILE = process.env.VEILPAY_WALLET_PATH || path.join(WALLET_DIR, "wallet.json");
const NETWORK     = process.env.VEILPAY_NETWORK || "devnet";
const RPC         = process.env.VEILPAY_RPC_URL ||
  (NETWORK === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");

function ensureDir() {
  fs.mkdirSync(path.dirname(WALLET_FILE), { recursive: true });
}

// ─── Legacy key migration ─────────────────────────────────────────────────────
// Old versions stored secretKey as bs58. New scripts read it as base64.
// This runs automatically before any command that reads the wallet.
function migrateIfNeeded() {
  if (!fs.existsSync(WALLET_FILE)) return;
  const data = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  if (!data.secretKey) return;

  // Base64 is always 88 chars for a 64-byte key; bs58 is ~87 but looks different.
  // Reliable test: try decoding as base64 and check the resulting length.
  const b64Bytes = Buffer.from(data.secretKey, "base64");
  if (b64Bytes.length === 64) return; // already base64

  // Looks like bs58 — migrate it
  const bs58 = require("bs58");
  const b58  = bs58.default || bs58;
  try {
    const decoded = b58.decode(data.secretKey);
    data.secretKey = Buffer.from(decoded).toString("base64");
    // Ensure publicKey field is consistent
    if (!data.publicKey && data.address) { data.publicKey = data.address; delete data.address; }
    fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2));
    console.log("ℹ️  Migrated wallet key format from bs58 → base64 (one-time upgrade).");
  } catch {
    // Not bs58 either — leave it alone
  }
}

function createWallet() {
  ensureDir();
  if (fs.existsSync(WALLET_FILE)) {
    console.log("Wallet already exists. Use 'show' to see the address, or delete the file to start fresh.");
    process.exit(1);
  }
  const kp = Keypair.generate();
  // Store secret key as base64 — no bs58 dependency required, readable by all other scripts
  const data = {
    publicKey:  kp.publicKey.toBase58(),
    secretKey:  Buffer.from(kp.secretKey).toString("base64"),
  };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2));
  console.log("✅ Wallet created");
  console.log(`   Address: ${data.publicKey}`);
  console.log(`   Saved:   ${WALLET_FILE}`);
  console.log(`\nNext: fund it with SOL — run: node wallet.cjs airdrop   (devnet only)`);
}

function showWallet() {
  migrateIfNeeded();
  if (!fs.existsSync(WALLET_FILE)) {
    console.error(`No wallet at ${WALLET_FILE}. Run: node wallet.cjs create`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  console.log(`Address: ${data.publicKey}`);
}

async function checkBalance() {
  migrateIfNeeded();
  if (!fs.existsSync(WALLET_FILE)) {
    console.error(`No wallet at ${WALLET_FILE}. Run: node wallet.cjs create`);
    process.exit(1);
  }
  const data       = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  const connection = new Connection(RPC, "confirmed");
  const lamports   = await connection.getBalance(new PublicKey(data.publicKey), "confirmed");
  console.log(`Address: ${data.publicKey}`);
  console.log(`Balance: ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (${NETWORK})`);
  if (lamports < 0.02 * LAMPORTS_PER_SOL) {
    console.log(`\nBalance is low. Run: node wallet.cjs airdrop   (devnet only)`);
  }
}

async function airdrop() {
  if (NETWORK === "mainnet") {
    console.error("Airdrop is only available on devnet. Set VEILPAY_NETWORK=devnet.");
    process.exit(1);
  }
  if (!fs.existsSync(WALLET_FILE)) {
    console.error(`No wallet at ${WALLET_FILE}. Run: node wallet.cjs create`);
    process.exit(1);
  }
  const data       = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  const connection = new Connection(RPC, "confirmed");
  const pubkey     = new PublicKey(data.publicKey);
  console.log(`Requesting 2 SOL airdrop for ${data.publicKey}…`);
  const sig = await connection.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
  const lamports = await connection.getBalance(pubkey, "confirmed");
  console.log(`✅ Airdrop confirmed. New balance: ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

const cmd = process.argv[2];
(async () => {
  switch (cmd) {
    case "create":  createWallet(); break;
    case "show":    showWallet();   break;
    case "balance": await checkBalance(); break;
    case "airdrop": await airdrop();      break;
    default:
      console.log("Usage: node wallet.cjs <create|show|balance|airdrop>");
      console.log("  create   — generate a new keypair");
      console.log("  show     — print public address");
      console.log("  balance  — check SOL balance");
      console.log("  airdrop  — request 2 SOL on devnet");
  }
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
