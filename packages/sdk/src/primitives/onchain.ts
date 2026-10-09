import type { PrimitivePack } from '../plugins.js';

const KEYS = [
  { key: 'fundingRate', doc: 'Current perp funding rate (fraction per period). Null until an on-chain source is attached.' },
  { key: 'openInterest', doc: 'Open interest in base units. Null until an on-chain source is attached.' },
  { key: 'netflow', doc: 'Net exchange inflow over the bar in base units. Null until an on-chain source is attached.' },
  { key: 'liquidations', doc: 'Liquidated notional over the bar. Null until an on-chain source is attached.' },
];

/** On-chain pack. Interface only: every key is null until a Source provides on-chain data. */
export const onchain: PrimitivePack = {
  name: 'onchain',
  compute() {
    return Object.fromEntries(KEYS.map((k) => [k.key, null]));
  },
  describe() {
    return KEYS;
  },
};
