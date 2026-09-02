/**
 * The live end-to-end check: publish -> catalog -> manifest -> download ->
 * install -> update -> delete, against a running `wrangler dev`.
 *
 * Kept OUT of `npm run uitest` on purpose — that has to pass with no server and
 * no token. This one needs both, and it publishes for real, so e2e-live.ts
 * refuses to run against anything but a local worker.
 */
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outfile = join(tmpdir(), `notes-hub-e2e-${process.pid}.mjs`);
const api = process.env.MARKETPLACE_API_URL ?? 'http://127.0.0.1:8787';

await esbuild.build({
	entryPoints: ['test/e2e-live.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
	alias: { obsidian: './test/obsidian-stub.js' },
	define: { __API_BASE_URL__: JSON.stringify(api) },
});

process.exit(spawnSync(process.execPath, [outfile], { stdio: 'inherit' }).status ?? 1);
