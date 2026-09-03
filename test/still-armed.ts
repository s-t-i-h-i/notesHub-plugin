/**
 * The install screen's claim, checked against an independent witness.
 *
 * "Anything that would run on its own is installed switched off" used to be
 * printed whenever the manifest held a render-triggered finding — asserted, not
 * verified. So every construct disarm() did not know about shipped live under a
 * reassuring sentence: a canvas, and before that a fence language it skipped.
 *
 * The manifest is the witness because it is not the code being checked: the
 * server computed it from the same bytes, with the analysis half of the shared
 * policy files. Where the two disagree, the reader is told.
 */
import { inspectArchive } from '../src/installs';
import { writeTarGz } from '../src/tar';
import type { Finding } from '../src/policy/types';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) { console.log(`  ok   ${label}`); }
	else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

const encoder = new TextEncoder();

const finding = (path: string, capabilities: Finding['capabilities'], trigger: Finding['trigger']): Finding => ({
	path,
	line: 1,
	capabilities,
	trigger,
	interpreter: 'Dataview',
	hosts: [],
	hidden: false,
	sample: '',
});

async function run() {
	const archive = (
		await writeTarGz([
			{ name: 'fenced.md', data: encoder.encode('```dataviewjs\ndv.pages()\n```\n') },
			{ name: 'inline.md', data: encoder.encode('Count: `$= dv.pages().length`\n') },
			{
				name: 'board.canvas',
				data: encoder.encode(JSON.stringify({ nodes: [{ id: 'a', type: 'text', text: '```dataviewjs\ndv.pages()\n```' }] })),
			},
			// Nothing disarm() can act on, but the manifest calls it self-starting.
			// This is the shape that used to ship silently.
			{ name: 'opaque.md', data: encoder.encode('# Just a heading\n') },
			// Render-triggered, but deliberately never switched off — counting it
			// would make the warning fire on every package with a remote image.
			{ name: 'beacon.md', data: encoder.encode('![](https://tracker.example.com/p.png)\n') },
			// One construct we can switch off, one we cannot, in the same file.
			// The whole-file test used to let the first vouch for the second.
			{ name: 'mixed.md', data: encoder.encode('```dataviewjs\ndv.pages()\n```\n\n```jsx:\nevil()\n```\n') },
			// Same shape in a canvas: a link card is not Markdown and has no
			// token to break, so nothing here can switch it off.
			{
				name: 'linked.canvas',
				data: encoder.encode(
					JSON.stringify({
						nodes: [
							{ id: 'a', type: 'text', text: '```dataviewjs\ndv.pages()\n```' },
							{ id: 'b', type: 'link', url: 'https://tracker.example.com/' },
						],
					}),
				),
			},
		])
	).buffer as ArrayBuffer;

	const findings: Finding[] = [
		finding('fenced.md', ['js', 'vault-read'], 'render'),
		finding('inline.md', ['js'], 'render'),
		finding('board.canvas', ['js'], 'render'),
		finding('opaque.md', ['js'], 'render'),
		finding('beacon.md', ['network-passive'], 'render'),
		// The manifest numbers each fragment by its line; the jsx: fence is the
		// one on line 5 that disarm() cannot rename.
		{ ...finding('mixed.md', ['js'], 'render'), line: 1 },
		{ ...finding('mixed.md', ['js'], 'render'), line: 5 },
		{ ...finding('linked.canvas', ['js'], 'render'), line: 1 },
		{ ...finding('linked.canvas', ['remote-embed'], 'render'), line: 1 },
	];

	console.log('\n--- what the plugin actually managed to switch off ---');
	const plan = await inspectArchive(archive, findings);

	check('a fenced block counts as switched off', !plan.stillArmed.includes('fenced.md'));
	check('an inline query counts as switched off', !plan.stillArmed.includes('inline.md'));
	check('a canvas counts as switched off', !plan.stillArmed.includes('board.canvas'));
	check('a remote image is not reported — it is left running on purpose', !plan.stillArmed.includes('beacon.md'));
	check('a flagged file we could not touch IS reported', plan.stillArmed.includes('opaque.md'));
	// The point of the per-fragment check: one construct we handled must not
	// vouch for one we did not, just because they share a file.
	check('a fence we cannot rename is reported even beside one we can', plan.stillArmed.includes('mixed.md'));
	check('a canvas link card is reported even beside a node we switched off', plan.stillArmed.includes('linked.canvas'));
	check('and nothing else is', plan.stillArmed.length === 3, `-> ${JSON.stringify(plan.stillArmed)}`);

	console.log('\n--- without a manifest ---');
	// A package from a server that never described it (policy_version 0). The
	// screen says so separately; this must not invent a warning of its own.
	const bare = await inspectArchive(archive);
	check('nothing is claimed when there is nothing to check against', bare.stillArmed.length === 0);
	check('the rest of the plan is unaffected', bare.paths.length === 7);

	console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
	process.exit(failures ? 1 : 0);
}

void run();
