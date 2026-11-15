// BTC panic-bounce bot for agent-fun/bars-replay/v1 (make.fun btc-race-24h).
//
// Strategy, in one paragraph: stay in cash almost all of the time. A full-size
// round trip costs roughly 0.4% in fees, slippage and price impact, so the bot
// only trades moves that dwarf that cost. It buys cbBTC in size when the price
// has fallen at least 4% below its highest close of the last 300 bars, the fall
// has started to stabilise (the close has bounced at least 0.6% off the lowest
// close of the last 120 bars) and the current bar closes up: a panic low that
// is turning, not a knife still falling. It also buys a genuine trend
// breakout, a close above the highest close of the last 360 bars, so an
// up-trending window is traded too. A panic position is sold when the bounce
// has carried the price back to within 0.5% of the reference high it fell
// from (the panic thesis is then complete), and every position is protected
// the same way: a 2% stop under the average entry price, a 1.2% trailing
// stop under the highest close since entry, and a 480-bar time stop. At
// most 12 orders are ever sent, entries are full-cash, and a 90-bar
// cooldown follows every exit.
//
// Everything is bigint arithmetic on the raw bar prices the harness sends:
// no floats, no clock, no randomness, no environment reads, so the two graded
// executions produce byte-identical action logs.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- parameters (bars are 1 minute; price moves in basis points) ---
const REF_BARS = 300; // a panic is measured against the highest close of the last 300 bars
const DROP_BPS = 400n; // ... at least 4% below that high
const LOW_BARS = 120; // the bounce is measured off the lowest close of the last 120 bars
const BOUNCE_BPS = 60n; // ... at least 0.6% above that low
const BREAKOUT_BARS = 360; // a trend entry needs a close above the last 360 bars' highest close
const RECOVERY_BPS = 50n; // a panic position exits within 0.5% of the reference high it fell from
const STOP_BPS = 200n; // hard stop: 2% under the average entry price
const TRAIL_BPS = 120n; // trailing stop: 1.2% under the highest close since entry
const TIME_STOP_BARS = 480; // never hold longer than 480 bars
const COOLDOWN_BARS = 90; // bars to wait after an exit before entering again
const MAX_ORDERS = 12; // self-imposed cap, under the protocol's limits
const ORDER_SLIPPAGE_BPS = 500; // a fill further than this from the last close rejects instead

// --- strategy state, set up in onHello ---
let symbol = '';
let qtyScale = 0;
let priceScale = 0;
let quoteScale = 0;
let minNotional = 0n;
const closes: bigint[] = []; // every close seen for the symbol, in order
let ordersSent = 0;
let inPosition = false;
let entrySeq = -1;
let entryPrice = 0n; // average fill price (fees in), raw price units
let peakClose = 0n; // highest close since the entry filled
let entryLeg = ''; // 'panic' or 'breakout', whichever entry filled
let entryRefHigh = 0n; // for a panic entry: the reference high it fell from
let pendingLeg = ''; // the leg of the buy most recently sent, awaiting its fill
let pendingRefHigh = 0n;
let lastExitSeq = -1_000_000_000;

function maxOf(xs: bigint[]): bigint {
  let m = xs[0];
  for (const x of xs) if (x > m) m = x;
  return m;
}

function minOf(xs: bigint[]): bigint {
  let m = xs[0];
  for (const x of xs) if (x < m) m = x;
  return m;
}

function averagePrice(qty: bigint, cost: bigint): bigint {
  // The position's average price in raw price units, from its recorded cost.
  return (cost * 10n ** BigInt(qtyScale + priceScale)) / (qty * 10n ** BigInt(quoteScale));
}

function sellAll(qty: bigint): SellInput[] {
  ordersSent += 1;
  return [{ side: 'sell', symbol, qty, max_slippage_bps: ORDER_SLIPPAGE_BPS }];
}

await runBars({
  onHello(state: BarsState) {
    const hello = state.hello;
    symbol = hello.symbols[0].symbol;
    const info = state.symbols.get(symbol)!;
    qtyScale = info.qty_scale;
    priceScale = info.price_scale;
    quoteScale = hello.capital.quote_scale;
    minNotional = BigInt(hello.fees.min_notional_quote_units);
  },

  onBatch(state: BarsState, batch: Batch) {
    // Record this batch's bar for the symbol, if it carries one (a minute can have no bar).
    for (const bar of batch.bars) {
      if (bar.symbol === symbol) closes.push(BigInt(bar.c));
    }
    if (closes.length === 0) return [];
    const close = closes[closes.length - 1];
    const holding = state.positions.get(symbol);

    // Track position transitions so exits, peaks and cooldowns are measured
    // from the batch whose account first shows the fill, as the harness does.
    if (holding !== undefined && !inPosition) {
      inPosition = true;
      entrySeq = state.seq;
      entryPrice = averagePrice(holding.qty, holding.cost);
      peakClose = close;
      entryLeg = pendingLeg;
      entryRefHigh = pendingRefHigh;
    } else if (holding === undefined && inPosition) {
      inPosition = false;
      lastExitSeq = state.seq;
    }
    if (holding !== undefined && close > peakClose) peakClose = close;

    if (state.warmingUp || ordersSent >= MAX_ORDERS) return [];

    if (holding !== undefined) {
      // --- exits: hard stop, panic-recovery exit, trailing stop, time stop ---
      if (close * 10_000n < entryPrice * (10_000n - STOP_BPS)) return sellAll(holding.qty);
      if (entryLeg === 'panic' && entryRefHigh > 0n && close * 10_000n >= entryRefHigh * (10_000n - RECOVERY_BPS)) return sellAll(holding.qty);
      if (close * 10_000n < peakClose * (10_000n - TRAIL_BPS)) return sellAll(holding.qty);
      if (state.seq - entrySeq >= TIME_STOP_BARS) return sellAll(holding.qty);
      return [];
    }

    // --- entries (flat, cooled down, enough history) ---
    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    let panic = false;
    let refHigh = 0n;
    if (closes.length > REF_BARS) {
      refHigh = maxOf(closes.slice(closes.length - 1 - REF_BARS, closes.length - 1));
      const recentLow = minOf(closes.slice(closes.length - 1 - LOW_BARS, closes.length - 1));
      panic =
        close * 10_000n <= refHigh * (10_000n - DROP_BPS) &&
        close > closes[closes.length - 2] &&
        close * 10_000n >= recentLow * (10_000n + BOUNCE_BPS);
    }
    let breakout = false;
    if (closes.length > BREAKOUT_BARS) {
      breakout = close >= maxOf(closes.slice(closes.length - 1 - BREAKOUT_BARS, closes.length - 1));
    }
    if (!panic && !breakout) return [];
    let notional = state.cash;
    const room = state.weightRoom(symbol);
    if (room < notional) notional = room;
    if (notional < minNotional) return [];
    ordersSent += 1;
    pendingLeg = panic ? 'panic' : 'breakout';
    pendingRefHigh = panic ? refHigh : 0n;
    const order: BuyInput = { side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: ORDER_SLIPPAGE_BPS };
    return [order];
  },
});
