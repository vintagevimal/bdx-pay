# BDX Pay

**A privacy-first, self-hosted payment gateway for Beldex (BDX).**
Merchants accept BDX without handing customer data, spend keys, or transaction metadata to any third party.

## Why it exists
Existing payment gateways ask merchants to trust a middleman with order data, customer IPs and wallet access, which defeats the point of a privacy coin. BDX Pay runs on the merchant's own machine, talks only to their own wallet, and keeps the minimum possible data.

## What it does
1. Merchant's shop calls `POST /api/invoices` with an amount.
2. BDX Pay asks the wallet for a **fresh subaddress** and returns a checkout link.
3. The customer opens `/pay/<id>`, sends BDX to that one-time address.
4. A watcher detects the payment, counts confirmations, and sends a **HMAC-signed webhook** to the shop.
5. Finished invoices are **automatically deleted** after a retention period.

## Privacy design (the point of the project)
| Principle | How it is implemented |
|---|---|
| Unlinkable payments | One new subaddress per invoice, so two orders cannot be linked on-chain |
| No spend keys on the server | Designed for a **view-only** wallet (detect payments, cannot move funds). Beldex v7.0.3 added view-key-only background sync |
| Data minimisation | Invoice = amount, address, status, optional merchant order reference. No names, emails, IPs, user agents |
| No tracking | No cookies, no analytics, no external fonts/scripts/CDNs; strict CSP; `Referrer-Policy: no-referrer`; no access logs |
| Short retention | Closed invoices purged after `RETENTION_HOURS` (default 24h) |
| Unguessable links | 128-bit random invoice IDs |
| Authenticated integration | API key (constant-time compare) + HMAC-SHA256 webhooks |
| Safe money math | BigInt atomic units, never floats |
| Tor-friendly | Zero third-party requests, works with JS-light browsers and `.onion` reverse proxies |
| Auditable | Zero npm dependencies, about 350 lines |

## Quick start (no node needed, mock wallet)
```
npm run dev
curl -X POST localhost:8080/api/invoices -H "x-api-key: dev-only-key-change-me-0000" -d '{"amount":"2.5"}'
# open the returned payUrl, then simulate a payment:
curl -X POST localhost:8080/dev/pay/<id>
```
Needs Node 20.6+.

## Real wallet setup
1. Run `beldexd` and `beldex-wallet-rpc` (Beldex v7.0.3+), **bound to 127.0.0.1 only**, with a **view-only** wallet.
2. `cp .env.example .env`, set `API_KEY`, `WEBHOOK_SECRET`, `WALLET_RPC_URL`.
3. `npm start`, then put a TLS reverse proxy (or Tor onion service) in front.
4. **Verify** `src/rpc.js` method names (`create_address`, `get_transfers`) and `ATOMIC_UNITS` against the Beldex docs for your version. All wallet-specific code is in that one file.

## Roadmap / grant milestones
- **M1 (this repo):** wallet client, invoice engine, watcher, signed webhooks, private checkout, tests.
- **M2:** testnet validation, view-only wallet hardening, underpayment/overpayment handling, Docker image.
- **M3:** vendored offline QR code, WooCommerce plugin, JS client SDK with TypeScript types.
- **M4:** security review, onion-service deployment guide, merchant docs, demo video.

## Webhook verification (merchant side)
`x-bdxpay-signature` = hex HMAC-SHA256 of the raw request body using `WEBHOOK_SECRET`. Compare in constant time.

## License
MIT

> **Status:** this prototype currently runs against a mock wallet. Testing against a real Beldex wallet on testnet is Milestone 2.
