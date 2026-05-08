#!/usr/bin/env node
/**
 * balance.cjs — Query public and encrypted (shielded) balances for your VeilPay wallet.
 *
 * Shows two sections:
 *   Public wallet  — regular on-chain balances (SOL + all supported SPL tokens)
 *   Shielded pool  — encrypted balances waiting to be withdrawn
 *
 * Usage:
 *   node balance.cjs [--network devnet|mainnet] [--wallet <path>]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const network = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const walletPath = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");

const RPC = network === "mainnet"
  ? (process.env.VEILPAY_RPC_URL || "https://api.mainnet-beta.solana.com")
  : (process.env.VEILPAY_RPC_URL || "https://api.devnet.solana.com");

const INDEXER = network === "mainnet"
  ? "https://utxo-indexer.api.umbraprivacy.com"
  : "https://utxo-indexer.api-devnet.umbraprivacy.com";

const TOKEN_CONFIG = {
  SOL:   { mint: "So11111111111111111111111111111111111111112",          decimals: 9 },
  USDC:  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",       decimals: 6 },
  USDT:  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",       decimals: 6 },
  UMBRA: { mint: "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta",        decimals: 6 },
  CASH:  { mint: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH",      decimals: 6 },
};

(async () => {
  if (!fs.existsSync(walletPath)) {
    console.error(`No wallet found at ${walletPath}. Run: node wallet.cjs create`);
    process.exit(1);
  }

  const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");
  const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
  const { createSignerFromPrivateKeyBytes, getUmbraClient,
          getEncryptedBalanceQuerierFunction,
          getPollingTransactionForwarder, getPollingComputationMonitor } = require("@umbra-privacy/sdk");

  const walletData = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const secretKeyBytes = Buffer.from(walletData.secretKey, "base64");

  const signer  = await createSignerFromPrivateKeyBytes(secretKeyBytes);
  const address = signer.address.toString();
  const pubkey  = new PublicKey(address);

  console.log(`\nWallet: ${address}`);
  console.log(`Network: ${network}\n`);

  // ── Public balances ──────────────────────────────────────────────────────────
  const connection = new Connection(RPC, "confirmed");

  console.log("── Public wallet ───────────────────────────────────────");

  // SOL
  const solLamports = await connection.getBalance(pubkey, "confirmed");
  const solHuman    = (solLamports / LAMPORTS_PER_SOL).toFixed(6);
  console.log(`  SOL    ${solHuman}`);

  // SPL tokens
  for (const [symbol, cfg] of Object.entries(TOKEN_CONFIG)) {
    if (symbol === "SOL") continue;
    try {
      const ata     = getAssociatedTokenAddressSync(new PublicKey(cfg.mint), pubkey, true);
      const info    = await connection.getTokenAccountBalance(ata, "confirmed");
      const human   = parseFloat(info.value.uiAmountString ?? "0").toFixed(cfg.decimals === 6 ? 2 : 4);
      if (parseFloat(human) > 0) {
        console.log(`  ${symbol.padEnd(6)} ${human}`);
      }
    } catch {
      // ATA doesn't exist — balance is 0, skip
    }
  }

  // ── Shielded (encrypted) balances ────────────────────────────────────────────
  console.log("\n── Shielded pool (encrypted) ───────────────────────────");

  const client = await getUmbraClient(
    { signer, network, rpcUrl: RPC, rpcSubscriptionsUrl: RPC.replace("https://", "wss://"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: getPollingTransactionForwarder({ rpcUrl: RPC }),
      computationMonitor: getPollingComputationMonitor({ rpcUrl: RPC }) }
  );

  const querier = getEncryptedBalanceQuerierFunction({ client });
  const mints = Object.values(TOKEN_CONFIG).map((t) => t.mint);
  const balMap = await querier(mints);

  let hasBalance = false;
  for (const [symbol, cfg] of Object.entries(TOKEN_CONFIG)) {
    const result = balMap.get(cfg.mint);
    if (result?.state === "shared") {
      const raw = BigInt(result.balance.toString());
      if (raw > 0n) {
        const human = (Number(raw) / 10 ** cfg.decimals).toFixed(cfg.decimals === 6 ? 2 : 4);
        console.log(`  ${symbol.padEnd(6)} ${human}  ← withdraw with: node withdraw.cjs --token ${symbol}`);
        hasBalance = true;
      }
    } else if (result?.state === "mxe") {
      // MXE = Arcium MPC computation in progress — balance exists but not yet finalized
      console.log(`  ${symbol.padEnd(6)} ⏳ pending  (Arcium MPC still processing — re-run this in a few minutes)`);
      hasBalance = true;
    }
  }

  if (!hasBalance) {
    console.log("  No shielded balances found.");
  }

  // Force exit — Umbra SDK holds WebSocket connections open indefinitely
  process.exit(0);
})().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
