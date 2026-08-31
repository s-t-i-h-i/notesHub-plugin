/**
 * Runs the headless checks against the stub in obsidian-stub.js.
 *
 * `tsc` cannot see any of the failures these catch: a component referenced
 * inside its own Setting chain (temporal dead zone, which takes the whole tab
 * down at runtime), a button that quietly stopped being rendered, or an
 * update that overwrites the user's edits instead of trashing them first.
 * Bundling happens through esbuild's API rather than a shell one-liner so the
 * __API_BASE_URL__ define doesn't have to survive shell quoting.
 */
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entryPoints = ['test/settings-render.ts', 'test/update-plan.ts'];
let failed = false;

for (const entryPoint of entryPoints) {
	const name = entryPoint.split('/').pop().replace(/\.ts$/, '');
	const outfile = join(tmpdir(), `notes-hub-uitest-${name}-${process.pid}.mjs`);

	await esbuild.build({
		entryPoints: [entryPoint],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
		alias: { obsidian: './test/obsidian-stub.js' },
		define: { __API_BASE_URL__: JSON.stringify('http://127.0.0.1:8787') },
	});

	console.log(`\n===== ${name} =====`);
	// A child process per check, not an import: each one ends with
	// process.exit(), which would take the runner down with it.
	const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
	if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
