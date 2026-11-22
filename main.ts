// The driver the harness runs: node /bot/main.ts (node 22). It reads every case
// from /input/cases.json (or $MAKEFUN_INPUT_DIR), answers each one alone with
// run() from solve.js, and writes /output/answers.json (or $MAKEFUN_OUTPUT_DIR):
// a JSON array of the answers, one per case and in the cases' order.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the house baseline runs with the same flag).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** One case answered alone with run(). */
const answer = (c: { id: string; input: unknown }) => run(c.input);

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(cases.map(answer)));
