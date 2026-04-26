---
name: veilpay
description: Make and receive private payments on Solana via VeilPay. Use when an agent needs to send funds without an on-chain link between sender and recipient, generate shareable payment links, claim incoming payments, perform confidential transfers, or query encrypted balances. Powered by the Umbra ZK shielded pool.
---

# VeilPay Agent Skill

VeilPay enables fully private payments on Solana. The sender and recipient are never linked on-chain — a Groth16 ZK proof breaks any cryptographic connection between deposit and withdrawal.

---

## ⚠️ Full Runtime Preparation — Run Before Any Script

Never assume the environment is ready. ZK-SNARK skills have complex peer dependencies, binary requirements, and browser-vs-Node.js conflicts that must be resolved before first execution.

### Phase 1: Dependency Installation

```bash
cd <skill-directory>
rm -rf node_modules          # clean slate avoids partial-install conflicts
npm install --legacy-peer-deps
```

`--legacy-peer-deps` is **required** — the Umbra SDK and the ZK prover have conflicting peer dependency requirements. Standard `npm install` fails.

**`bs58` is pinned to `4.0.1` — do not upgrade it.** After v4, bs58 changed its export structure. Higher versions silently break scripts with `TypeError: bs58.encode is not a function`.

### Phase 2: Smoke Test

Verify critical runtime dependencies before running any command:
```bash
node -e "require('snarkjs'); require('bs58'); console.log('Runtime Ready')"
```

### Phase 3: Reliability & Troubleshooting

Based on field feedback, several technical hurdles have been resolved in the current script versions:

1.  **Authorization Format**: Modern VeilPay servers require "Shielded UTXO" (Receiver-Claimable) payments. `pay-invoice.cjs` has been updated to generate a 3-part header: `x402 <proofAccountSig>:<utxoSig>:<invoiceId>`.
2.  **SDK Response Mapping**: The script correctly maps `createProofAccountSignature` and `createUtxoSignature` from the Umbra SDK to the authorization header.
3.  **Indexer Lag**: Shielded transactions are not immediately visible to the Umbra indexer. `pay-invoice.cjs` now includes a mandatory 15-second sleep after broadcast to ensure the server can verify the payment on-chain.
4.  **Devnet Reliability**: All scripts now use `skipPreflight: true` and `confirmed` blockhashes to bypass simulation failures and propagation lag on Solana devnet.

---

## Command Reference

### Create Agent Wallet
Generates a new Solana keypair and stores it at `~/.veilpay/wallet.json`.
```bash
node scripts/wallet.cjs create
```

### Perform Shielded x402 Payment
Fulfills an x402 invoice by depositing into the Umbra Shielded Pool. 
**Note:** Includes a mandatory 15-second wait for indexer sync.
```bash
# invoice_json: The "invoice" object from a 402 response
# --network: devnet or mainnet (default: mainnet)
node scripts/pay-invoice.cjs '<invoice_json>' [--network devnet]
```

### Create Private Payment Link
Generates a shareable ZK-shielded payment URL.
```bash
node scripts/create-link.cjs --amount 0.5 --token SOL --network devnet
```

### Claim Private Payment Link
Autonomously claims funds from a link into the agent's wallet.
```bash
node scripts/claim-link.cjs --link "<url>" --network devnet
```

### Flawless Agent Checklist

```
□ Is snarkjs installed?           node -e "require('snarkjs')"
□ Is bs58 version 4.0.1?          node -e "console.log(require('bs58/package.json').version)"
□ Is wallet.json in base64?       node scripts/wallet.cjs show
□ Is SOL balance ≥ 0.05?          node scripts/wallet.cjs balance
□ Is indexer sync wait active?    (Default in pay-invoice.cjs)
```
