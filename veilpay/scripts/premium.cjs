#!/usr/bin/env node
/**
 * premium.cjs — Call premium VeilPay API endpoints.
 *
 * This script demonstrates the x402 payment flow for AI agents.
 * 1. GET /api/premium/<table_name> -> receive 402 + invoice
 * 2. Pay invoice via shielded UTXO (calling pay-invoice.cjs logic)
 * 3. Retry GET with X-402-Payment header -> receive premium data
 *
 * Usage:
 *   node premium.cjs --table <links|merchant-requests|payments> [--network devnet|mainnet]
 */

"use strict";

const https = require("https");
const { execSync } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const get  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const table   = get("--table") || "links";
const network = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";

const API_BASE = network === "mainnet" 
  ? "https://veilpay.xyz" 
  : "https://devnet.veilpay.xyz";

const ENDPOINT = `${API_BASE}/api/premium/${table}`;

async function fetchPremiumData(authHeader = null) {
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (authHeader) headers["X-402-Payment"] = authHeader;

    https.get(ENDPOINT, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch (e) {
          reject(new Error("Failed to parse response: " + data.slice(0, 100)));
        }
      });
    }).on("error", reject);
  });
}

(async () => {
  console.log(`\nRequesting premium data for table: ${table} (${network})…`);
  
  // Step 1: Initial request
  const firstTry = await fetchPremiumData();

  if (firstTry.status === 200) {
    console.log("✅ Success! Already paid or free.");
    printTable(firstTry.body.data);
    return;
  }

  if (firstTry.status !== 402) {
    console.error(`❌ Error ${firstTry.status}:`, firstTry.body.error || firstTry.body.message);
    process.exit(1);
  }

  // Step 2: Payment Required
  const invoice = firstTry.body.invoice;
  console.log("💳 Payment Required (x402)");
  console.log(`   Amount: ${invoice.amount} ${invoice.token}`);
  console.log(`   Invoice ID: ${invoice.invoiceId.slice(0, 12)}…`);

  try {
    const payScript = path.join(__dirname, "pay-invoice.cjs");
    const invoiceJson = JSON.stringify(invoice);
    
    console.log("\n   Executing payment via shielded UTXO…");
    const output = execSync(`node "${payScript}" '${invoiceJson}' --network ${network}`, { encoding: "utf8" });
    
    const authMatch = output.match(/AUTHORIZATION: (x402 .+)/);
    if (!authMatch) {
      console.error("❌ Failed to parse authorization header from payment script.");
      console.log(output);
      process.exit(1);
    }

    const authHeader = authMatch[1];
    console.log("✅ Payment successful.");

    // Step 3: Retry with proof
    console.log("   Retrying request with proof of payment…");
    const secondTry = await fetchPremiumData(authHeader);

    if (secondTry.status === 200) {
      console.log("✅ Success! Premium data unlocked.");
      printTable(secondTry.body.data);
    } else {
      console.error(`❌ Retry failed (${secondTry.status}):`, secondTry.body.error);
      process.exit(1);
    }

  } catch (e) {
    console.error("\n❌ Payment flow failed:", e.message);
    process.exit(1);
  }
})();

function printTable(data) {
  if (!Array.isArray(data) || data.length === 0) {
    console.log("\nTable is empty.");
    return;
  }

  console.log("");
  console.table(data);
}
