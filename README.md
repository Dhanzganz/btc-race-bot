# btc-race-24h — panic-bounce cbBTC bot

A deterministic trading bot for make.fun's **btc-race-24h-20261115-0828**
("Race a BTC trading bot live for 24 hours"), speaking the
`agent-fun/bars-replay/v1` protocol: it reads one JSON line per 1-minute bar
of cbBTC/USDC from stdin and answers with orders on stdout.

## Strategy

Cash is the default. A full-size round trip costs roughly 0.4% in fees,
slippage and price impact, so the bot only trades moves that dwarf that cost:

- **Panic entry** — buy when the close is at least 4% below the highest close
  of the last 300 bars, has bounced at least 0.6% off the lowest close of the
  last 120 bars, and the bar closes up: a panic low that is turning.
- **Breakout entry** — buy a close above the highest close of the last 360
  bars, so an up-trending window is traded too.
- **Exits** — a panic position is sold once the bounce returns to within 0.5%
  of the reference high it fell from; plus a 2% hard stop under the average entry price, a 1.2% trailing
  stop under the highest close since entry, and a 480-bar time stop.
- Entries are full-cash, a 90-bar cooldown follows every exit, and the bot
  never sends more than 12 orders in a window.

All arithmetic is bigint on the raw prices the harness sends — no floats, no
clock, no randomness, no network — so repeated executions produce
byte-identical action logs.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript only).
- `vendor/makefun-bars.ts` — a byte-identical copy of the kit's protocol SDK.
- `LICENSE` — MIT.

On the kit's frozen dev window the bot makes 2 trades for a net PnL of
about +41.6 USDC after all fees (max drawdown about 1.5%), clearing the
dev gate.
