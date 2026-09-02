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
import { disarm, arm, armBlock, armCanvas, armCanvasBlock, disarmCanvas, disarmedLanguages } from '../src/disarm';
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
	const registered = disarmedLanguages().includes(lang + '-off');
	check(
		`${lang} is switched off exactly when it has a renderer`,
		disarm(note).includes('```' + lang + '-off') === registered,
		`-> ${JSON.stringify(disarm(note))}`,
	);
}
check('dataviewjs is one of them', disarmedLanguages().includes('dataviewjs-off'));

console.log('\n--- every registered language survives being a CSS class ---');
// Obsidian registers a renderer by building the selector `code.language-<lang>`
// and running it over every note it renders. One name that is not a valid class
// throws inside every reading-view render in the vault, in notes that have
// nothing to do with any package. `jsx:` did exactly that in 0.2.0.
for (const lang of disarmedLanguages()) {
	check(`code.language-${lang} is a valid selector`, /^[a-zA-Z0-9_-]+$/.test(lang));
}
check('jsx: is not registered', !disarmedLanguages().some((lang) => lang.includes(':')));
check('a jsx: block is left alone rather than switched off into a dead end', disarm('```jsx:\nx\n```') === '```jsx:\nx\n```');

console.log('\n--- inline Dataview queries ---');
// Dataview runs `$= ...` on render with the same reach as a ```dataviewjs
// block. The lexer used to blank every code span as "shown, never run", which
// is true of Markdown and false here, so this was live code nobody described.
const INLINE = 'Total: `$= app.vault.adapter.write("x","y")` today.';
check('an inline JS query is switched off', disarm(INLINE).includes('`off:$= app.vault'), `-> ${JSON.stringify(disarm(INLINE))}`);
check('the query text is untouched', disarm(INLINE).includes('app.vault.adapter.write("x","y")'));
check('it round-trips byte for byte', arm(disarm(INLINE)) === INLINE, `-> ${JSON.stringify(arm(disarm(INLINE)))}`);
check('leading space inside the span is handled', arm(disarm('`  $= dv.pages()`')) === '`  $= dv.pages()`');
check('a double-backtick span too', disarm('``$= dv.pages()``').includes('``off:$= dv.pages()``'));

// This is the predicate lifted from Dataview's own reading-view processor:
//   let text = codeblock.innerText.trim();
//   if (text.startsWith(settings.inlineJsQueryPrefix)) ...run it...
const dataviewWouldRun = (span: string) => span.replace(/^`+|`+$/g, '').trim().startsWith('$=');
check('Dataview matches the armed span', dataviewWouldRun('`$= dv.pages()`'));
check('Dataview does NOT match the disarmed one', !dataviewWouldRun(disarm('`$= dv.pages()`')));

// A DQL query executes nothing — same call as the ```dataview fence.
check('an inline DQL query is left running', disarm('`= this.file.name`') === '`= this.file.name`');
// `off:` alone is a phrase someone may write; only `off:$=` is our marker.
check("a reader's own `off: true` is left alone", arm('`off: true`') === '`off: true`');
check('an ordinary code span is left alone', disarm('use `npm run dev` here') === 'use `npm run dev` here');
check('a bare `=` is punctuation, not a query', disarm('a `=` b') === 'a `=` b');
check('switching off twice changes nothing', disarm(disarm(INLINE)) === disarm(INLINE));

console.log('\n--- Templater ---');
// Measured in Obsidian with Templater 2.25: a DYNAMIC command is run by a
// markdown post-processor the moment the note is opened — in prose, in a code
// span and inside a fenced block alike. A plain command still waits for the
// reader, so it stays as it is.
const DYN = 'Now: <%+ tp.user.run() %>';
check('a dynamic command is switched off', disarm(DYN) === 'Now: <%off:+ tp.user.run() %>', `-> ${JSON.stringify(disarm(DYN))}`);
check('it round-trips byte for byte', arm(disarm(DYN)) === DYN);
check('a plain command is left running', disarm('<% tp.file.title %>') === '<% tp.file.title %>');
check('an execution command is left running', disarm('<%* await tp.file.move("/x") %>') === '<%* await tp.file.move("/x") %>');
check('modifiers before the + are handled', arm(disarm('<%-* + x %>')) === '<%-* + x %>');
check('a dynamic command inside a fence is switched off too', disarm('```text\n<%+ evil() %>\n```').includes('<%off:+'), '-- structure hides nothing from Templater');
check('a dynamic command inside a code span too', disarm('`<%+ evil() %>`').includes('<%off:+'));
check('switching off twice changes nothing', disarm(disarm(DYN)) === disarm(DYN));

// This is Templater's own dynamic pattern, lifted from its bundle.
const templaterWouldRun = (text: string) => /(<%(?:-|_)?\s*[*~]{0,1})\+((?:.|\s)*?%>)/g.test(text);
check('Templater matches the armed command', templaterWouldRun(DYN));
check('Templater does NOT match the disarmed one', !templaterWouldRun(disarm(DYN)));

console.log('\n--- canvas ---');
// A canvas is JSON whose text nodes render exactly like a note, so a block in
// one runs on opening it. Plain disarm() sees nothing: inside the JSON the
// fence is a string with escaped newlines.
const canvas = JSON.stringify({
	nodes: [
		{ id: 'a', type: 'text', text: '```dataviewjs\ndv.pages()\n```' },
		{ id: 'b', type: 'file', file: 'note.md' },
	],
	edges: [],
});
check('plain disarm() cannot see into a canvas', disarm(canvas) === canvas);
check('disarmCanvas() switches the node off', disarmCanvas(canvas).includes('dataviewjs-off'));
check('a canvas round-trips', armCanvas(disarmCanvas(canvas)) === canvas, `-> ${JSON.stringify(armCanvas(disarmCanvas(canvas)))}`);
check('an inline query inside a canvas node too', disarmCanvas(JSON.stringify({ nodes: [{ type: 'text', text: '`$= dv.pages()`' }] })).includes('off:$='));
// Re-serialising a canvas with nothing to switch off would rewrite the
// author's formatting, and the next update would read it as the reader's edit.
const plainCanvas = '{\n  "nodes": [\n    { "type": "text", "text": "just notes" }\n  ]\n}';
check('a canvas with nothing to switch off is byte-identical', disarmCanvas(plainCanvas) === plainCanvas);
check('a canvas that is not JSON is returned unchanged', disarmCanvas('not json at all') === 'not json at all');
check('a canvas with no nodes array is returned unchanged', disarmCanvas('{"x":1}') === '{"x":1}');

// One block at a time inside a canvas: getSectionInfo() answers null there, so
// the panel identifies its block by its own code. Without this the reader has
// no way back except hand-editing JSON — the dead end this whole design avoids.
const twoNodes = JSON.stringify({
	nodes: [
		{ id: 'a', type: 'text', text: '```dataviewjs\nFIRST\n```' },
		{ id: 'b', type: 'text', text: '```dataviewjs\nSECOND\n```\n\nAlso: `$= dv.pages()`' },
	],
});
const twoOff = disarmCanvas(twoNodes);
const oneOn = armCanvasBlock(twoOff, 'SECOND\n');
check('the block asked for is switched on', oneOn.includes('```dataviewjs\\nSECOND'), `-> ${oneOn}`);
check('the other node stays off', oneOn.includes('```dataviewjs-off\\nFIRST'));
check('the inline query in the same node stays off', oneOn.includes('off:$='));
check('a source that matches nothing changes nothing', armCanvasBlock(twoOff, 'NOWHERE') === twoOff);

console.log('\n--- idempotence ---');
// Installing, then updating, then installing again must not stack suffixes.
check('switching off twice changes nothing the second time', disarm(disarm(DV)) === disarm(DV));
check('switching on twice changes nothing the second time', arm(arm(off)) === arm(off));

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
