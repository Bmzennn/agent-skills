#!/usr/bin/env node
/**
 * withdraw.cjs — Withdraw encrypted balance to the agent's public wallet.
 *
 * If the agent received a confidential transfer, the funds sit in its
 * Umbra encrypted balance. This script moves them to the public wallet.
 *
 * Usage:
 *   node withdraw.cjs --token <SOL|USDC> [--network devnet|mainnet]
 *   node withdraw.cjs --all [--network devnet|mainnet]   ← withdraw all tokens with balance
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const args = process.argv.slice(2);
const get  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const has  = (f) => args.includes(f);

const tokenArg   = get("--token");
const withdrawAll = has("--all");
const network    = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const walletPath = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");

if (!tokenArg && !withdrawAll) {
  console.error("Usage:");
  console.error("  node withdraw.cjs --token <SOL|USDC|USDT>   withdraw a specific token");
  console.error("  node withdraw.cjs --all                      withdraw all tokens with balance");
  process.exit(1);
}

const TOKEN_CONFIG = {
  SOL:  { mint: "So11111111111111111111111111111111111111112",  decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
};

if (tokenArg && !TOKEN_CONFIG[tokenArg.toUpperCase()]) {
  console.error(`Unsupported token: ${tokenArg}. Use SOL, USDC, or USDT.`);
  process.exit(1);
}

const RPC = network === "mainnet"
  ? (process.env.VEILPAY_RPC_URL || "https://api.mainnet-beta.solana.com")
  : (process.env.VEILPAY_RPC_URL || "https://api.devnet.solana.com");

const INDEXER = network === "mainnet"
  ? "https://utxo-indexer.api.umbraprivacy.com"
  : "https://utxo-indexer.api-devnet.umbraprivacy.com";

const SOLANA_NETWORK_SUFFIX = network === "mainnet" ? "" : `?cluster=${network}`;

(async () => {
  const {
    createSignerFromPrivateKeyBytes, getUmbraClient,
    getEncryptedBalanceQuerierFunction,
    getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction,
    getPollingTransactionForwarder, getPollingComputationMonitor,
  } = require("@umbra-privacy/sdk");

  // Load agent wallet
  if (!fs.existsSync(walletPath)) {
    console.error(`No wallet at ${walletPath}. Run: node wallet.cjs create`);
    process.exit(1);
  }
  const walletData  = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const secretBytes = Buffer.from(walletData.secretKey, "base64");
  const signer      = await createSignerFromPrivateKeyBytes(secretBytes);

  console.log(`\nWallet:  ${signer.address}`);
  console.log(`Network: ${network}`);

  const client = await getUmbraClient(
    { signer, network, rpcUrl: RPC,
      rpcSubscriptionsUrl: RPC.replace("https://", "wss://"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: getPollingTransactionForwarder({ rpcUrl: RPC }),
      computationMonitor:   getPollingComputationMonitor({ rpcUrl: RPC }) }
  );

  const querier  = getEncryptedBalanceQuerierFunction({ client });
  const withdraw = getEncryptedBalanceToPublicBalanceDirectWithdrawerFunction({ client });

  // Determine which tokens to withdraw
  const tokensToCheck = withdrawAll
    ? Object.keys(TOKEN_CONFIG)
    : [tokenArg.toUpperCase()];

  const mints   = tokensToCheck.map((t) => TOKEN_CONFIG[t].mint);
  const balMap  = await querier(mints);

  let withdrew = 0;

  for (const symbol of tokensToCheck) {
    const cfg    = TOKEN_CONFIG[symbol];
    const result = balMap.get(cfg.mint);

    if (!result || result.state !== "shared") {
      console.log(`\n${symbol}: no encrypted balance`);
      continue;
    }

    const raw = BigInt(result.balance.toString());
    if (raw === 0n) {
      console.log(`\n${symbol}: balance is 0`);
      continue;
    }

    const human = (Number(raw) / 10 ** cfg.decimals).toFixed(cfg.decimals === 6 ? 2 : 6);
    console.log(`\nWithdrawing ${human} ${symbol}…`);

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const sig = await withdraw(signer.address, cfg.mint, raw);
        const sigStr = typeof sig === "string" ? sig : String(sig);
        console.log(`✅ ${human} ${symbol} withdrawn to public wallet`);
        if (sigStr && sigStr.length > 10) {
          console.log(`   Explorer: https://solscan.io/tx/${sigStr}${SOLANA_NETWORK_SUFFIX}`);
        }
        withdrew++;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = e.message.toLowerCase();
        const retryable = msg.includes("timeout") || msg.includes("blockhash") || msg.includes("expired");
        if (attempt < 3 && retryable) {
          console.log(`   Attempt ${attempt} failed, retrying…`);
          await new Promise((r) => setTimeout(r, 2000));
        } else break;
      }
    }

    if (lastErr) {
      console.error(`❌ Failed to withdraw ${symbol}: ${lastErr.message}`);
    }
  }

  if (withdrew === 0) {
    console.log("\nNo balances to withdraw.");
    console.log("Check your balance with: node balance.cjs");
  }
})().catch((e) => {
  console.error("\n❌ Withdraw failed:", e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
