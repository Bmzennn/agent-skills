# VeilPay Agent Skills

Private payments on Solana for AI agents. Powered by the [Umbra ZK shielded pool](https://umbraprivacy.com).

## Install

```bash
npx skills add Bmzennn/agent-skills@veilpay
```

## What agents can do

| Operation | Script | Description |
|---|---|---|
| Create wallet | `wallet.cjs ` | Generate a persistent agent Solana keypair |
| Check link status | `check-link.cjs` | pending / claimed / delivered / not_found |
| **Claim a link** | `claim-link.cjs` | Paste a link → funds arrive in agent's wallet |
| Query balance | `balance.cjs` | Check encrypted shielded balance |
| Confidential transfer | `transfer.cjs` |Make a confidential transfer to a VeilPay user |
| Create private link | `create-link.cjs` | Create a private payment link with optional memo |
| Withdraw balance | `withdraw.cjs` | Move funds from encrypted account to public balance |

## Claim a link

An agent can autonomously claim any VeilPay payment link it receives:

```bash
node scripts/claim-link.cjs \
  --link "https://www.veilpayments.xyz/claim?lid=...#<secret>:SOL" \
  --network devnet
```

The ZK proof runs locally. Circuit files (~100MB) are downloaded and cached in `~/.veilpay/zk-cache/` on first run.

---

Built on [VeilPay](https://www.veilpayments.xyz) · [Umbra Protocol](https://umbraprivacy.com)
