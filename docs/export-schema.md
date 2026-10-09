# Export schema

`npx ouro export` writes `ouro.json`, and `loop.export()` returns the same object. Both carry `schemaVersion` so readers can tell what shape they are looking at, and both are in canonical form: object keys sorted at every level, arrays in their natural order, no `undefined` values. Two exports of the same state are byte-equal when serialised with `JSON.stringify`, which is what hash chains and ledgers rely on.

## schemaVersion 1

```json
{
  "schemaVersion": 1,
  "name": "OURO",
  "goal": "Maximise realised PnL after fees on BTC and ETH 15m perps, max drawdown 8%",
  "createdAt": 1760000000000,
  "cycle": 12,
  "population": [Strategy],
  "history": { "strategies": [Strategy], "cycles": [CycleResult] },
  "takeoff": [{ "cycle": 1, "populationCI": 0.1, "bestCI": 0.3, "velocity": 0.1 }]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | This document's version. A reader that sees a higher number should stop. |
| `name` | string | Always `OURO`. |
| `goal` | string | The goal the loop was created with. |
| `createdAt` | number | Unix milliseconds when the state directory was first written. |
| `cycle` | number | Number of the last completed cycle (0 after seeding). |
| `population` | Strategy[] | The live set, in id order. |
| `history.strategies` | Strategy[] | Every strategy ever generated, including rejected ones. |
| `history.cycles` | CycleResult[] | One record per completed cycle, including `error` cycles and rollback markers. |
| `takeoff` | TakeoffRow[] | Population CI, best CI and velocity per cycle. |

### Strategy

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `s-0001`, `s-0002`, ... per state directory. |
| `parentIds` | string[] | Empty for seeds and user strategies. |
| `origin` | `seed`, `mutate`, `crossbreed`, `fresh`, `user` | |
| `cycleBorn` | number | 0 for the first generation. |
| `code` | string | The TypeScript module. |
| `params` | Record<string, number> | The parameters it runs with. |
| `bounds` | Record<string, { min, max, step }> | Declared by the module. Optional for rejected proposals that never compiled. |
| `describe` | string | One sentence declared by the module. Optional, as above. |
| `rationale` | string | The Generator's reason for writing it. |
| `status` | `live`, `retired`, `rejected`, `rolled_back`, `pending` | |
| `trial` | object | `trainScore`, `holdoutScore`, `trainN`, `holdoutN`, `maxDrawdown`, and `ownHoldoutScore` / `ownHoldoutN` once the strategy has traded on its own. Optional. |
| `ci` | number | Capability Index against the seed generation. Optional until the strategy has own holdout episodes. |
| `cycleRetired` | number | Optional. |
| `retireReason` | string | `replaced`, `inactive`, `rolled_back` or `compile`. Optional. |

### CycleResult

| Field | Type | Notes |
| --- | --- | --- |
| `cycle` | number | |
| `status` | `promoted`, `no_change`, `pending`, `error` | `error` means the model could not be reached (note `llm_error`); the population did not change. |
| `promoted`, `retired` | Strategy[] | Records as they were at the end of the cycle. |
| `rejected` | `{ strategy, reason }[]` | Reasons: `sandbox: ...`, `bounds: ...`, `freeze: ...`, `allow: ...`, `unknown feature: ...`, `drawdown: ...`, `size: ...`, `train margin`, `no slot`, `holdout`, `rejected by user`. |
| `diagnosis` | `{ patterns, summary, weakIds, strongIds }` | The Critic's output. |
| `populationCI`, `bestCI` | number | At the end of the cycle. |
| `baselineHoldout` | number | The seed generation's baseline, once stored. Optional. |
| `note` | string | `not enough data`, `no candidate survived`, `no proposals`, `rejected by user`, `rollback:<n>`, `llm_error`. Optional. |
| `ts`, `startedAt` | number | Wall-clock end and start. |
| `usage` | `{ inputTokens, outputTokens, calls, usd? }` | Model usage for the cycle; `usd` only with `llmPricing`. Optional. |

### TakeoffRow

`{ cycle, populationCI, bestCI, velocity }`, one per cycle in order.

## Verifying a hash

Serialise with `JSON.stringify` after `canonical()` (exported by the SDK), or equivalently sort keys at every level and strip whitespace, then take SHA-256 of the UTF-8 bytes. The SDK's `canonicalJson(value)` does exactly this.
