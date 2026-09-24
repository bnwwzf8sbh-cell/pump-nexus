# PUMP NEXUS

Live pump.fun radar terminal. Recreates the PUMP NEXUS board (Radar / New / Live / Watch / Majors) as a read-only dashboard that polls public pump.fun and DexScreener endpoints.

**Not affiliated with pump.fun.** Display only. No wallet connect. No trading. Tokens on launchpads fail often — treat every number as unverified market data.

## Live demo (GitHub Pages)

After Pages is enabled on this repo:

`https://bnwwzf8sbh-cell.github.io/pump-nexus/`

Local:

```bash
python3 -m http.server 4173
# open http://localhost:4173
```

## What it does

| Tab | Source |
| --- | --- |
| Radar | Highest market-cap coins (complete + incomplete) |
| New | Newest mints by `created_timestamp` |
| Live | Coins flagged `is_currently_live` (livestream), falling back to recent trades |
| Watch | `localStorage` watchlist |
| Majors | Graduated coins (`complete=true`) sorted by market cap |

Each row shows symbol, name, market cap (USD), last-trade age, reply count, and bonding status. Selecting a row opens Solscan + pump.fun links, DexScreener price if available, and a generated intensity score (replies + recency + curve progress — **not** financial advice).

## Data sources

- `https://frontend-api-v3.pump.fun/coins` — list + metadata
- `https://api.dexscreener.com/latest/dex/tokens/{mint}` — pair price / ATH delta when present
- `https://api.dexscreener.com/latest/dex/pairs/solana/So11111111111111111111111111111111111111112` fallbacks for SOL

If the pump.fun API blocks the browser (CORS), the app retries through a public CORS relay, then keeps the last good snapshot.

## Stack

Static HTML / CSS / JS. No build step, no API keys.

## Disclaimer

This is a research UI. Market caps on new Solana mints can be inflated, duplicated, or stale. Never connect a seed phrase to a third-party dashboard.
