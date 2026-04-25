---
name: veilpay
description: Make and receive private payments on Solana via VeilPay. Use when an agent needs to send funds without an on-chain link between sender and recipient, generate shareable payment links, claim incoming payments, perform confidential transfers, or query encrypted balances. Powered by the Umbra ZK shielded pool.
---

# VeilPay Agent Skill

VeilPay enables fully private payments on Solana. The sender and recipient are never linked on-chain — a Groth16 ZK proof breaks any cryptographic connection between deposit and withdrawal.

## Core Concepts

| Term | Meaning |
|---|---|
| **Private link** | A shareable URL containing an ephemeral claim key. Anyone with the link can claim funds to a fresh wallet. |
| **Confidential transfer** | Direct send to a VeilPay-registered address. Amount is hidden on-chain; sender↔recipient relationship is visible. |
| **Shielded pool** | Umbra's ZK pool where funds wait. An anonymity set of all UTXOs in the pool provides unlinkability. |
| **Ephemeral address** | A one-time keypair used as the anonymizing hop between sender and recipient. |
| **Claim secret** | The private key for the ephemeral address, encoded in the URL hash. Never touches any server. |

---

## When to Use Which Feature

```
Need to send to someone who doesn't have a Solana wallet?
  → Private Link (they claim later, no wallet needed upfront)

Need to send to an existing VeilPay user without revealing amount?
  → Confidential Transfer

Want to check if a payment link has been claimed?
  → Check Link Status

Have an incoming link and want to withdraw funds?
  → Claim Link
```

---

## Script Reference

All scripts require a funded agent wallet. Create one first:

```bash
node scripts/wallet.cjs create           # generate keypair, saved to ~/.veilpay/wallet.json
node scripts/wallet.cjs show             # print public address
node scripts/wallet.cjs balance          # print SOL balance
node scripts/wallet.cjs airdrop          # request devnet SOL (devnet only)
```

---

### 1. Generate a Private Payment Link

Deposits funds into the shielded pool and returns a claim URL. The recipient uses the URL to withdraw to their wallet.

```bash
node scripts/create-link.cjs \
  --amount 0.5 \
  --token SOL \
  --network devnet \
  [--memo "Invoice #42"] \
  [--lock-to <recipient_solana_address>]
```

**Output:**
```
✅ Private link created
Link: https://www.veilpayments.xyz/claim?lid=...&exp=...#<claim_secret>:SOL:<memo>
Amount: 0.5 SOL
Expires: 2026-05-03
Share this link with the recipient. The claim key (after #) is private.
```

**Options:**
- `--amount` — amount to send (required)
- `--token` — SOL or USDC (required)
- `--network` — devnet or mainnet (default: mainnet)
- `--memo` — optional message to recipient, encoded in the link
- `--lock-to` — restrict claiming to a specific wallet address

**Note:** Link creation requires ~0.018 SOL for ephemeral registration fees + the transfer amount. The ephemeral SOL is recovered when the recipient claims.

---

### 2. Claim a Payment Link

Reconstructs the ephemeral keypair from the claim secret, claims the UTXO from the shielded pool, and sweeps funds to the recipient wallet.

```bash
node scripts/claim-link.cjs \
  --link "https://www.veilpayments.xyz/claim?lid=...#<secret>:SOL" \
  --recipient <destination_wallet_address> \
  --network devnet
```

**Output:**
```
✅ Claim successful
Amount: 0.5 SOL
Delivered to: 7xKt...9mPq
Transaction: https://solscan.io/tx/...
```

**Note:** Claiming runs a full Groth16 ZK proof locally — this takes 20–60 seconds. The recipient address does not need to be a VeilPay user.

---

### 3. Confidential Transfer (Direct)

Sends directly to a VeilPay-registered address. Amount is hidden via Arcium MPC; the sender↔recipient link is visible on-chain but the amount is not.

```bash
node scripts/transfer.cjs \
  --to <recipient_veilpay_address> \
  --amount 100 \
  --token USDC \
  --network devnet
```

**Output:**
```
✅ Confidential transfer sent
Recipient: 7xKt...9mPq (registered VeilPay user)
Amount: hidden on-chain
Transaction: https://solscan.io/tx/...
```

**Note:** The recipient must have connected to VeilPay at least once to receive confidential transfers (their Umbra account must be registered).

---

### 4. Check Link Status

Checks whether a payment link has been funded, claimed, or already withdrawn — without needing the recipient's wallet.

```bash
node scripts/check-link.cjs \
  --link "https://www.veilpayments.xyz/claim?lid=...#<secret>:SOL" \
  --network devnet
```

**Output:**
```
Status: pending          # funds in pool, not yet claimed
Status: claimed          # ZK proof accepted, withdrawal in progress
Status: delivered        # funds swept to recipient's wallet
Status: not_found        # link expired or claim key is wrong
```

---

### 5. Query Encrypted Balance

Checks what encrypted balance (received via confidential transfers) is waiting in your VeilPay account.

```bash
node scripts/balance.cjs \
  --network devnet
```

**Output:**
```
Encrypted balances for 7xKt...9mPq:
  SOL:  0.0000
  USDC: 42.00  ← withdraw to claim
```

---

### 6. Withdraw Encrypted Balance

Withdraws your encrypted balance to your public wallet.

```bash
node scripts/withdraw.cjs \
  --token USDC \
  --network devnet
```

---

## Privacy Model — What This Hides

| What an observer sees | What they cannot see |
|---|---|
| A deposit entered the shielded pool | Which wallet deposited |
| An ephemeral address claimed from the pool | That the deposit and claim are the same payment |
| Funds arrived at the recipient's wallet | Who sent them |
| A confidential transfer occurred | The amount transferred |

**Residual risk:** Timing and amount correlation. If you deposit 1.5 SOL and the claim happens 2 minutes later for the same amount, a sophisticated analyst may guess. Longer delay = stronger anonymity set.

---

## Environment Variables

```bash
VEILPAY_NETWORK=devnet          # devnet or mainnet
VEILPAY_RPC_URL=https://...     # optional custom RPC (default: public devnet)
VEILPAY_WALLET_PATH=~/.veilpay/wallet.json  # default wallet location
```

---

## Web App

For a visual UI: **[veilpayments.xyz](https://www.veilpayments.xyz)**

All operations available as scripts above are also available in the web app with wallet connect (Phantom, Solflare, etc.).
