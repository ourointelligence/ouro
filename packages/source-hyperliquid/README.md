# @ourointelligence/source-hyperliquid

OURO `Source` plugin for Hyperliquid public perp candles. No API key, no account.

```ts
import { hyperliquid } from '@ourointelligence/source-hyperliquid';

createLoop({ source: hyperliquid(), assets: ['BTC', 'ETH'], tf: '15m', ... });
```

- **Intervals**: `1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1M`, exactly as Hyperliquid names them. Anything else throws.
- **history({ assets, tf, bars })** posts `candleSnapshot` to `https://api.hyperliquid.xyz/info` per asset and pages backwards (5000 candles per request) until it has `bars` closed candles; the still-forming candle is dropped. Returns every asset's bars sorted by time.
- **subscribe({ assets, tf })** opens `wss://api.hyperliquid.xyz/ws`, subscribes to the `candle` channel per coin, and yields a bar once its candle has closed (when the next candle starts, or when the candle's end time has passed). It pings every 30 s to stay connected and reconnects after 2 s if the socket drops. Calling `return()` on the iterator (what `loop.stop()` does) closes the socket.
- Options: `wsUrl`, `infoUrl`, `pingMs`, `reconnectMs`, and injectable `fetch`, `WebSocket` and `now` for tests.

Bars are `{ ts, asset, tf, o, h, l, c, v }` with `ts` the candle open time in milliseconds and `asset` the coin name (`BTC`, `ETH`).
