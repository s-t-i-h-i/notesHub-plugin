/**
 * Renders the settings tab headlessly against the stub in obsidian-stub.js.
 *
 * `tsc` cannot see either failure this catches: a component referenced inside
 * its own Setting chain (temporal dead zone, which takes the whole tab down at
 * runtime), and a button that quietly stopped being rendered. Bundling happens
 * through esbuild's API rather than a shell one-liner so the __API_BASE_URL__
 * define doesn't have to survive shell quoting.
 */
import esbuild from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outfile = join(tmpdir(), `notes-hub-uitest-${process.pid}.mjs`);

await esbuild.build({
	entryPoints: ['test/settings-render.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile,
	alias: { obsidian: './test/obsidian-stub.js' },
	define: { __API_BASE_URL__: JSON.stringify('http://127.0.0.1:8787') },
});

await import(pathToFileURL(outfile).href);
