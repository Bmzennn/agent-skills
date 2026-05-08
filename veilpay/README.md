# VeilPay Agent Skill

Private payments on Solana mainnet for AI agents. Powered by the [Umbra ZK shielded pool](https://umbraprivacy.com).

## Install

```bash
npx skills add Bmzennn/agent-skills@veilpay
```

## What agents can do

| Operation | Script | Description |
|---|---|---|
| Create private link | `create-link.cjs` | Deposit to pool, get a shareable claim URL |
| Claim a link | `claim-link.cjs` | Withdraw funds from a link to any wallet |
| Confidential transfer | `transfer.cjs` | Send directly to a VeilPay address, amount hidden |
| Check link status | `check-link.cjs` | `pending` / `claimed` / `delivered` / `not_found` |
| Query balance | `balance.cjs` | Check encrypted balance waiting to be withdrawn |
| Withdraw balance | `withdraw.cjs` | Move encrypted balance to public wallet |
| Pay x402 invoice | `pay-invoice.cjs` | Pay a shielded x402 API invoice |
| Query premium data | `premium.cjs` | Fetch VeilPay API data via shielded x402 payment |
| List payments | `list-payments.cjs` | List payment history for an address |
| Recover payment | `recover-payment.cjs` | Recover stranded ephemeral SOL after a failed link creation |
| Wallet setup | `wallet.cjs` | Create/manage the agent keypair and config |

## Supported tokens

SOL · USDC · USDT · UMBRA · CASH

## Setup (one-time)

No registration, API key, or VeilPay account needed. Everything is self-contained.

```bash
# 1. Install the skill
npx skills add Bmzennn/agent-skills@veilpay
cd ~/.claude/skills/veilpay

# 2. Install dependencies
npm install --legacy-peer-deps

# 3. Create the agent wallet (generates a fresh Solana keypair for this agent)
node scripts/wallet.cjs create
# → prints your new agent address, e.g. 7xKp...4mRt

# 4. Set your overage wallet
#    This is any Solana address YOU already own (Phantom, Ledger, etc.)
#    Leftover SOL from ephemeral channels is swept here after each claim.
#    You can also use the agent wallet address printed in step 3.
node scripts/wallet.cjs config --overage-wallet <any_address_you_own>

# 5. Fund the agent wallet with at least 0.05 SOL for transaction fees
```

> `--legacy-peer-deps` is required — the Umbra SDK and ZK prover have conflicting peer dependency declarations. Standard `npm install` fails.

### What goes in config.json?

`~/.veilpay/config.json` only ever contains values you choose yourself — there are no shared secrets, platform API keys, or credentials from VeilPay. The scripts connect directly to Umbra's public relayer and indexer. The only required value is `overageWallet`, which is an address you already control.

## Script Reference

### Wallet management

```bash
node scripts/wallet.cjs create                              # Generate new keypair → ~/.veilpay/wallet.json
node scripts/wallet.cjs show                               # Print agent wallet address
node scripts/wallet.cjs balance                            # Print SOL balance
node scripts/wallet.cjs config --overage-wallet <addr>     # Set where leftover SOL goes after claims
```

### Create a private payment link

Anyone with the link can claim the funds into any wallet. Sender and recipient are never linked on-chain.

```bash
node scripts/create-link.cjs --amount 0.5 --token SOL
node scripts/create-link.cjs --amount 10 --token USDC
node scripts/create-link.cjs --amount 5 --token USDC --memo "Invoice #42"
node scripts/create-link.cjs --amount 1 --token SOL --lock-to <recipient_address>
```

Output: a `veilpayments.xyz/claim#...` URL to share with the recipient.

### Claim a private payment link

```bash
node scripts/claim-link.cjs --link "https://veilpayments.xyz/claim#<secret>:USDC"
node scripts/claim-link.cjs --link "<url>" --network mainnet
```

Funds are swept to the agent wallet. Leftover SOL from the ephemeral channel is swept to the configured overage wallet.

### Confidential transfer (direct send)

Send directly to a registered VeilPay address. The amount is hidden on-chain.

```bash
node scripts/transfer.cjs --to <recipient_address> --amount 5 --token USDC
node scripts/transfer.cjs --to <recipient_address> --amount 0.1 --token SOL
```

Recipient must have connected to VeilPay at least once. Funds arrive in their encrypted balance.

### Check link status

```bash
node scripts/check-link.cjs --link "https://veilpayments.xyz/claim#<secret>:SOL"
```

Returns: `pending` | `claimed` | `delivered` | `not_found`

### Query encrypted balance

```bash
node scripts/balance.cjs --network mainnet
node scripts/balance.cjs --token USDC
```

### Withdraw encrypted balance to public wallet

```bash
node scripts/withdraw.cjs --token USDC
node scripts/withdraw.cjs --token SOL --amount 0.1
node scripts/withdraw.cjs --token SOL --all
```

### Pay an x402 invoice (shielded API payment)

Fulfils an x402 payment challenge from any VeilPay-enabled API. Payment routes through the Umbra shielded pool — the server never sees which wallet paid.

```bash
node scripts/pay-invoice.cjs '<invoice_json>' --network mainnet
```

`invoice_json` is the `invoice` object from a `402 Payment Required` response body.

Output: the `X-402-Payment` header value to retry the request with.

> Successful payments are cached in `~/.veilpay/payments.json`. Retrying the same `invoiceId` returns the cached header without re-paying.

### Query premium data (x402-gated)

Fetches VeilPay system data by fulfilling a shielded payment challenge automatically.

```bash
node scripts/premium.cjs --table links
node scripts/premium.cjs --table merchant-requests
node scripts/premium.cjs --table payments
```

### List payments

```bash
node scripts/list-payments.cjs --address <solana_address>
node scripts/list-payments.cjs                              # uses agent wallet address
```

### Recover stranded SOL

If link creation fails mid-flow, the ephemeral account may retain SOL. Recover it with the original claim URL:

```bash
node scripts/recover-payment.cjs --link "https://veilpayments.xyz/claim#<secret>:USDC"
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VEILPAY_NETWORK` | `mainnet` | `mainnet` or `devnet` |
| `VEILPAY_RPC_URL` | Public mainnet RPC | Custom Solana RPC endpoint (recommended: Helius) |
| `VEILPAY_WALLET_PATH` | `~/.veilpay/wallet.json` | Path to agent keypair |
| `VEILPAY_OVERAGE_WALLET` | — | Fallback overage address (prefer `wallet.cjs config`) |

## Preflight checklist

```
□ snarkjs installed?        node -e "require('snarkjs')"
□ bs58 version is 4.0.1?    node -e "console.log(require('bs58/package.json').version)"
□ Wallet exists?            node scripts/wallet.cjs show
□ SOL balance ≥ 0.05?       node scripts/wallet.cjs balance
□ Overage wallet set?       node scripts/wallet.cjs config
□ Network is mainnet?       Scripts default to mainnet; --network devnet for dev only
```

## Web app

**[veilpayments.xyz](https://veilpayments.xyz)** — full UI for all operations including gift cards and merchant QR checkout.
