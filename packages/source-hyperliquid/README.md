# @ourointelligence/source-hyperliquid

OURO `Source` plugin for Hyperliquid public perp candles. No API key, no account.

```ts
import { hyperliquid, withAssetCtx } from '@ourointelligence/source-hyperliquid';

createLoop({ source: hyperliquid(), assets: ['BTC', 'ETH'], tf: '15m', ... });

// with funding, open interest, premium, mark and oracle on every bar (bar.ext):
createLoop({ source: hyperliquid({ assetCtx: true, rateLimit: { weightPerMinute: 200 } }), ... });
```

## What it does

- **Intervals**: `1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M`, exactly as Hyperliquid names them. Anything else throws.
- **history({ assets, tf, bars })** posts `candleSnapshot` to `https://api.hyperliquid.xyz/info` per asset and pages backwards (5000 candles per request) until it has `bars` closed candles; the still-forming candle is dropped. Returns every asset's bars sorted by time.
- **subscribe({ assets, tf })** opens one WebSocket to `wss://api.hyperliquid.xyz/ws`, subscribes to the `candle` channel per coin, and yields a bar once its candle has closed (when the next candle starts, or when the candle's end time has passed). It pings every 30 s to stay alive. Calling `return()` on the iterator (what `loop.stop()` does) closes the socket.
- **Reconnect with backoff**: after a drop it reconnects after 1 s, then 2 s, 4 s and so on up to 60 s, each delay jittered by plus or minus 20 percent. A socket that stays open for 30 s resets the sequence. The candle that was forming when the socket dropped is thrown away and fetched whole by the gap refill.
- **Gap refill**: the source remembers the last closed bar it handed out per asset. If the next closed candle is not exactly one interval later (a drop, a lost frame, a long pause), it fetches the missing closed candles from `candleSnapshot` and yields them first, in order. A bar is never yielded twice or out of order, and a still-forming candle is never yielded.
- **Stale bars**: a live closed candle that arrives more than two intervals after its end time gets `bar.stale = true` (option `staleAfterIntervals`). Refilled history bars are never stale. The OURO loop records stale bars but does not trade on them.
- **Rate budget**: with `rateLimit: { weightPerMinute }` every info request waits until the budget allows it. Hyperliquid allows 1200 weight per minute per IP; Arena gives each of its three lanes 200. Weights used: `metaAndAssetCtxs` 20; `candleSnapshot` and `fundingHistory` 20 plus 1 per 60 items in the response (charged after the response arrives). An HTTP 429 is retried with the same backoff curve as the socket, five times, then the call throws.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `wsUrl`, `infoUrl` | the public endpoints | Where to connect |
| `pingMs` | 30000 | Keep-alive interval |
| `reconnectMs` | 1000 | First reconnect delay; also the first 429 backoff |
| `maxReconnectMs` | 60000 | Cap on both backoffs |
| `stableMs` | 30000 | How long a socket must stay open to reset the backoff |
| `staleAfterIntervals` | 2 | Late threshold for the stale flag |
| `rateLimit` | none | `{ weightPerMinute }` budget for every info call this instance makes |
| `onEvent` | none | Callback for notices, see below |
| `assetCtx` | false | `true` or `{ fundingHistory?, live? }`: fill `bar.ext`, same as wrapping with `withAssetCtx` |
| `fetch`, `WebSocket`, `now`, `random` | globals | Injected for tests |

## Events

`onEvent` receives plain objects: `{ type: 'open' }`, `{ type: 'close', code }`, `{ type: 'reconnect', attempt, delayMs }`, `{ type: 'gap', asset, from, to, filled }` (open times of the first and last missing bar and how many were fetched), `{ type: 'stale', asset, ts }`, `{ type: 'rateLimit', waitMs, reason: 'budget' | '429' }` and `{ type: 'error', message }` for failures the source recovered from (a refill or context poll that failed).

## stats()

`source.stats()` returns `{ weightUsedLastMinute, requests, reconnects, gapsFilled, lastBarTs, connected }`: the budget weight taken in the last 60 s (0 without a budget), info requests made, reconnect attempts, bars fetched by gap refills, the open time of the last bar yielded per asset, and whether the socket is open right now. The type is `HyperliquidSource`, which is a `Source` plus `stats()`.

## withAssetCtx

`withAssetCtx(hyperliquid(...))`, or `hyperliquid({ assetCtx: true })`, adds market context to `bar.ext`:

| Key | Live bars | History bars | Source |
| --- | --- | --- | --- |
| `funding.rate` | yes | yes | Hourly funding rate as a number, Hyperliquid's convention (positive means longs pay). Live from `metaAndAssetCtxs`, history from `fundingHistory` (each bar gets the latest funding entry at or before the bar's end time; bars before the first entry have no key) |
| `oi` | yes | no | Open interest |
| `oi.change` | yes | no | Open interest minus the value at the previous poll for that asset (0 on the first poll) |
| `premium` | yes | no | Premium of mark over oracle |
| `mark` | yes | no | Mark price |
| `oracle` | yes | no | Oracle price |

Live context is polled once per bar close time: every asset whose bar closes at the same time shares one `metaAndAssetCtxs` request. The poll happens before the bar is handed to the loop, so a strategy deciding on that bar sees the context as of its close. Options: `fundingHistory: false` skips the history backfill, `live: false` skips the live poll.

Bars are `{ ts, asset, tf, o, h, l, c, v, ext?, stale? }` with `ts` the candle open time in milliseconds and `asset` the coin name (`BTC`, `ETH`).
