#!/usr/bin/env node
/**
 * recover-payment.cjs — Recover a lost x402 authorization header.
 *
 * Two recovery strategies (tried in order):
 *
 *   1. Ledger lookup  — if the invoiceId is in ~/.veilpay/payments.json and has full
 *      proofTxSig + depositSig saved, the auth header is reconstructed instantly.
 *
 *   2. On-chain scan  — given --deposit-sig (or extracted from a legacy ledger entry),
 *      the payer wallet's transaction history is scanned to find the proof account tx
 *      that immediately preceded the deposit. The two signatures are combined with the
 *      invoiceId to rebuild the 3-part x402 header.
 *
 * Usage:
 *   node recover-payment.cjs --invoice-id <hex> [--network devnet|mainnet] [--retry-url <url>]
 *   node recover-payment.cjs --invoice-id <hex> --deposit-sig <sig> [--network devnet|mainnet] [--retry-url <url>]
 *
 * Options:
 *   --invoice-id   64-char hex invoiceId from the original 402 response (required)
 *   --deposit-sig  base58 tx signature of the UTXO deposit (optional — auto-detected from ledger)
 *   --network      devnet | mainnet (default: mainnet)
 *   --retry-url    if provided, retry this URL with the recovered auth header
 */

"use strict";

const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const https = require("https");

// ─── Args ─────────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const get        = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const invoiceId  = get("--invoice-id");
const depositSig = get("--deposit-sig");
const network    = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const retryUrl   = get("--retry-url");
const walletPath = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");

if (!invoiceId) {
  console.error("Usage: node recover-payment.cjs --invoice-id <hex> [--deposit-sig <sig>] [--network devnet|mainnet] [--retry-url <url>]");
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const PAYMENTS_LEDGER = path.join(os.homedir(), ".veilpay", "payments.json");

const RPC = network === "mainnet"
  ? (process.env.VEILPAY_RPC_URL || "https://api.mainnet-beta.solana.com")
  : (process.env.VEILPAY_RPC_URL || "https://api.devnet.solana.com");

// ─── Ledger helpers ───────────────────────────────────────────────────────────

function getLedgerEntry(id) {
  if (!fs.existsSync(PAYMENTS_LEDGER)) return null;
  try {
    return JSON.parse(fs.readFileSync(PAYMENTS_LEDGER, "utf8"))[id] || null;
  } catch { return null; }
}

function updateLedgerEntry(id, patch) {
  fs.mkdirSync(path.dirname(PAYMENTS_LEDGER), { recursive: true });
  let ledger = {};
  if (fs.existsSync(PAYMENTS_LEDGER)) {
    try { ledger = JSON.parse(fs.readFileSync(PAYMENTS_LEDGER, "utf8")); } catch {}
  }
  ledger[id] = { ...(ledger[id] || {}), ...patch };
  fs.writeFileSync(PAYMENTS_LEDGER, JSON.stringify(ledger, null, 2));
}

// Extract depositSig from a legacy 2-part auth entry: "x402 <depositSig>:<invoiceId>"
function extractLegacyDepositSig(entry) {
  if (!entry?.authValue) return null;
  const inner = entry.authValue.replace(/^x402\s+/, "");
  const parts = inner.split(":");
  return parts.length === 2 ? parts[0] : null;
}

// ─── Wallet helper ────────────────────────────────────────────────────────────

function loadPayerAddress() {
  try {
    const { Keypair } = require("@solana/web3.js");
    const data = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    const secretBytes = Buffer.from(data.secretKey, "base64");
    const keypair = secretBytes.length === 64
      ? Keypair.fromSecretKey(secretBytes)
      : Keypair.fromSeed(secretBytes.slice(0, 32));
    return keypair.publicKey.toString();
  } catch {
    return null;
  }
}

// ─── HTTP retry helper ────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers,
    };
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const { Connection, PublicKey } = require("@solana/web3.js");

  console.log(`\n🔑 Recovering payment for invoice: ${invoiceId.slice(0, 16)}…`);
  console.log(`   Network: ${network}\n`);

  // ── Strategy 1: Full ledger hit ──────────────────────────────────────────────
  const entry = getLedgerEntry(invoiceId);

  if (entry?.proofTxSig && entry?.depositSig) {
    console.log("✅ Strategy 1: Found full signatures in local ledger.\n");
    const authValue = `x402 ${entry.proofTxSig}:${entry.depositSig}:${invoiceId}`;
    printAuth(authValue);
    if (retryUrl) await retry(authValue);
    process.exit(0);
  }

  // Also covers entries where the full 3-part auth is embedded in authValue
  if (entry?.authValue) {
    const inner = entry.authValue.replace(/^x402\s+/, "");
    const parts = inner.split(":");
    if (parts.length === 3) {
      console.log("✅ Strategy 1: Full auth parseable from ledger authValue.\n");
      // Backfill individual sigs into ledger for future instant lookups
      updateLedgerEntry(invoiceId, { proofTxSig: parts[0], depositSig: parts[1] });
      printAuth(entry.authValue);
      if (retryUrl) await retry(entry.authValue);
      process.exit(0);
    }
  }

  if (entry) {
    console.log("⚠️  Ledger entry exists but lacks individual signatures (legacy format).");
    console.log("   Falling back to on-chain scan…\n");
  } else {
    console.log("ℹ️  Invoice not found in local ledger. Attempting on-chain scan…\n");
  }

  // ── Strategy 2: On-chain scan ────────────────────────────────────────────────
  // Determine the deposit sig to scan from
  const knownDepositSig = depositSig
    || entry?.depositSig
    || extractLegacyDepositSig(entry);

  if (!knownDepositSig) {
    console.error("❌ Cannot recover: no deposit signature available.");
    console.error("   Provide --deposit-sig <sig> (the second tx from the original payment output).");
    console.error("   For old-format auth (x402 <sig>:<invoiceId>), the sig before the colon is the deposit sig.");
    process.exit(1);
  }

  const payerAddress = loadPayerAddress();
  if (!payerAddress) {
    console.error("❌ Cannot load wallet. Ensure wallet.json exists at ~/.veilpay/wallet.json");
    process.exit(1);
  }

  console.log(`🔍 Scanning tx history for: ${payerAddress}`);
  console.log(`   Deposit tx:  ${knownDepositSig.slice(0, 24)}…`);

  const connection = new Connection(RPC, "confirmed");

  // Confirm the deposit tx exists
  const depositTx = await connection.getTransaction(knownDepositSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!depositTx) {
    console.error(`\n❌ Deposit tx not found on ${network}. Wrong network, or tx has been pruned.`);
    process.exit(1);
  }

  const depositSlot = depositTx.slot;
  console.log(`   Deposit confirmed at slot ${depositSlot}`);

  // The proof account tx is sent immediately before the deposit tx in the same SDK call.
  // getSignaturesForAddress with `before` returns sigs older than the given sig, newest first.
  const sigsBeforeDeposit = await connection.getSignaturesForAddress(
    new PublicKey(payerAddress),
    { before: knownDepositSig, limit: 20 },
    "confirmed"
  );

  // Filter to txs within 150 slots (~60 seconds) — tight enough to exclude unrelated txs
  const nearby = sigsBeforeDeposit.filter(s => depositSlot - s.slot <= 150 && !s.err);

  if (nearby.length === 0) {
    console.error("\n❌ No clean transactions found close to the deposit slot.");
    console.error("   The proof tx may have been pruned or occurred > 60 seconds before the deposit.");
    process.exit(1);
  }

  const recoveredProofSig = nearby[0].signature;
  const slotDelta = depositSlot - nearby[0].slot;

  console.log(`\n   Candidate proof tx: ${recoveredProofSig.slice(0, 24)}… (${slotDelta} slots before deposit)`);

  if (slotDelta > 50) {
    console.log("   ⚠️  Slot distance is large — verify the auth works before assuming it's correct.");
  }

  const authValue = `x402 ${recoveredProofSig}:${knownDepositSig}:${invoiceId}`;

  // Persist recovered sigs back to ledger so future calls use Strategy 1
  updateLedgerEntry(invoiceId, {
    proofTxSig:  recoveredProofSig,
    depositSig:  knownDepositSig,
    authValue,
    recovered:   true,
    recoveredAt: Date.now(),
  });
  console.log("   Ledger updated with recovered signatures.");

  console.log("\n✅ Authorization reconstructed from on-chain data.\n");
  printAuth(authValue);

  if (retryUrl) await retry(authValue);
  process.exit(0);
})().catch((e) => {
  console.error(`\n❌ Error: ${e.message}`);
  process.exit(1);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printAuth(authValue) {
  console.log(`AUTHORIZATION: ${authValue}`);
  console.log(`\nRetry your request with:`);
  console.log(`  -H "Authorization: ${authValue}"`);
}

async function retry(authValue) {
  console.log(`\n⏳ Waiting 5 seconds before retrying…`);
  await new Promise(r => setTimeout(r, 5000));
  console.log(`Retrying: ${retryUrl}`);
  const { status, body } = await httpGet(retryUrl, { Authorization: authValue });
  console.log(`Status: ${status}`);
  try { console.log(JSON.stringify(JSON.parse(body), null, 2)); }
  catch { console.log(body); }
}
