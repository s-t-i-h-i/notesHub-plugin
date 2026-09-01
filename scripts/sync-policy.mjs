/**
 * Keeps the shared analysis identical in both repos.
 *
 * The worker and the plugin run the same code on the same bytes, and the whole
 * point of the manifest is that the two agree. Two checkouts, no monorepo, so
 * the files are copied and this script is what stops them drifting: `check`
 * fails when they differ, `sync` copies the backend's version over.
 *
 * The backend is the source. Its copy is the one that decides what gets
 * published, so the plugin follows it rather than the other way round.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BACKEND =
	process.env.MARKETPLACE_BACKEND ?? '/Users/adrian/Documents/projects/obsidian-marketplace/obsidian-marketplace-backend';

/**
 * Only what BOTH sides genuinely run.
 *
 * policy/js.ts and policy/index.ts are the backend's alone. The plugin used to
 * carry them to recompute a manifest the server had already computed on the
 * same bytes with the same code — an answer identical by construction, for
 * 118 kB of parser. Every file that stops being shared is one less place the
 * two sides can disagree.
 */
const SHARED = ['src/tar.ts', 'src/verify.ts', 'src/policy/types.ts', 'src/policy/lex.ts', 'src/policy/html.ts', 'src/policy/interpreters.ts'];

const mode = process.argv[2] === 'sync' ? 'sync' : 'check';
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (!existsSync(BACKEND)) {
	// A developer machine check, not a CI gate: without the backend checked
	// out there is nothing to compare against, and saying so is more use than
	// failing.
	console.log(`sync-policy: backend not found at ${BACKEND}, skipping. Set MARKETPLACE_BACKEND to point at it.`);
	process.exit(0);
}

const drifted = [];
for (const file of SHARED) {
	const theirs = `${BACKEND}/${file}`;
	if (!existsSync(theirs)) {
		console.error(`sync-policy: missing in backend: ${file}`);
		process.exit(1);
	}

	if (existsSync(file) && hash(file) === hash(theirs)) continue;

	if (mode === 'sync') {
		writeFileSync(file, readFileSync(theirs));
		console.log(`sync-policy: updated ${file}`);
	} else {
		drifted.push(file);
	}
}

if (drifted.length > 0) {
	console.error('sync-policy: these differ from the backend, so the two sides would describe a package differently:');
	for (const file of drifted) console.error(`  ${file}`);
	console.error('Run: npm run sync-policy');
	process.exit(1);
}

console.log(`sync-policy: ${SHARED.length} shared files match the backend.`);
