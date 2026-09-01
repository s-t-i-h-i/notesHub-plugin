/**
 * The switch-off / switch-on pair.
 *
 * This is the one mechanism standing between a downloaded package and code
 * running in someone's vault, and it has two properties that both have to hold:
 *
 *   it must catch everything that starts on its own, and
 *   it must be an exact inverse, byte for byte.
 *
 * A miss on the first leaves live code in the vault. A miss on the second
 * corrupts the reader's notes, which is worse than not offering the feature.
 * Neither is visible to `tsc`.
 */
import { disarm, arm, armBlock, disarmedLanguages } from '../src/disarm';
import { selfStartingFences } from '../src/policy/interpreters';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) {
		console.log(`  ok   ${label}`);
	} else {
		console.log(`  FAIL ${label} ${extra}`);
		failures++;
	}
}

const DV = '```dataviewjs\ndv.pages("#x")\n```';
const TILDE = '~~~dataviewjs\ndv.pages("#x")\n~~~';

console.log('\n--- what gets switched off ---');
check('a dataviewjs block is switched off', disarm(DV).includes('```dataviewjs-off'));
check('a tilde fence too, same as backticks', disarm(TILDE).includes('~~~dataviewjs-off'));
check('the code inside is untouched', disarm(DV).includes('dv.pages("#x")'));
check('an iframe source is parked, not deleted', disarm('<iframe src="https://a.example.com"></iframe>').includes('data-off-src="https://a.example.com"'));

console.log('\n--- what is deliberately left alone ---');
// Templater runs when the reader asks for it, not when a note opens, so
// switching it off would be friction with nothing behind it.
check('a Templater fragment is left running', disarm('<% tp.file.title %>') === '<% tp.file.title %>');
// A DQL query cannot execute anything.
const dql = '```dataview\nTABLE file.name\n```';
check('a DQL query is left alone', disarm(dql) === dql);
// It is being shown, not used.
const sample = '````md\n```dataviewjs\ndv.pages()\n```\n````';
check('a block quoted inside a code sample is left alone', disarm(sample) === sample);
const python = "```python\nprint('hi')\n```";
check('an ordinary code sample is left alone', disarm(python) === python);

console.log('\n--- arm touches only what disarm made ---');
// interpreterFor() answers with a synthesized "unrecognised block" for any
// language it does not know, so a looser test here rewrote fences the reader
// wrote themselves.
const mine = '```mynotes-off\nnot ours\n```';
check('a reader\'s own -off fence is left alone', arm(mine) === mine, `-> ${JSON.stringify(arm(mine))}`);
check('an inert language ending in -off is left alone', arm('```python-off\nx\n```') === '```python-off\nx\n```');
check('but our own suffix is still removed', arm(disarm(DV)) === DV);

console.log('\n--- object carries its url in data, not src ---');
const obj = '<object data="https://a.example.com/x"></object>';
check('object data is parked', disarm(obj).includes('data-off-data="https://a.example.com/x"'));
check('object round-trips', arm(disarm(obj)) === obj);
const emb = '<embed src="https://a.example.com/x">';
check('embed src is parked', disarm(emb).includes('data-off-src='));
check('embed round-trips', arm(disarm(emb)) === emb);

console.log('\n--- exact inverse ---');
const notes = [
	DV,
	TILDE,
	`# Course\n\nText.\n\n${DV}\n\nMore text.\n\n<iframe src="https://a.example.com"></iframe>\n`,
	// Four backticks so the admonition can hold a three-backtick block, which
	// is exactly how people write these.
	'````ad-note\ntitle: Setup\n\n```dataviewjs\ndv.pages()\n```\n````\n',
	'no code here at all\n',
];
for (const [index, note] of notes.entries()) {
	check(`round-trip ${index} returns the original byte for byte`, arm(disarm(note)) === note, `-> ${JSON.stringify(arm(disarm(note)))}`);
}

console.log('\n--- nested inside an admonition ---');
const admonition = '````ad-note\ntitle: Setup\n\n```dataviewjs\ndv.pages()\n```\n````\n';
check('a nested block is switched off too', disarm(admonition).includes('```dataviewjs-off'));
check('the admonition itself is not touched', disarm(admonition).startsWith('````ad-note'));

console.log('\n--- one block at a time ---');
const two = `${DV}\n\ntext\n\n${DV}\n`;
const off = disarm(two);
// The reader has read this one block and wants to see what it does. The rest
// of the note has to stay as it was.
const first = armBlock(off, 1);
check('switching on one block leaves the other off', first.split('dataviewjs-off').length === 2, `-> ${JSON.stringify(first)}`);
check('the block switched on is the one asked for', first.startsWith('```dataviewjs\n'));

console.log('\n--- the two lists must be one list ---');
// A language switched off with no renderer registered for it draws a blank
// block with no way back except editing the note. Both sides come off the
// interpreter table now, and this is what keeps them there.
for (const lang of selfStartingFences()) {
	const note = '```' + lang + '\ncode()\n```';
	check(`${lang} is switched off`, disarm(note).includes('```' + lang + '-off'), `-> ${JSON.stringify(disarm(note))}`);
	check(`${lang} has a renderer`, disarmedLanguages().includes(lang + '-off'));
}

console.log('\n--- idempotence ---');
// Installing, then updating, then installing again must not stack suffixes.
check('switching off twice changes nothing the second time', disarm(disarm(DV)) === disarm(DV));
check('switching on twice changes nothing the second time', arm(arm(off)) === arm(off));

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
