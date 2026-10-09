#!/usr/bin/env node
// `ouro` executable. Kept separate from cli.ts so the CLI module can also be imported without running.
import { main } from './cli.js';

await main();
