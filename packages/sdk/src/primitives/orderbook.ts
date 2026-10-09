import type { PrimitivePack } from '../plugins.js';

const KEYS = [
  { key: 'spreadBps', doc: 'Best ask minus best bid in basis points of mid. Null until an order book source is attached.' },
  { key: 'bidDepth', doc: 'Resting bid size within 10 bps of mid. Null until an order book source is attached.' },
  { key: 'askDepth', doc: 'Resting ask size within 10 bps of mid. Null until an order book source is attached.' },
  { key: 'imbalance', doc: '(bidDepth - askDepth) / (bidDepth + askDepth), -1..1. Null until an order book source is attached.' },
];

/**
 * Order book pack. Interface only: every key is null until a Source provides book snapshots.
 * Shipping the keys lets strategies be written against them today and start working when data arrives.
 */
export const orderbook: PrimitivePack = {
  name: 'orderbook',
  compute() {
    return Object.fromEntries(KEYS.map((k) => [k.key, null]));
  },
  describe() {
    return KEYS;
  },
};
