const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const fs = require("fs");
const path = require("path");
const os = require("os");

const WALLET_DIR = path.join(os.homedir(), ".veilpay");
const WALLET_FILE = path.join(WALLET_DIR, "wallet.json");

function ensureDir() {
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true });
  }
}

function createWallet() {
  ensureDir();
  if (fs.existsSync(WALLET_FILE)) {
    console.log("Error: Wallet already exists. Use 'show' to see details.");
    process.exit(1);
  }
  const kp = Keypair.generate();
  const data = {
    address: kp.publicKey.toBase58(),
    secretKey: bs58.encode(kp.secretKey)
  };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2));
  console.log("Success: Wallet created.");
  console.log(`Address: ${data.address}`);
}

function showWallet() {
  if (!fs.existsSync(WALLET_FILE)) {
    console.log("Error: No wallet found. Use 'create' first.");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  console.log(`Address: ${data.address}`);
}

function getSecret() {
  if (!fs.existsSync(WALLET_FILE)) {
    console.log("Error: No wallet found.");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
  console.log(data.secretKey);
}

const cmd = process.argv[2];
switch (cmd) {
  case "create":
    createWallet();
    break;
  case "show":
    showWallet();
    break;
  case "secret":
    getSecret();
    break;
  default:
    console.log("Usage: node wallet.cjs [create|show|secret]");
}
