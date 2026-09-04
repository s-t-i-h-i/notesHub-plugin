/**
 * Keeps the shared checks identical in both repos.
 *
 * The worker refuses an archive and the plugin warns about one before it is
 * uploaded; both have to mean the same thing by "runs by itself". Two
 * checkouts, no monorepo, so the files are copied and this is what stops them
 * drifting.
 *
 * Two checks, because they catch different mistakes:
 *
 *   hashes.json  — committed, so it works on every machine and in CI. Catches
 *                  the common accident: editing the plugin's copy of a shared
 *                  file and forgetting the other side entirely.
 *   the backend  — when it is checked out, a real byte comparison. Catches the
 *                  other direction too, but only where both repos exist.
 *
 * The default backend path used to be one contributor's absolute path, which
 * meant that on every other machine the whole guard skipped silently and drift
 * merged unnoticed. Now the local hash check always runs; the cross-repo
 * comparison is the part that is optional.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BACKEND = process.env.MARKETPLACE_BACKEND ?? '';
const HASHES = 'scripts/policy-hashes.json';

const SHARED = [
	'src/tar.ts',
	'src/verify.ts',
	'src/nocode.ts',
];

const mode = process.argv[2] === 'sync' ? 'sync' : 'check';
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (mode === 'sync') {
	if (!BACKEND || !existsSync(BACKEND)) {
		console.error('sync-policy: set MARKETPLACE_BACKEND to the backend checkout to sync from it.');
		process.exit(1);
	}

	for (const file of SHARED) {
		const theirs = `${BACKEND}/${file}`;
		if (!existsSync(theirs)) {
			console.error(`sync-policy: missing in backend: ${file}`);
			process.exit(1);
		}
		if (!existsSync(file) || hash(file) !== hash(theirs)) {
			writeFileSync(file, readFileSync(theirs));
			console.log(`sync-policy: updated ${file}`);
		}
	}

	writeFileSync(HASHES, `${JSON.stringify(Object.fromEntries(SHARED.map((file) => [file, hash(file)])), null, 1)}\n`);
	console.log(`sync-policy: ${SHARED.length} shared files synced, hashes recorded.`);
	process.exit(0);
}

// --- check ---

const recorded = existsSync(HASHES) ? JSON.parse(readFileSync(HASHES, 'utf8')) : {};
const drifted = [];

for (const file of SHARED) {
	if (!existsSync(file)) {
		console.error(`sync-policy: missing shared file: ${file}`);
		process.exit(1);
	}
	if (recorded[file] !== hash(file)) drifted.push(`${file} (differs from the recorded hash)`);
}

if (BACKEND && existsSync(BACKEND)) {
	for (const file of SHARED) {
		const theirs = `${BACKEND}/${file}`;
		if (!existsSync(theirs)) drifted.push(`${file} (missing in the backend)`);
		else if (hash(theirs) !== hash(file)) drifted.push(`${file} (differs from the backend)`);
	}
} else {
	console.log('sync-policy: MARKETPLACE_BACKEND not set, so the cross-repo comparison was skipped.');
}

if (drifted.length > 0) {
	console.error('sync-policy: shared files have drifted, so the two sides would describe a package differently:');
	for (const entry of new Set(drifted)) console.error(`  ${entry}`);
	console.error('Run: MARKETPLACE_BACKEND=<path> npm run sync-policy');
	process.exit(1);
}

console.log(`sync-policy: ${SHARED.length} shared files match.`);
