#!/usr/bin/env node
/**
 * transfer.cjs — Confidential direct transfer to a VeilPay-registered address.
 *
 * Sends from the agent's public wallet directly into the recipient's Umbra
 * encrypted balance. The amount is hidden on-chain via Arcium MPC; the
 * sender↔recipient relationship is visible (unlike private links).
 *
 * Usage:
 *   node transfer.cjs --to <address> --amount <number> --token <SOL|USDC> [--network devnet|mainnet]
 *
 * The recipient MUST have connected to VeilPay at least once so their
 * Umbra account PDAs are initialised on-chain.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const args = process.argv.slice(2);
const get  = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const toAddr     = get("--to");
const amountArg  = get("--amount");
const token      = (get("--token") || "SOL").toUpperCase();
const network    = get("--network") || process.env.VEILPAY_NETWORK || "mainnet";
const walletPath = get("--wallet") || process.env.VEILPAY_WALLET_PATH
  || path.join(os.homedir(), ".veilpay", "wallet.json");

if (!toAddr || !amountArg) {
  console.error("Usage: node transfer.cjs --to <address> --amount <number> --token <SOL|USDC> [--network devnet|mainnet]");
  process.exit(1);
}

const TOKEN_CONFIG = {
  SOL:  { mint: "So11111111111111111111111111111111111111112",  decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  USDT: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
};

if (!TOKEN_CONFIG[token]) {
  console.error(`Unsupported token: ${token}. Use SOL, USDC, or USDT.`);
  process.exit(1);
}

const tokenCfg  = TOKEN_CONFIG[token];
const amountRaw = BigInt(Math.round(parseFloat(amountArg) * 10 ** tokenCfg.decimals));

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
    getUserAccountQuerierFunction,
    getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
    getPollingTransactionForwarder, getPollingComputationMonitor,
  } = require("@umbra-privacy/sdk");

  // Load agent wallet
  if (!fs.existsSync(walletPath)) {
    console.error(`No wallet at ${walletPath}. Run: node wallet.cjs create`);
    process.exit(1);
  }
  const walletData   = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const secretBytes  = Buffer.from(walletData.secretKey, "base64");
  const senderSigner = await createSignerFromPrivateKeyBytes(secretBytes);

  console.log(`\nSender:    ${senderSigner.address}`);
  console.log(`Recipient: ${toAddr}`);
  console.log(`Amount:    ${amountArg} ${token} (hidden on-chain)`);
  console.log(`Network:   ${network}`);

  const client = await getUmbraClient(
    { signer: senderSigner, network, rpcUrl: RPC,
      rpcSubscriptionsUrl: RPC.replace("https://", "wss://"),
      indexerApiEndpoint: INDEXER, deferMasterSeedSignature: true },
    { transactionForwarder: getPollingTransactionForwarder({ rpcUrl: RPC }),
      computationMonitor:   getPollingComputationMonitor({ rpcUrl: RPC }) }
  );

  // Verify recipient has a registered Umbra account
  console.log("\nVerifying recipient has a VeilPay account…");
  const querier   = getUserAccountQuerierFunction({ client });
  const recState  = await querier(toAddr);
  if (recState.state !== "exists" || !recState.data.isUserAccountX25519KeyRegistered) {
    console.error("\n❌ Recipient has no VeilPay account.");
    console.error("   They must visit veilpayments.xyz and connect their wallet at least once before receiving confidential transfers.");
    process.exit(1);
  }
  console.log("   Recipient verified ✓");

  // Send confidential transfer
  console.log("\nSending confidential transfer…");
  const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction({ client });
  const sig = await deposit(toAddr, tokenCfg.mint, amountRaw);

  const sigStr = typeof sig === "string" ? sig : String(sig);
  console.log("\n✅ Confidential transfer sent!");
  console.log(`   Recipient: ${toAddr}`);
  console.log(`   Amount:    hidden on-chain (${amountArg} ${token})`);
  if (sigStr && sigStr.length > 10) {
    console.log(`   Explorer:  https://solscan.io/tx/${sigStr}${SOLANA_NETWORK_SUFFIX}`);
  }
  console.log("\nNote: The recipient can withdraw from their Dashboard at veilpayments.xyz");
})().catch((e) => {
  console.error("\n❌ Transfer failed:", e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
