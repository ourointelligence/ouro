# Sample takeoff.json

`takeoff.json` here is a sample of the file `npx ouro run --paper` writes after every cycle, so the format can be seen without running anything. Running the example overwrites it.

It was produced by running this example on real Hyperliquid 15m candles for BTC and ETH (300 warm-up bars, 4000 bars traded through on paper, population 8, `cycleEvery: 40`, holdout 0.3, margin 0.05) with a scripted stand-in answering the Generator and Critic prompts instead of a language model. It shows the pipeline and the file shape, not what a model produces.

Everything else in `.ouro/` (`episodes.db`, `history.json`, `population/`) is runtime state and is not committed.
