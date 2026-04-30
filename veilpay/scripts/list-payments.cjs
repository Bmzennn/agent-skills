#!/usr/bin/env node
/**
 * list-payments.cjs — Audit all x402 payments in the local ledger.
 *
 * Shows every payment with its recoverability status:
 *   ✅ full       — proofTxSig + depositSig both saved; can reconstruct auth instantly
 *   ⚠️  scannable  — only depositSig available; on-chain scan needed to recover
 *   ❌ legacy     — only authValue saved (old format); cannot recover without manual input
 *   🔄 recovered  — was missing sigs but recovered via on-chain scan
 *
 * Usage:
 *   node list-payments.cjs [--network devnet|mainnet] [--verbose]
 *
 * Options:
 *   --network   filter by network (devnet or mainnet)
 *   --verbose   show full signatures and auth values
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ─── Args ─────────────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const get           = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const has           = (f) => args.includes(f);
const filterNetwork = get("--network");
const verbose       = has("--verbose");

// ─── Load ledger ──────────────────────────────────────────────────────────────

const PAYMENTS_LEDGER = path.join(os.homedir(), ".veilpay", "payments.json");

if (!fs.existsSync(PAYMENTS_LEDGER)) {
  console.log("\nNo payments ledger found.");
  console.log("Ledger is created automatically when you run pay-invoice.cjs.");
  console.log(`Expected location: ${PAYMENTS_LEDGER}\n`);
  process.exit(0);
}

let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(PAYMENTS_LEDGER, "utf8"));
} catch (e) {
  console.error(`Failed to read ledger: ${e.message}`);
  process.exit(1);
}

const allEntries = Object.entries(ledger).map(([id, data]) => ({ id, ...data }));

if (allEntries.length === 0) {
  console.log("\nNo payments recorded yet.\n");
  process.exit(0);
}

// ─── Filter & sort ────────────────────────────────────────────────────────────

const entries = filterNetwork
  ? allEntries.filter(e => e.network === filterNetwork)
  : allEntries;

entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

if (entries.length === 0) {
  console.log(`\nNo payments found for network: ${filterNetwork}\n`);
  process.exit(0);
}

// ─── Classify recoverability ──────────────────────────────────────────────────

function parseAuthParts(e) {
  if (!e.authValue) return null;
  const inner = e.authValue.replace(/^x402\s+/, "");
  const parts = inner.split(":");
  if (parts.length === 3) return { proofTxSig: parts[0], depositSig: parts[1] };
  if (parts.length === 2) return { depositSig: parts[0] };
  return null;
}

function classifyEntry(e) {
  if (e.recovered)                return { icon: "🔄", label: "recovered  " };
  if (e.proofTxSig && e.depositSig) return { icon: "✅", label: "full       " };
  const parsed = parseAuthParts(e);
  if (parsed?.proofTxSig)         return { icon: "✅", label: "parseable  " };
  if (parsed?.depositSig)         return { icon: "⚠️ ", label: "scannable  " };
  return                                 { icon: "❌", label: "legacy     " };
}

// ─── Totals ───────────────────────────────────────────────────────────────────

const totals = {};
let unknownCount = 0;
for (const e of entries) {
  if (e.amount != null && e.token) {
    totals[e.token] = (totals[e.token] || 0) + parseFloat(e.amount);
  } else {
    unknownCount++;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

const LINE = "─".repeat(80);

console.log(`\n📋  VeilPay x402 Payment Ledger`);
if (filterNetwork) console.log(`    Filter: ${filterNetwork} only`);
console.log(LINE);
console.log(
  "  " +
  "Date (UTC)           ".padEnd(22) +
  "Invoice ID           ".padEnd(22) +
  "Amount       ".padEnd(14) +
  "Net     ".padEnd(9) +
  "Status"
);
console.log(LINE);

for (const e of entries) {
  const date    = e.timestamp
    ? new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 19)
    : "unknown            ";
  const idShort = `${e.id.slice(0, 8)}…${e.id.slice(-6)}`;
  const amount  = e.amount != null && e.token
    ? `${e.amount} ${e.token}`.padEnd(13)
    : "unknown      ";
  const net     = (e.network || "?").padEnd(8);
  const { icon, label } = classifyEntry(e);

  console.log(`  ${date}   ${idShort.padEnd(21)} ${amount} ${net} ${icon} ${label}`);

  if (verbose) {
    if (e.destination)  console.log(`       Dest:    ${e.destination}`);
    if (e.proofTxSig)   console.log(`       Proof:   ${e.proofTxSig}`);
    if (e.depositSig)   console.log(`       Deposit: ${e.depositSig}`);
    if (e.authValue)    console.log(`       Auth:    ${e.authValue}`);
    if (e.recovered)    console.log(`       Recovered at: ${new Date(e.recoveredAt).toISOString()}`);
    console.log();
  }
}

console.log(LINE);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  Total payments: ${entries.length}`);

for (const [token, total] of Object.entries(totals)) {
  console.log(`  Total spent (${token}): ${total.toFixed(4)} ${token}`);
}
if (unknownCount > 0) {
  console.log(`  ${unknownCount} payment(s) with unknown amount (pre-date ledger enrichment)`);
}

const legacyCount    = entries.filter(e => classifyEntry(e).label.trim() === "legacy"    ).length;
const scannableCount = entries.filter(e => classifyEntry(e).label.trim() === "scannable" ).length;
const recoveredCount = entries.filter(e => e.recovered                                   ).length;
const parseableCount = entries.filter(e => classifyEntry(e).label.trim() === "parseable" ).length;

if (parseableCount > 0) {
  console.log(`\n  ✅ ${parseableCount} parseable entry(s) — full auth embedded in authValue, no scan needed.`);
}
if (legacyCount > 0) {
  console.log(`\n  ❌ ${legacyCount} legacy entry(s) — cannot recover without manual --deposit-sig input.`);
}
if (scannableCount > 0) {
  console.log(`  ⚠️  ${scannableCount} scannable entry(s) — run recover-payment.cjs --invoice-id <id> to fix.`);
}
if (recoveredCount > 0) {
  console.log(`  🔄 ${recoveredCount} entry(s) recovered via on-chain scan.`);
}

console.log();
