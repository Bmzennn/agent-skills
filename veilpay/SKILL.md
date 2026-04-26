---
name: veilpay
description: Make and receive private payments on Solana via VeilPay. Use when an agent needs to send funds without an on-chain link between sender and recipient, generate shareable payment links, claim incoming payments, perform confidential transfers, or query encrypted balances. Powered by the Umbra ZK shielded pool.
---

# VeilPay Agent Skill

VeilPay enables fully private payments on Solana. The sender and recipient are never linked on-chain — a Groth16 ZK proof breaks any cryptographic connection between deposit and withdrawal.

---

## ⚠️ Pre-Flight: Run This Before Any Script

The scripts require specific Node.js packages. **Do not assume they are installed.** Always run the setup command from the skill directory first:

```bash
cd <skill-directory>
npm install
```

The `package.json` in this skill pins exact versions — especially `bs58@4.0.1`. This is intentional. The bs58 library has a **breaking export change after v4**: older scripts expect `bs58.encode(bytes)` directly, while v5/v6 changed to a default export requiring `bs58.default.encode()`. Running `npm install` (without pinning) will silently install v6 and break the scripts with a `TypeError: bs58.encode is not a function`.

### Pre-flight checklist

```
1. cd into the skill directory (where package.json lives)
2. Run: npm install
3. Verify: node -e "const b=require('bs58'); console.log(typeof b.encode)"
   → should print "function" (not "undefined")
4. Run your command
5. Verify output with: node scripts/wallet.cjs show
```

### Diagnostic: if a script fails with `Cannot find module`

Read the `require()` statements at the top of the script, then install only those packages. Use `npm install bs58@4.0.1` — never just `npm install bs58` (gets v6).

---

## 🔄 Updating This Skill

When the user asks to update this skill, follow this protocol exactly. Do not assume the local folder is complete or up to date.

### Step 1 — Find the source repo

Check `skills-lock.json` in the project root for the exact GitHub source:
```bash
cat skills-lock.json | grep veilpay
```
Source: **https://github.com/Bmzennn/agent-skills** — skill folder: `veilpay/`

### Step 2 — Crawl the full remote tree before touching anything locally

Fetch the GitHub tree to see every file in the repo. Do not rely on what you see locally — scripts may have been added, removed, or renamed remotely without being reflected in the local folder.

```
GET https://api.github.com/repos/Bmzennn/agent-skills/git/trees/main?recursive=1
```

Or via web fetch: `https://github.com/Bmzennn/agent-skills/tree/main/veilpay`

Compare remote files against local files. Any file present remotely but missing locally must be downloaded.

### Step 3 — Sync `package.json` and `SKILL.md` first

These two files define requirements and intended behaviour. Always pull them before touching any script:

```bash
# Download package.json first — it pins critical versions
# Then SKILL.md — it tells you what each script is supposed to do
```

**Why this matters:** `bs58` underwent a breaking export change after v4. The `package.json` pins `bs58@4.0.1`. If you install without it, npm defaults to v6 which breaks every script that calls `bs58.encode()` directly with `TypeError: bs58.encode is not a function`.

### Step 4 — Overwrite all scripts at once

Never update scripts one at a time. The scripts share conventions (key encoding, wallet file format, error handling). A partial update creates inconsistencies — for example, `wallet.cjs` stores keys as **base64**, and every other script reads base64. Updating only some scripts breaks the key format contract.

```bash
# Copy all .cjs files from remote in one batch, then reinstall
```

### Step 5 — Clean reinstall with legacy peer deps

```bash
cd <skill-directory>
rm -rf node_modules
npm install --legacy-peer-deps
```

**Why `--legacy-peer-deps`:** The Umbra ZK prover and Umbra SDK have conflicting peer dependency requirements. Standard `npm install` fails. `--legacy-peer-deps` is required in any generic agent environment.

### Step 6 — Smoke test

```bash
node scripts/wallet.cjs show
```

If this returns an address, the runtime environment is correctly set up. If it throws `Cannot find module`, re-run Step 5. If it throws `TypeError: ... is not a function`, the bs58 pin failed — check that `node_modules/bs58/package.json` shows version `4.0.1`.

### Diagnostic: `TypeError: X is not a function`

This is a **100% signal of a major version mismatch**, not a code bug. Do not rewrite the script. Check the installed version of the failing package first:

```bash
node -e "console.log(require('bs58/package.json').version)"
# Must print 4.0.1 — anything higher breaks .encode() calls
```

---

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

Withdraws your encrypted balance to your public wallet. Supports a single token or `--all` to sweep everything.

```bash
node scripts/withdraw.cjs --token USDC --network devnet
node scripts/withdraw.cjs --all --network devnet
```

---

### 7. Pay an x402 Invoice

When an API responds with HTTP 402 Payment Required, use this to fulfill the invoice with a shielded Umbra deposit and get back the Authorization header value.

```bash
# Capture the invoice from the 402 response body, then:
node scripts/pay-invoice.cjs '{"amount":0.1,"token":"SOL","destination":"3uv9...","invoiceId":"a3f9...64hex"}' \
  --network devnet
```

**Output:**
```
✅ Invoice paid.

AUTHORIZATION: x402 5Kj9...:8Nm2...:a3f9...

Retry your request with:
  -H "Authorization: x402 5Kj9...:8Nm2...:a3f9..."
```

The `invoiceId` must be the exact 64-character hex string from the server's 402 response. The amount is shielded — the server sees a proof, not the raw transfer.

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
