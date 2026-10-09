# examples/support-bot

Proof that OURO is not trading-specific. The same loop, guards, Critic, Generator and takeoff curve run over a synthetic support-ticket stream:

- each "bar" is one ticket (its length, sentiment, category, urgency and prior contacts ride in the bar fields);
- a `text` primitive pack exposes those as `text.length`, `text.sentiment`, `text.category`, `text.urgency`, `text.priorContacts`;
- a decision of `long` means resolve the ticket yourself, `short` means escalate to a human, `null` means skip;
- the executor scores each choice against a hidden difficulty the strategies must discover: a resolved easy ticket pays +1, a bounced hard one -1, escalating a hard ticket +0.4, escalating an easy one -0.3;
- the scorer rewards resolved-without-escalation minus turns taken: `pnl - 0.1 * holdBars`.

```bash
pnpm install && pnpm build          # from the repository root
cd examples/support-bot
export OURO_LLM=anthropic && export ANTHROPIC_API_KEY=sk-...
npx ouro run --paper --quiet
npx ouro population
npx ouro takeoff
```

The whole example is `ouro.config.ts`, under 150 lines. It backfills 600 tickets, cycles every 30 episodes per strategy, and then keeps trickling a new ticket every half second.
