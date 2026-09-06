/**
 * Tests for link resolution, retargeting, and tag namespacing in src/links.ts.
 */
import { applyEdits, localizer, resolveCanvas, resolveLinks, tagSlug, type Edit } from '../src/links';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) { console.log(`  ok   ${label}`); }
	else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ROOT = 'downloads/My Course';
const PATHS = ['A.md', 'Notes/A.md', 'img/x.png', 'Board.canvas'];

/** Runs the install-side rewrite over one file and hands back the text. */
function localize(text: string, path = 'note.md', root = ROOT, tagPrefix = '', paths = PATHS): string {
	return decoder.decode(localizer(root, paths, tagPrefix)(path, encoder.encode(text)));
}

console.log('\n--- applyEdits ---');
{
	const text = 'one two three';
	const edits: Edit[] = [
		{ start: 0, end: 3, original: 'one', text: 'ONE!' },
		{ start: 8, end: 13, original: 'three', text: 'THREE' },
	];
	check('two edits in one line both land', applyEdits(text, edits) === 'ONE! two THREE', `-> ${applyEdits(text, edits)}`);
}
{
	// Drop edit if original text at offsets does not match.
	const text = 'one two three';
	const edits: Edit[] = [
		{ start: 0, end: 3, original: 'XXX', text: 'ONE' },
		{ start: 8, end: 13, original: 'three', text: 'THREE' },
	];
	check('an edit whose original no longer matches is dropped', applyEdits(text, edits) === 'one two THREE', `-> ${applyEdits(text, edits)}`);
}

console.log('\n--- install: prefixing ---');
check('a package-relative wikilink gets the folder', localize('see [[Notes/A|A]]') === `see [[${ROOT}/Notes/A|A]]`, `-> ${localize('see [[Notes/A|A]]')}`);
check('a bare wikilink also gains the display text', localize('see [[A]]') === `see [[${ROOT}/A|A]]`, `-> ${localize('see [[A]]')}`);
check('a target outside the archive is left alone', localize('see [[Nope]]') === 'see [[Nope]]');
check('a bare subpath is left alone', localize('see [[#Heading]]') === 'see [[#Heading]]');
// Embeds preserve dimensions/alt text instead of treating '|' as alias.
check('an embed gets no alias', localize('![[img/x.png]]') === `![[${ROOT}/img/x.png]]`, `-> ${localize('![[img/x.png]]')}`);
check('an embed keeps its width', localize('![[img/x.png|300]]') === `![[${ROOT}/img/x.png|300]]`, `-> ${localize('![[img/x.png|300]]')}`);
// The alias repeats the whole body, subpath included: trimming it would leave
// the reader seeing "Notes/A" where the author's vault showed "Notes/A#H".
check('a heading subpath stays visible', localize('[[Notes/A#H]]') === `[[${ROOT}/Notes/A#H|Notes/A#H]]`, `-> ${localize('[[Notes/A#H]]')}`);
check('a block subpath stays visible', localize('[[Notes/A#^blk]]') === `[[${ROOT}/Notes/A#^blk|Notes/A#^blk]]`, `-> ${localize('[[Notes/A#^blk]]')}`);
check('an aliased subpath keeps the author alias', localize('[[Notes/A#H|see this]]') === `[[${ROOT}/Notes/A#H|see this]]`, `-> ${localize('[[Notes/A#H|see this]]')}`);

console.log('\n--- install: links in code are examples, not links ---');
{
	// The publish side gets this free (the metadata cache skips code), so a
	// rewrite here would make the two ends of the same feature disagree.
	const fence = '```text\n[[A]]\n```\nsee [[A]]';
	check('a link in a fence is left alone', localize(fence) === `\`\`\`text\n[[A]]\n\`\`\`\nsee [[${ROOT}/A|A]]`, `-> ${localize(fence)}`);
	check('a link in inline code is left alone', localize('use `[[A]]` here') === 'use `[[A]]` here', `-> ${localize('use `[[A]]` here')}`);
	check('a markdown link in a fence is left alone', localize('```\n[t](A.md)\n```') === '```\n[t](A.md)\n```', `-> ${localize('```\n[t](A.md)\n```')}`);
	// The mask only answers "was the opening bracket inside code?", so a code
	// span in the display text must not cost the link its rewrite.
	check('inline code inside the display text does not block the rewrite', localize('[a `b` c](A.md)') === '[a `b` c](downloads/My%20Course/A.md)', `-> ${localize('[a `b` c](A.md)')}`);
}

console.log('\n--- install: markdown links ---');
check('a markdown link is prefixed and escaped', localize('[t](Notes/A.md)') === '[t](downloads/My%20Course/Notes/A.md)', `-> ${localize('[t](Notes/A.md)')}`);
// Escape parentheses so folder names like "(2024)" don't break Markdown links.
check('parentheses in the folder are escaped', localize('[t](A.md)', 'note.md', 'dl/Notes (2024)') === '[t](dl/Notes%20%282024%29/A.md)', `-> ${localize('[t](A.md)', 'note.md', 'dl/Notes (2024)')}`);
check('an external link is untouched', localize('[t](https://example.com/a.md)') === '[t](https://example.com/a.md)');
check('a mailto link is untouched', localize('[t](mailto:a@b.c)') === '[t](mailto:a@b.c)');
check('an anchor-only link is untouched', localize('[t](#heading)') === '[t](#heading)');

console.log('\n--- install: refusals ---');
{
	// Skip rewriting if the destination folder contains characters breaking wikilink syntax.
	const text = 'see [[A]] and [t](A.md)';
	check('a folder breaking link syntax disables the whole package', localize(text, 'note.md', 'dl/Notes #1') === text);
	// A backtick would open a code span inside the link, and `$= runs in Dataview.
	check('a folder that could open a code span disables it too', localize(text, 'note.md', 'dl/a`$=b') === text, `-> ${localize(text, 'note.md', 'dl/a`$=b')}`);
}
check('a flat package published before this change still resolves', localize('see [[A]]', 'note.md', ROOT, '', ['A.md']) === `see [[${ROOT}/A|A]]`);
check('an image is returned unchanged', localizer(ROOT, PATHS, '')('img/x.png', encoder.encode('not text')) instanceof Uint8Array);

console.log('\n--- install: byte hygiene ---');
{
	const data = encoder.encode('nothing to rewrite here');
	check('a note with no links keeps its exact bytes', localizer(ROOT, PATHS, '')('note.md', data) === data);
	const png = encoder.encode('\x89PNG');
	check('a binary file keeps its exact bytes', localizer(ROOT, PATHS, '')('img/x.png', png) === png);

	const out = localizer(ROOT, PATHS, '')('note.md', encoder.encode('see [[A]]'));
	// Ensure buffer length matches byteLength for raw writes.
	check('a rewritten note has an exact-length buffer', out.buffer.byteLength === out.byteLength, `-> ${out.buffer.byteLength} vs ${out.byteLength}`);
}

console.log('\n--- install: tags ---');
check('an inline tag is nested', localize('read #anki now', 'note.md', ROOT, 'my-course') === 'read #my-course/anki now', `-> ${localize('read #anki now', 'note.md', ROOT, 'my-course')}`);
check('a nested tag keeps its shape', localize('#nauka/fiszki', 'note.md', ROOT, 'my-course') === '#my-course/nauka/fiszki');
check('an empty prefix changes nothing', localize('read #anki now') === 'read #anki now');
check('a subpath hash is not a tag', localize('[[Notes/A#H]]', 'note.md', ROOT, 'my-course') === `[[${ROOT}/Notes/A#H|Notes/A#H]]`, `-> ${localize('[[Notes/A#H]]', 'note.md', ROOT, 'my-course')}`);
check('a url fragment is not a tag', localize('see https://x.dev/#frag', 'note.md', ROOT, 'my-course') === 'see https://x.dev/#frag');
check('a tag in a fence is left alone', localize('```\n#anki\n```\n#anki', 'note.md', ROOT, 'my-course') === '```\n#anki\n```\n#my-course/anki', `-> ${localize('```\n#anki\n```\n#anki', 'note.md', ROOT, 'my-course')}`);
check('a tag in inline code is left alone', localize('use `#anki` here', 'note.md', ROOT, 'my-course') === 'use `#anki` here');
check('a bare number is not a tag', localize('issue #123', 'note.md', ROOT, 'my-course') === 'issue #123');
check('an already nested tag is not doubled', localize('#my-course/anki', 'note.md', ROOT, 'my-course') === '#my-course/anki');

console.log('\n--- install: frontmatter tags ---');
{
	const inline = '---\ntags: [anki, nauka]\n---\nbody';
	check('an inline array is nested', localize(inline, 'note.md', ROOT, 'my-course') === '---\ntags: [my-course/anki, my-course/nauka]\n---\nbody', `-> ${localize(inline, 'note.md', ROOT, 'my-course')}`);

	const block = '---\ntags:\n  - anki\n  - nauka\n---\nbody';
	check('a block list is nested', localize(block, 'note.md', ROOT, 'my-course') === '---\ntags:\n  - my-course/anki\n  - my-course/nauka\n---\nbody', `-> ${localize(block, 'note.md', ROOT, 'my-course')}`);

	const commas = '---\ntags: anki, nauka\n---\nbody';
	check('a comma list is nested', localize(commas, 'note.md', ROOT, 'my-course') === '---\ntags: my-course/anki, my-course/nauka\n---\nbody', `-> ${localize(commas, 'note.md', ROOT, 'my-course')}`);

	// CRLF: the tag line keeps its \r, so the offset must not count it.
	const crlf = '---\r\ntags: anki, nauka\r\nauthor: x\r\n---\r\nbody';
	check('a CRLF comma list is nested', localize(crlf, 'note.md', ROOT, 'my-course') === '---\r\ntags: my-course/anki, my-course/nauka\r\nauthor: x\r\n---\r\nbody', `-> ${JSON.stringify(localize(crlf, 'note.md', ROOT, 'my-course'))}`);

	const other = '---\ntitle: anki\naliases:\n  - anki\n---\nbody';
	check('another key is not touched', localize(other, 'note.md', ROOT, 'my-course') === other, `-> ${localize(other, 'note.md', ROOT, 'my-course')}`);
}

console.log('\n--- install: canvas ---');
{
	const canvas = JSON.stringify({
		nodes: [
			{ id: '1', type: 'file', file: 'Notes/A.md', x: 0 },
			{ id: '2', type: 'text', text: 'see [[A]]' },
			{ id: '3', type: 'file', file: 'Outside.md' },
		],
	});
	const out = JSON.parse(localize(canvas, 'Board.canvas'));
	check('a file node is repointed', out.nodes[0].file === `${ROOT}/Notes/A.md`, `-> ${out.nodes[0].file}`);
	check('a text node is localized', out.nodes[1].text === `see [[${ROOT}/A|A]]`, `-> ${out.nodes[1].text}`);
	check('a file node outside the package is left alone', out.nodes[2].file === 'Outside.md');
	check('node geometry survives', out.nodes[0].x === 0);
}

console.log('\n--- tagSlug ---');
check('spaces become dashes', tagSlug('My Course') === 'my-course');
check('punctuation is dropped', tagSlug('C++: the "good" parts!') === 'c-the-good-parts', `-> ${tagSlug('C++: the "good" parts!')}`);
check('a title with nothing usable slugs to empty', tagSlug('!!!') === '');
// Stripped punctuation must not leave a run of dashes behind.
check('stripped punctuation does not double the dash', tagSlug('Evil `$= app.vault Deck') === 'evil-appvault-deck', `-> ${tagSlug('Evil `$= app.vault Deck')}`);
check('dashes the author typed are collapsed too', tagSlug('A -- B') === 'a-b', `-> ${tagSlug('A -- B')}`);

console.log('\n--- publish: resolution comes from the vault ---');
{
	// Minimal mock of Obsidian metadataCache for link resolution.
	const files: Record<string, any> = {};
	for (const path of ['Courses/Kurs/A.md', 'Courses/Kurs/Notes/A.md', 'Private/A.md', 'Courses/Kurs/B.md']) {
		files[path] = { path };
	}
	const cache: Record<string, any> = {
		'Courses/Kurs/B.md': {
			links: [
				{ link: 'Notes/A', original: '[[Notes/A]]', position: { start: { offset: 4 }, end: { offset: 15 } } },
				{ link: 'Private/A', original: '[[Private/A]]', position: { start: { offset: 20 }, end: { offset: 33 } } },
			],
			embeds: [],
		},
	};
	const app: any = {
		metadataCache: {
			getFileCache: (file: any) => cache[file.path] ?? null,
			// Resolve by relative path or fallback to filename.
			getFirstLinkpathDest: (linkpath: string, source: string) => {
				const dir = source.slice(0, source.lastIndexOf('/') + 1);
				// Last resort is a bare-name match anywhere, like Obsidian's
				// shortest-path resolution — that is the case worth rewriting.
				const byName = Object.keys(files).find((path) => path.endsWith(`/${linkpath}.md`));

				return files[`${dir}${linkpath}.md`] ?? files[`${linkpath}.md`] ?? (byName === undefined ? null : files[byName]) ?? null;
			},
		},
	};

	const inPackage = new Set(['Courses/Kurs/A.md', 'Courses/Kurs/Notes/A.md', 'Courses/Kurs/B.md']);
	const edits = resolveLinks(app, files['Courses/Kurs/B.md'], 'Courses/Kurs/', inPackage);

	// [[Notes/A]] already spells the package-relative path, and [[Private/A]]
	// points outside — so neither is worth an edit. Rewriting the first would
	// only bolt on an alias repeating the target.
	check('a link that already matches its package path is not rewritten', edits.length === 0, `-> ${JSON.stringify(edits)}`);

	// A bare name resolving to a nested file is the case that does need it:
	// the reader's vault has no "Deep" to shorten against.
	files['Courses/Kurs/Deep/Note.md'] = { path: 'Courses/Kurs/Deep/Note.md' };
	inPackage.add('Courses/Kurs/Deep/Note.md');
	cache['Courses/Kurs/B.md'].links = [
		{ link: 'Note', original: '[[Note]]', position: { start: { offset: 4 }, end: { offset: 12 } } },
	];
	const moved = resolveLinks(app, files['Courses/Kurs/B.md'], 'Courses/Kurs/', inPackage);
	check('a bare name is spelled out to its package path', moved[0]?.text === '[[Deep/Note|Note]]', `-> ${JSON.stringify(moved)}`);
	check('the offsets come from the cache', moved[0]?.start === 4 && moved[0]?.end === 12);

	const canvas = JSON.stringify({ nodes: [{ id: '1', type: 'file', file: 'Courses/Kurs/A.md' }, { id: '2', type: 'file', file: 'Private/A.md' }] });
	const out = JSON.parse(resolveCanvas(app, files['Courses/Kurs/B.md'], canvas, 'Courses/Kurs/', inPackage));
	check('a canvas file node inside the package is made relative', out.nodes[0].file === 'A.md', `-> ${out.nodes[0].file}`);
	check('a canvas file node outside it is not', out.nodes[1].file === 'Private/A.md');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
process.exit(failures ? 1 : 0);
