/**
 * The zero-code gate, from the plugin's side of the shared file.
 *
 * The backend has the exhaustive suite; sync-policy proves both repos hold the
 * same bytes. What this covers is what only matters here: the file survives
 * the plugin's own bundling and stricter compiler settings, and the cases
 * where being wrong is expensive in the author's face — a note ABOUT Dataview
 * that must publish, and a fragment that must not.
 */
import { assertNoCode, describeHit, isScannable, locateHit, scanFile } from '../src/nocode';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) { console.log(`  ok   ${label}`); }
	else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

const kinds = (name: string, text: string) =>
	scanFile(name, text).map((hit) => (hit.kind === 'fence' ? `fence:${hit.lang}` : hit.kind));

console.log('\n--- refused ---');
{
	check('fenced dataviewjs', kinds('a.md', '```dataviewjs\nx\n```').join() === 'fence:dataviewjs');
	check('tilde fence too', kinds('a.md', '~~~dataviewjs\nx\n~~~').join() === 'fence:dataviewjs');
	check('a language nobody knows', kinds('a.md', '```brand-new\nx\n```').join() === 'fence:brand-new');
	check('dynamic Templater', kinds('a.md', 'text <%+ tp.x() %> text').join() === 'templater');
	check('plain Templater', kinds('a.md', '<% tp.file.title %>').join() === 'templater');
	check('inline Dataview JS', kinds('a.md', 'x `$= dv.current()` y').join() === 'dataview-inline');
	check('an iframe', kinds('a.md', '<iframe src="https://e.com"></iframe>').join() === 'html');
	check('a Meta Bind button', kinds('a.md', '```meta-bind-button\nlabel: Read more\n```').join() === 'fence:meta-bind-button');
	check('a block nested in an admonition', kinds('a.md', '````ad-note\n```dataviewjs\nx\n```\n````').join() === 'fence:dataviewjs');
	check('a canvas text node', kinds('a.canvas', JSON.stringify({ nodes: [{ type: 'text', text: '```dataviewjs\nx\n```' }] })).join() === 'fence:dataviewjs');
	check('a script in an SVG', kinds('a.svg', '<svg><script>alert(1)</script></svg>').join() === 'html');
}

console.log('\n--- published, and this half is the one that gets forgotten ---');
{
	check('plain prose', kinds('a.md', '# Title\n\nSome [link](b.md).\n').length === 0);
	check('a DQL query', kinds('a.md', '```dataview\nTABLE file.name\n```').length === 0);
	check('inline DQL', kinds('a.md', 'Name: `= this.file.name`').length === 0);
	check('a mermaid diagram', kinds('a.md', '```mermaid\ngraph TD\nA-->B\n```').length === 0);
	check('a highlighted code sample', kinds('a.md', '```python\nprint(1)\n```').length === 0);
	// The false alarm that would matter most: a note teaching Dataview.
	check('an example held in a wider fence', kinds('a.md', '````text\n```dataviewjs\ndv.list([])\n```\n````').length === 0);
	check('a remote image', kinds('a.md', '![](https://e.com/a.png)').length === 0);
	check('images are never opened at all', !isScannable('a.png') && isScannable('a.md'));
}

console.log('\n--- the fence stack does not swallow the rest of the file ---');
{
	// Reading the closing fence as a new opening one hid everything after it.
	check('a fragment after a closed fence is still found', kinds('a.md', '```text\nx\n```\n\n<% tp %>').join() === 'templater');
	check('a fragment after a closed admonition is still found', kinds('a.md', '```ad-note\nx\n```\n\n<% tp %>').join() === 'templater');
}

console.log('\n--- bypasses found in review, each one refused now ---');
{
	check('Templater inside an inert fence body', kinds('a.md', '```csv\n<%+ evil() %>\n```').join() === 'templater');
	check('fence indented inside a list item', kinds('a.md', '- i\n\n    ```dataviewjs\n    x\n    ```').join() === 'fence:dataviewjs');
	check('fence behind a blockquote marker', kinds('a.md', '> ```dataviewjs\n> x\n> ```').join() === 'fence:dataviewjs');
	check('paragraph with a code span is not a fence', kinds('a.md', '```csv``` files are usual.\n\nX `$= dv.pages()` Y').join() === 'dataview-inline');
	check('unterminated fence is refused', kinds('a.md', '# T\n\n```text\nhi').join() === 'unterminated-fence');
	check('inline query written as raw HTML', kinds('a.md', 'T: <code>$= app.foo()</code>').join() === 'dataview-inline');
	check('code span broken over a newline', kinds('a.md', 'T: `\n$= app.foo()`').join() === 'dataview-inline');
	check('event handler on a wrapped tag', kinds('a.md', '<img\n  src="x"\n  onerror="f()">').join() === 'html-event');
	check('event handler past a quoted angle bracket', kinds('a.md', '<img alt="a>b" onerror="f()">').join() === 'html-event');
	check('link that runs a command', kinds('a.md', '[Go](obsidian://advanced-uri?commandid=x)').join() === 'link-scheme');
	check('CRLF frontmatter reaches the Excalidraw check', kinds('a.md', '---\r\nexcalidraw-plugin: parsed\r\n---\r\n').join() === 'excalidraw');

	let threw = false;
	try { assertNoCode('a.canvas', JSON.stringify({ nodes: Array.from({ length: 2001 }, () => ({ type: 'text', text: '# f' })) })); } catch { threw = true; }
	check('canvas beyond the node cap is refused, not truncated', threw);

	// The other half: none of the fixes may start refusing ordinary notes.
	check('a script SHOWN in an html fence still publishes', kinds('a.md', '```html\n<script>alert(1)</script>\n```').length === 0);
	check('an ordinary https link still publishes', kinds('a.md', '[docs](https://obsidian.md/help)').length === 0);
}

console.log('\n--- what the author is told ---');
{
	let message = '';
	try { assertNoCode('notes/lesson.md', '# A\n\n```dataviewjs\nx\n```\n\n<% tp %>\n'); } catch (error) { message = String((error as Error).message); }
	check('every offending line at once, not just the first', message.includes('notes/lesson.md:3') && message.includes('notes/lesson.md:7'), `-> ${message}`);
	check('in words, not in kinds', message.includes('block `dataviewjs`') && message.includes('Templater'), `-> ${message}`);

	// A canvas line number is meaningless without the node it came from.
	const hit = scanFile('b.canvas', JSON.stringify({ nodes: [{ type: 'text', text: 'ok' }, { type: 'text', text: '<% x %>' }] }))[0]!;
	check('a canvas hit names its node', locateHit('b.canvas', hit) === 'b.canvas node 1:1', `-> ${locateHit('b.canvas', hit)}`);
	check('describeHit says something readable', describeHit(hit) === 'Templater command', `-> ${describeHit(hit)}`);

	let threw = false;
	try { assertNoCode('a.md', '# Just notes\n'); } catch { threw = true; }
	check('a clean note says nothing', !threw);
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
