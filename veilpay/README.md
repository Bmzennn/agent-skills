# VeilPay Agent Skill

Private payments on Solana for AI agents. Powered by the [Umbra ZK shielded pool](https://umbraprivacy.com).

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
| Check link status | `check-link.cjs` | pending / claimed / delivered / not_found |
| Query balance | `balance.cjs` | Check encrypted balance waiting to be withdrawn |
| Withdraw balance | `withdraw.cjs` | Move encrypted balance to public wallet |

## Web app

**[veilpayments.xyz](https://www.veilpayments.xyz)** — full UI for all operations.
