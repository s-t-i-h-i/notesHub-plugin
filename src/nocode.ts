/**
 * The whole content rule: a package may not contain anything that executes.
 *
 * Refusal happens once, at publish, and names file:line. This replaced a
 * manifest that described arbitrary content truthfully — and describing
 * forces a denylist, because you cannot refuse what you failed to recognise.
 * Refusing lets us allowlist instead: an unknown fence language is refused, so
 * a plugin released tomorrow is already covered by code written today.
 *
 * A false alarm costs an author one edit. A miss ships executable content to
 * readers. Everything ambiguous here leans towards refusing.
 *
 * Shared verbatim between the worker and the plugin.
 */

import { extensionOf } from './verify';

export class CodeError extends Error {}

/** What was found and where. `kind` is what a disarm pass would transform. */
export interface Hit {
	line: number;
	kind:
		| 'fence'
		| 'unterminated-fence'
		| 'templater'
		| 'dataview-inline'
		| 'html'
		| 'html-event'
		| 'link-scheme'
		| 'mermaid-click'
		| 'excalidraw'
		| 'canvas-link';
	/** Fence info string, lowercased. Only set for `fence`. */
	lang?: string;
	/** Index of the canvas node the hit came from, where a line number alone says nothing. */
	node?: number;
}

/** Only these are read. An image cannot execute, so opening one buys nothing. */
const SCANNED = ['md', 'canvas', 'svg'];

export function isScannable(path: string): boolean {
	return SCANNED.includes(extensionOf(path));
}

/**
 * Languages that only ever colour text.
 *
 * Being wrong here costs a false alarm, never a miss: anything absent from the
 * list is refused. That is the whole reason this is a list of the safe rather
 * than a list of the dangerous.
 */
const INERT = new Set([
	// Highlighting only — no interpreter in the ecosystem claims these.
	'text', 'plain', 'plaintext', 'txt', 'md', 'markdown', 'json', 'json5', 'yaml', 'yml', 'toml', 'ini', 'xml',
	'html', 'css', 'scss', 'sass', 'less', 'sql', 'graphql', 'diff', 'patch', 'csv', 'log', 'http',
	'js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'json-ld',
	'python', 'py', 'ruby', 'rb', 'php', 'perl', 'lua', 'r', 'julia',
	'bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'bat', 'dockerfile', 'makefile', 'nix',
	'c', 'h', 'cpp', 'cxx', 'cs', 'csharp', 'java', 'kotlin', 'scala', 'swift', 'objc', 'go', 'rust', 'rs',
	'dart', 'elixir', 'erlang', 'haskell', 'clojure', 'lisp', 'ocaml', 'fsharp', 'zig', 'asm',
	'latex', 'tex', 'bibtex', 'vim', 'regex', 'ebnf', 'gitignore', 'properties', 'protobuf',

	// Query languages: they read the vault and render a table, but they are not
	// JavaScript and cannot execute anything. Refusing them would cost the most
	// common kind of real note for the least safety.
	'dataview', 'tasks', 'query',

	// A Meta Bind input field binds a control to a frontmatter property. It
	// writes, but only where the reader typed, and it runs nothing.
	// `meta-bind-button` is NOT here: it invokes an arbitrary Obsidian command,
	// which with Templater installed is a route to running code — behind a
	// button the package gets to label however it likes.
	'meta-bind',
]);

/**
 * What a fence may legally sit behind.
 *
 * A fence anchored at column 0 was the whole miss: inside a list item or after
 * a `>` the fence is indented further and still renders as a code block, so
 * ```dataviewjs nested one level deep was invisible to the gate while Obsidian
 * ran it. Stripping the container prefix is deliberately generous — a deeply
 * indented block that CommonMark would call an indented code block is read as
 * a fence here and refused. That is a false alarm, which costs an edit; the
 * alternative is a miss, which costs the reader's vault.
 */
const CONTAINER = /^[ \t]*(?:>[ \t]*)*/;
const FENCE = /^(`{3,}|~{3,})[ \t]*(.*)$/;

/** An admonition holds Markdown, so its body is read rather than skipped. */
const ADMONITION = /^ad-[a-z0-9-]+$/;

/** Mermaid's `click` turns a diagram node into a link or a callback. Nothing else in it runs. */
const MERMAID_CLICK = /^\s*click\s+\S/;

/**
 * Templater, scanned against the RAW file.
 *
 * Measured: the dynamic form `<%+ %>` registers a markdown post-processor and
 * walks rendered text nodes, so it runs on note open in a paragraph, in a code
 * span AND inside a code block. No structure hides a fragment from it, which
 * is why this is not in the prose list below.
 */
const RAW: [RegExp, Hit['kind']][] = [
	[/<%/, 'templater'],
	// The entity spelling reaches the same place: the dynamic processor walks
	// rendered text nodes, and by then `&lt;%` has decoded back to `<%`.
	// Precautionary rather than measured, and cheap: no ordinary note writes it.
	[/&(?:lt|#0*60|#[xX]0*3[cC]);%/, 'templater'],
];

/**
 * An attribute list, up to but not past the tag's own `>`.
 *
 * A plain `[^>]*` stops at the first `>` in the source, including one inside a
 * quoted value — so `<img alt="a>b" onerror="...">` hid its handler. Quoted
 * runs are consumed whole. The three alternatives cannot match the same first
 * character, so there is nothing for the engine to backtrack over.
 */
const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'])*`;

/**
 * Fragments a fence DOES hide, matched against prose — the file with every
 * fence body blanked out, offsets preserved.
 *
 * Whole-text rather than line-by-line on purpose: a code span may be broken
 * over a newline (CommonMark folds it to a space and Dataview still trims and
 * runs it) and an HTML tag may wrap its attributes over several lines.
 */
const PROSE: [RegExp, Hit['kind']][] = [
	// Dataview claims a span with querySelectorAll("code") and a startsWith on
	// the element's text. It never asks whether Markdown made that element
	// from backticks, so the raw-HTML spelling runs exactly the same.
	[/`\s*\$=/, 'dataview-inline'],
	[new RegExp(`<code\\b${ATTRS}>\\s*\\$=`, 'i'), 'dataview-inline'],
	[/<(script|iframe|object|embed)\b/i, 'html'],
	[new RegExp(`<[a-z][a-z0-9-]*${ATTRS}\\son[a-z]+\\s*=`, 'i'), 'html-event'],
	// obsidian://advanced-uri runs an arbitrary command and javascript: runs
	// arbitrary code — one click from execution, which is the same threat that
	// keeps meta-bind-button out of INERT.
	[/]\(\s*(?:obsidian:\/\/|javascript:)/i, 'link-scheme'],
	[/href\s*=\s*["']?\s*(?:obsidian:\/\/|javascript:)/i, 'link-scheme'],
	[/<(?:obsidian:\/\/|javascript:)/i, 'link-scheme'],
	// A reference definition is a link too, just spelled in two halves.
	[/^ {0,3}\[[^\]]*\]:\s*(?:obsidian:\/\/|javascript:)/im, 'link-scheme'],
];

/** An Excalidraw drawing lives in a .md file and can carry Script elements. */
const EXCALIDRAW = /^excalidraw-plugin\s*:/m;

/** Matches how the plugin ecosystem reads canvases, and bounds a hostile node count. */
const MAX_CANVAS_NODES = 2000;

interface Frame {
	marker: string;
	/** 'skip' — an opaque body; 'markdown' — read on; 'mermaid' — only look for `click`. */
	scan: 'skip' | 'markdown' | 'mermaid';
}

/** The fence a line opens or closes, ignoring any container it sits inside. */
function fenceOf(raw: string): { marker: string; lang: string } | null {
	const prefix = CONTAINER.exec(raw);
	const fence = FENCE.exec(raw.slice(prefix ? prefix[0].length : 0));
	if (!fence) return null;

	const marker = fence[1] ?? '';
	const info = (fence[2] ?? '').trim();
	// A backtick fence's info string cannot contain a backtick — without this,
	// a paragraph starting with an inline code span reads as a fence opener and
	// swallows the rest of the file.
	if (marker.startsWith('`') && info.includes('`')) return null;

	return { marker, lang: (info.split(/\s+/)[0] ?? '').toLowerCase() };
}

/** Byte-for-byte as long as the line it replaces, so offsets stay true. */
function blank(line: string): string {
	return ' '.repeat(line.length);
}

/** Offsets of every line start, so a match index becomes a line number without rescanning. */
function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);

	return starts;
}

function lineAt(starts: number[], index: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if ((starts[mid] as number) <= index) low = mid;
		else high = mid - 1;
	}

	return low + 1;
}

/**
 * Every match of one pattern, with line numbers.
 *
 * The RegExp is rebuilt per call rather than reused with /g: a global regex
 * carries lastIndex between calls, so the same pattern would skip every other
 * file.
 */
function matchAll(text: string, starts: number[], pattern: RegExp, kind: Hit['kind'], hits: Hit[]): void {
	const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
	for (let found = scan.exec(text); found !== null; found = scan.exec(text)) {
		hits.push({ line: lineAt(starts, found.index), kind });
		if (found.index === scan.lastIndex) scan.lastIndex++;
	}
}

/**
 * The single pass over a note. The publish gate reads these hits, and a future
 * disarm pass would read the same ones — one scanner, so the two cannot drift.
 *
 * Three passes, because three different things hide content: fence structure
 * decides what is markup, Templater ignores structure entirely, and everything
 * else is prose with fence bodies removed.
 */
export function scanCode(text: string): Hit[] {
	const hits: Hit[] = [];
	const lines = text.split('\n');
	const prose: string[] = [];
	const stack: Frame[] = [];

	lines.forEach((raw, index) => {
		const line = index + 1;
		const top = stack[stack.length - 1];
		const fence = fenceOf(raw);

		if (fence) {
			// A closing fence carries no info string and is at least as long as
			// its opener. Checked first: inside an admonition the same line
			// could otherwise be read as opening a new block.
			if (top && fence.lang === '' && fence.marker[0] === top.marker[0] && fence.marker.length >= top.marker.length) {
				stack.pop();
				prose.push(blank(raw));
				return;
			}
			// Inside an opaque body a fence line is content, not markup. This is
			// what lets an author write about ```dataviewjs inside a wider fence.
			if (top && top.scan !== 'markdown') {
				prose.push(blank(raw));
				return;
			}

			if (fence.lang === '') stack.push({ marker: fence.marker, scan: 'skip' });
			else if (ADMONITION.test(fence.lang)) stack.push({ marker: fence.marker, scan: 'markdown' });
			else if (fence.lang === 'mermaid') stack.push({ marker: fence.marker, scan: 'mermaid' });
			else {
				if (!INERT.has(fence.lang)) hits.push({ line, kind: 'fence', lang: fence.lang });
				stack.push({ marker: fence.marker, scan: 'skip' });
			}
			prose.push(blank(raw));
			return;
		}

		if (top && top.scan === 'mermaid') {
			if (MERMAID_CLICK.test(raw)) hits.push({ line, kind: 'mermaid-click' });
			prose.push(blank(raw));
			return;
		}
		if (top && top.scan === 'skip') {
			prose.push(blank(raw));
			return;
		}

		// Top level, or inside an admonition, which holds Markdown.
		prose.push(raw);
	});

	// An unterminated fence used to hide every line after it. Refusing it beats
	// guessing where the author meant it to end, and a package has no reason to
	// ship one.
	if (stack.length > 0) hits.push({ line: lines.length, kind: 'unterminated-fence' });

	const starts = lineStarts(text);
	for (const [pattern, kind] of RAW) matchAll(text, starts, pattern, kind, hits);

	const blanked = prose.join('\n');
	for (const [pattern, kind] of PROSE) matchAll(blanked, starts, pattern, kind, hits);

	return hits.sort((first, second) => first.line - second.line);
}

/**
 * The frontmatter block, or '' when there is none.
 *
 * CRLF and a leading BOM both have to be accepted: a drawing authored on
 * Windows, or any file normalised by git autocrlf, otherwise reads as having
 * no frontmatter at all and slips the Excalidraw check.
 */
function frontmatter(text: string): string {
	const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const opening = body.startsWith('---\r\n') ? 5 : body.startsWith('---\n') ? 4 : 0;
	if (opening === 0) return '';

	const end = body.indexOf('\n---', opening);

	return end === -1 ? '' : body.slice(opening, end);
}

function scanMarkdown(text: string): Hit[] {
	const hits: Hit[] = EXCALIDRAW.test(frontmatter(text)) ? [{ line: 1, kind: 'excalidraw' }] : [];

	return hits.concat(scanCode(text));
}

/**
 * A canvas is JSON, so its fences live inside strings with \n as an escape and
 * a Markdown scan of the raw file sees nothing at all. Text nodes are read as
 * the Markdown they are; a link node embeds a remote page, which is an iframe
 * by another name.
 */
function scanCanvas(text: string): Hit[] {
	// verify.ts has already parsed this file, so the catch is unreachable in
	// the publish path — and unreachable is not the same as absent.
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new CodeError('The canvas is not valid JSON');
	}

	const doc_ = doc as { nodes?: unknown; edges?: unknown };
	const nodes = Array.isArray(doc_?.nodes) ? doc_.nodes : [];
	const edges = Array.isArray(doc_?.edges) ? doc_.edges : [];

	// Truncating here was a hole, not a budget: the cap came from a describer
	// that ran beside an install-time pass with no cap at all, and that second
	// pass is gone. Node 2001 must not be the place to hide a block.
	if (nodes.length + edges.length > MAX_CANVAS_NODES) {
		throw new CodeError(`The canvas holds more than ${MAX_CANVAS_NODES} nodes, which is more than can be checked. Split it up.`);
	}

	const hits: Hit[] = [];

	// Every string, not just `text` on a `type: "text"` node. Enumerating the
	// fields that can hold Markdown is the same bet as enumerating the
	// languages that can execute, and it loses the same way: a shape we did
	// not think of is a shape nobody checks. Ids and colours cost one cheap
	// scan each and match nothing.
	const scanStrings = (holder: unknown, index: number): void => {
		if (holder === null || typeof holder !== 'object') return;

		for (const value of Object.values(holder as Record<string, unknown>)) {
			if (typeof value === 'string') hits.push(...scanMarkdown(value).map((hit) => ({ ...hit, node: index })));
		}
	};

	nodes.forEach((node: unknown, index) => {
		// A link card is an <iframe> under another name, whatever else it holds.
		if ((node as { type?: unknown } | null)?.type === 'link') hits.push({ line: 1, kind: 'canvas-link', node: index });
		scanStrings(node, index);
	});
	edges.forEach((edge: unknown, index) => scanStrings(edge, index));

	return hits;
}

/** An SVG has no Markdown structure, so nothing can hide and every pattern applies. */
function scanSvg(text: string): Hit[] {
	const hits: Hit[] = [];
	const starts = lineStarts(text);
	for (const [pattern, kind] of [...RAW, ...PROSE]) matchAll(text, starts, pattern, kind, hits);

	return hits.sort((first, second) => first.line - second.line);
}

export function scanFile(path: string, text: string): Hit[] {
	const extension = extensionOf(path);
	if (extension === 'canvas') return scanCanvas(text);
	if (extension === 'svg') return scanSvg(text);

	return scanMarkdown(text);
}

/** One hit in plain language. Exported so the author-side warning uses the server's wording. */
export function describeHit(hit: Hit): string {
	if (hit.kind === 'fence') return `block \`${hit.lang}\` is not inert`;
	if (hit.kind === 'unterminated-fence') return 'a code fence is never closed, so the rest of the file cannot be checked';
	if (hit.kind === 'link-scheme') return 'a link that runs a command';
	if (hit.kind === 'templater') return 'Templater command';
	if (hit.kind === 'dataview-inline') return 'inline Dataview JS';
	if (hit.kind === 'mermaid-click') return 'Mermaid click handler';
	if (hit.kind === 'excalidraw') return 'Excalidraw drawing';
	if (hit.kind === 'canvas-link') return 'canvas card embedding a remote page';
	if (hit.kind === 'html-event') return 'HTML event handler';

	return 'HTML that runs or embeds';
}

/** Where a hit is, as one label. A canvas line number means nothing without its node. */
export function locateHit(path: string, hit: Hit): string {
	return hit.node === undefined ? `${path}:${hit.line}` : `${path} node ${hit.node}:${hit.line}`;
}

/** How many problem lines one refusal carries. Past this the author has enough to work with. */
const MAX_REPORTED = 20;

/** Every reason one file cannot be published, as `path:line — reason` lines. */
export function problemsIn(path: string, text: string): string[] {
	return scanFile(path, text).map((hit) => `${locateHit(path, hit)} — ${describeHit(hit)}`);
}

/**
 * The refusal for a whole package.
 *
 * Callers collect across every file before calling this: an author who has to
 * resubmit once per offending file learns to fight the check rather than read
 * it, and repacking a 50 MB archive to discover the next line is the version
 * of that loop with an upload in it.
 */
export function refusal(problems: string[]): string {
	const listed = problems.slice(0, MAX_REPORTED).join('\n');
	const rest = problems.length - MAX_REPORTED;

	return `This package may not contain anything that runs by itself:\n${listed}${rest > 0 ? `\n...and ${rest} more` : ''}`;
}

/** The publish gate, for one file at a time. */
export function assertNoCode(path: string, text: string): void {
	const problems = problemsIn(path, text);
	if (problems.length > 0) throw new CodeError(refusal(problems));
}
