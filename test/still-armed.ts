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
		])
	).buffer as ArrayBuffer;

	const findings: Finding[] = [
		finding('fenced.md', ['js', 'vault-read'], 'render'),
		finding('inline.md', ['js'], 'render'),
		finding('board.canvas', ['js'], 'render'),
		finding('opaque.md', ['js'], 'render'),
		finding('beacon.md', ['network-passive'], 'render'),
	];

	console.log('\n--- what the plugin actually managed to switch off ---');
	const plan = await inspectArchive(archive, findings);

	check('a fenced block counts as switched off', !plan.stillArmed.includes('fenced.md'));
	check('an inline query counts as switched off', !plan.stillArmed.includes('inline.md'));
	check('a canvas counts as switched off', !plan.stillArmed.includes('board.canvas'));
	check('a remote image is not reported — it is left running on purpose', !plan.stillArmed.includes('beacon.md'));
	check('a flagged file we could not touch IS reported', plan.stillArmed.includes('opaque.md'));
	check('and nothing else is', plan.stillArmed.length === 1, `-> ${JSON.stringify(plan.stillArmed)}`);

	console.log('\n--- without a manifest ---');
	// A package from a server that never described it (policy_version 0). The
	// screen says so separately; this must not invent a warning of its own.
	const bare = await inspectArchive(archive);
	check('nothing is claimed when there is nothing to check against', bare.stillArmed.length === 0);
	check('the rest of the plan is unaffected', bare.paths.length === 5);

	console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
	process.exit(failures ? 1 : 0);
}

void run();
