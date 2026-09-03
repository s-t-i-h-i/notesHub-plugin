/**
 * Reads the structure of a Markdown file: what is code, what is prose, and
 * what is hidden inside a comment.
 *
 * Not a CommonMark parser — only the parts that decide whether something runs.
 * Position in the structure is the whole point, and it is exactly what a regex
 * cannot see:
 *
 *   ~~~dataviewjs   opens a code block just as ```dataviewjs does, so a rule
 *                   that knows only backticks misses it entirely
 *   `dataviewjs`    inside a sentence is a word, and alarming on it teaches
 *                   people to click past the warning that mattered
 *   `$= code()`     is NOT a word: Dataview runs an inline span whose text
 *                   starts with its prefix, on render, exactly like a fenced
 *                   ```dataviewjs block
 *
 * Everything that is not code is blanked out in place, keeping offsets, so the
 * HTML scanner and the link scanner see the document with its code removed and
 * their line numbers still line up with the original file.
 *
 * Shared verbatim between the worker and the plugin.
 */

export interface Fence {
	/** Info string of the opening fence, lowercased: "dataviewjs", "js-engine", "". */
	lang: string;
	text: string;
	line: number;
	hidden: boolean;
	offset: number;
}

/**
 * A Dataview inline query — a code span the reader sees as `code` and Dataview
 * executes.
 *
 * Measured in Obsidian 1.9 with Dataview 0.5: an inline span runs, a fenced
 * block whose body starts with the same prefix does not, even with
 * `inlineQueriesInCodeblocks` on. So this is about spans only.
 */
export interface InlineQuery {
	/** 'js' evaluates JavaScript; 'dql' only queries the vault; 'off' is one disarm() switched off. */
	kind: 'js' | 'dql' | 'off';
	/** The query itself, prefix stripped. */
	text: string;
	line: number;
	hidden: boolean;
	/** Offset of the opening backtick run. */
	offset: number;
	/** Offset of the prefix itself — the one position disarm() breaks and arm() repairs. */
	prefixAt: number;
}

/** One <% ... %>, wherever it sits in the file. */
export interface Fragment {
	text: string;
	line: number;
	hidden: boolean;
	/** Offset of the '<'. The marker goes two past it, right after "<%". */
	offset: number;
	/**
	 * A dynamic command, `<%+ ... %>`.
	 *
	 * Measured in Obsidian with Templater 2.25: Templater registers a markdown
	 * post-processor for these and walks the rendered text nodes, so a dynamic
	 * command runs the moment a note is opened — in prose, inside a code span
	 * and inside a fenced block alike. Plain `<% %>` and `<%* %>` do not; they
	 * still wait for the reader to invoke Templater.
	 */
	dynamic: boolean;
	/** Already switched off by disarm(). */
	off: boolean;
}

export interface LinkRef {
	dest: string;
	/** True for ![[...]] and ![](...) — an embed loads without a click. */
	embed: boolean;
	line: number;
	hidden: boolean;
}

export interface Lexed {
	/** YAML header, or '' when there is none. Some keys change the file's interpreter. */
	frontmatter: string;
	fences: Fence[];
	/** Templater fragments: every <% ... %>, wherever it sits — structure hides nothing from Templater. */
	templater: Fragment[];
	/** Dataview inline queries: every `$= ...` and `= ...` span. */
	inline: InlineQuery[];
	links: LinkRef[];
	/** The document with code, frontmatter and templater blanked out, offsets intact. */
	prose: string;
	/** Whether an offset sits inside a %% comment. */
	hiddenAt(offset: number): boolean;
}

/**
 * Dataview's inline prefixes, and the marker that breaks them.
 *
 * Both are settings the reader can change (`inlineJsQueryPrefix`,
 * `inlineQueryPrefix`); these are the shipped defaults, which is what a package
 * author writes against. Dataview matches with `innerText.trim().startsWith`
 * and tests the JS one first, so the order here is its order.
 *
 * INLINE_OFF goes in front for the same reason the fence marker goes on the
 * end: it has to stop startsWith() from matching while leaving every character
 * of the query on screen.
 */
const INLINE_JS_PREFIX = '$=';
const INLINE_DQL_PREFIX = '=';
export const INLINE_OFF = 'off:';

/**
 * The switched-off spelling, matched whole.
 *
 * `off:` alone would be far too eager: someone's own `off: true` in a note about
 * configuration is not ours to rewrite, and arm() would silently eat the word.
 * Only `off:` followed by Dataview's own prefix is a marker this code wrote.
 */
const INLINE_OFF_JS = INLINE_OFF + INLINE_JS_PREFIX;

/**
 * Templater's opening delimiter and its modifiers.
 *
 * `<%`, then an optional whitespace-control `-` or `_`, then an optional `*`
 * (execution) or `~`, then `+` for a DYNAMIC command. Lifted from Templater's
 * own pattern so the two agree on what counts as dynamic.
 */
const TEMPLATER_OPEN = /^<%([-_]?)\s*([*~]?)(\+?)/;

/**
 * The switched-off spelling of a dynamic command, matched whole.
 *
 * Same rule as INLINE_OFF_JS, and for the same reason: a bare `off:` after `<%`
 * says nothing about who wrote it. Requiring the `+` that disarm() parked the
 * marker in front of means arm() only ever undoes its own edit — otherwise an
 * author could ship `<%off:+ ... %>`, which the analysis reads as a plain
 * command, and have arm() promote it to one that runs on open.
 */
const TEMPLATER_OFF = /^<%off:([-_]?)\s*([*~]?)\+/;

export function lex(text: string): Lexed {
	// split(''), not [...text]: every offset written into this array — index,
	// indexOf, erase, lineAt — is a UTF-16 code unit. Splitting by code point
	// made one emoji slide the whole blanking by one.
	const blank = text.split('');
	const fences: Fence[] = [];
	const inline: InlineQuery[] = [];
	const hidden: [number, number][] = [];

	const starts = lineStarts(text);
	const lineAt = (offset: number) => findLine(starts, offset);
	const hiddenAt = (offset: number) => hidden.some(([from, to]) => offset >= from && offset < to);

	let index = 0;
	let commentFrom: number | null = null;

	const erase = (from: number, to: number) => {
		for (let i = from; i < to && i < blank.length; i++) {
			if (blank[i] !== '\n') blank[i] = ' ';
		}
	};

	// The YAML header only counts on the very first line.
	if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
		const end = closingDashes(text);
		if (end !== -1) {
			erase(0, end);
			index = end;
		}
	}
	const frontmatter = index > 0 ? text.slice(0, index) : '';

	while (index < text.length) {
		// Fences are only fences at the start of a line.
		if (index === 0 || text[index - 1] === '\n') {
			const opened = openFence(text, index);
			if (opened !== null) {
				const closed = closeFence(text, opened);
				// `hidden` is filled in after the scan: a %% region is only
				// known to be one once its closing %% has been seen, so asking
				// here would answer false for everything inside the first one.
				fences.push({
					lang: opened.lang,
					text: text.slice(opened.bodyFrom, closed.bodyTo),
					line: lineAt(index),
					hidden: false,
					offset: index,
				});
				erase(index, closed.end);
				index = closed.end;
				continue;
			}
		}

		const char = text[index];

		// Inline code: shown rather than run — except when Dataview claims the
		// span by prefix, which is the one case where `code` executes.
		if (char === '`') {
			const end = closeInlineCode(text, index);
			const query = inlineQuery(text, index, end);
			if (query !== null) inline.push({ ...query, line: lineAt(index), hidden: false, offset: index });
			erase(index, end);
			index = end;
			continue;
		}

		// Blanked out of `prose` so the HTML scanner does not read a Templater
		// expression as markup. The fragments themselves are collected from the
		// raw text below, because Templater does not care about structure.
		if (char === '<' && text[index + 1] === '%') {
			const close = text.indexOf('%>', index + 2);
			erase(index, close === -1 ? text.length : close + 2);
			index = close === -1 ? text.length : close + 2;
			continue;
		}

		// %% hides content from the reader but not from Templater or Dataview,
		// which read the raw file. Recorded, never treated as removal.
		if (char === '%' && text[index + 1] === '%') {
			if (commentFrom === null) {
				commentFrom = index;
			} else {
				hidden.push([commentFrom, index + 2]);
				commentFrom = null;
			}
			index += 2;
			continue;
		}

		index++;
	}

	// An unclosed %% runs to the end of the file.
	if (commentFrom !== null) hidden.push([commentFrom, text.length]);

	// Templater reads the raw file and its dynamic processor walks rendered text
	// nodes, so neither a fence nor a code span hides a fragment from it — which
	// is why this scans `text` rather than the structure the loop above built.
	const templater = scanTemplater(text, lineAt);

	for (const fence of fences) fence.hidden = hiddenAt(fence.offset);
	for (const fragment of templater) fragment.hidden = hiddenAt(fragment.offset);
	for (const query of inline) query.hidden = hiddenAt(query.offset);

	const prose = blank.join('');

	// After the blanking, so a <code> tag shown inside a fence or a code span is
	// not read as one Dataview would execute.
	inline.push(...scanCodeTags(prose, lineAt, hiddenAt));

	return { frontmatter, fences, templater, inline, links: readLinks(prose, lineAt, hiddenAt), prose, hiddenAt };
}

/** Every <% ... %> in the file, dynamic ones marked. */
function scanTemplater(text: string, lineAt: (offset: number) => number): Fragment[] {
	const fragments: Fragment[] = [];
	let index = 0;

	for (;;) {
		const open = text.indexOf('<%', index);
		if (open === -1) return fragments;

		const close = text.indexOf('%>', open + 2);
		const bodyTo = close === -1 ? text.length : close;

		// disarm() parks its marker directly after "<%", which is also what
		// stops Templater's dynamic pattern from matching.
		const fragment = text.slice(open, bodyTo);
		const off = TEMPLATER_OFF.test(fragment);
		// The whole fragment, not a fixed window: Templater's own pattern puts
		// an unbounded \s* between "<%" and the '+', so reading a few bytes
		// meant six spaces were enough to hide a dynamic command from us while
		// Templater still ran it.
		const opener = TEMPLATER_OPEN.exec(fragment);

		fragments.push({
			text: text.slice(open + (opener?.[0].length ?? 2), bodyTo).replace(/[-_]$/, ''),
			line: lineAt(open),
			hidden: false,
			offset: open,
			dynamic: opener?.[3] === '+',
			off,
		});

		index = close === -1 ? text.length : close + 2;
	}
}

/**
 * Reads one code span as a Dataview query, or null when it is ordinary code.
 *
 * `from` is the opening backtick and `to` is one past the closing run — exactly
 * what closeInlineCode() returns, including the case where it never closed and
 * the backticks are literal text.
 */
function inlineQuery(text: string, from: number, to: number): Omit<InlineQuery, 'line' | 'hidden' | 'offset'> | null {
	let run = 0;
	while (text[from + run] === '`') run++;

	const bodyFrom = from + run;
	// Unclosed: only the backticks were consumed, so there is no body to read.
	if (to <= bodyFrom + run) return null;

	return inlineBody(text.slice(bodyFrom, to - run), bodyFrom);
}

/**
 * Classifies the text inside a code element, wherever it came from.
 *
 * `bodyFrom` is where that text starts in the document, so `prefixAt` lands on
 * the real offset disarm() has to break.
 */
function inlineBody(body: string, bodyFrom: number): Omit<InlineQuery, 'line' | 'hidden' | 'offset'> | null {
	// Dataview trims before matching, so "` $= x`" is a query just as "`$= x`" is.
	const trimmed = body.trimStart();

	const kind = trimmed.startsWith(INLINE_OFF_JS)
		? 'off'
		: trimmed.startsWith(INLINE_JS_PREFIX)
			? 'js'
			: trimmed.startsWith(INLINE_DQL_PREFIX)
				? 'dql'
				: null;
	if (kind === null) return null;

	const prefix = kind === 'off' ? INLINE_OFF_JS : kind === 'js' ? INLINE_JS_PREFIX : INLINE_DQL_PREFIX;
	const query = trimmed.slice(prefix.length).trim();
	// Dataview skips an empty query, so a bare `=` is punctuation, not a finding.
	if (query === '') return null;

	return { kind, text: query, prefixAt: bodyFrom + (body.length - trimmed.length) };
}

/**
 * Dataview inline queries written as raw HTML.
 *
 * Dataview claims a span with `querySelectorAll("code")` and a startsWith on
 * the element's text — it never asks whether Markdown made that element from
 * backticks. A `<code>$= ...</code>` written straight into the note therefore
 * runs exactly like a backtick span, and reading only backticks left it
 * invisible to the manifest and untouched by disarm().
 *
 * Scanned over `prose`, where fences and code spans are already blanked: inside
 * either of those the tag is shown rather than rendered.
 */
const CODE_TAG = /(<code(?:\s[^>]*)?>)([\s\S]*?)<\/code\s*>/gi;

function scanCodeTags(prose: string, lineAt: (offset: number) => number, hiddenAt: (offset: number) => boolean): InlineQuery[] {
	const queries: InlineQuery[] = [];

	for (let match = CODE_TAG.exec(prose); match !== null; match = CODE_TAG.exec(prose)) {
		const open = match[1] ?? '';
		const query = inlineBody(match[2] ?? '', match.index + open.length);
		if (query === null) continue;

		// Numbered by the prefix rather than by the tag, so the line the
		// manifest reports is the line disarm() edits even when the opening tag
		// is spread over several.
		queries.push({ ...query, line: lineAt(query.prefixAt), hidden: hiddenAt(query.prefixAt), offset: match.index });
	}

	return queries;
}

/** The opening of a fence, or null when this line is not one. */
function openFence(text: string, index: number): { marker: string; count: number; lang: string; bodyFrom: number } | null {
	const line = text.slice(index, lineEnd(text, index));
	// Up to three spaces of indent still opens a fence; four would make it an
	// indented code block instead.
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	if (match === null) return null;

	const run = match[1] ?? '';
	const marker = run[0] ?? '';
	const info = (match[2] ?? '').trim();
	// A backtick fence's info string cannot contain a backtick — otherwise
	// `` `a` `` at the start of a line would read as a fence.
	if (marker === '`' && info.includes('`')) return null;

	return {
		marker,
		count: run.length,
		lang: (info.split(/\s+/)[0] ?? '').toLowerCase(),
		bodyFrom: Math.min(text.length, lineEnd(text, index) + 1),
	};
}

function closeFence(text: string, opened: { marker: string; count: number; bodyFrom: number }): { bodyTo: number; end: number } {
	let index = opened.bodyFrom;

	while (index < text.length) {
		const end = lineEnd(text, index);
		const line = text.slice(index, end);
		const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);

		const run = match?.[1] ?? '';
		if (match !== null && run[0] === opened.marker && run.length >= opened.count) {
			return { bodyTo: index, end: Math.min(text.length, end + 1) };
		}
		index = end + 1;
	}

	// An unclosed fence runs to the end of the file, exactly as Obsidian renders it.
	return { bodyTo: text.length, end: text.length };
}

/** The end of an inline code span, delimiters included. */
function closeInlineCode(text: string, index: number): number {
	let run = 0;
	while (text[index + run] === '`') run++;

	const fence = '`'.repeat(run);
	let search = index + run;
	while (search < text.length) {
		const found = text.indexOf(fence, search);
		if (found === -1) break;
		// The closing run has to be exactly as long as the opening one.
		if (text[found + run] !== '`') return found + run;
		search = found + run;
		while (text[search] === '`') search++;
	}

	// Unclosed: the backticks are literal text, so only they are consumed.
	return index + run;
}

function readLinks(prose: string, lineAt: (offset: number) => number, hiddenAt: (offset: number) => boolean): LinkRef[] {
	const links: LinkRef[] = [];

	for (const match of prose.matchAll(/(!?)\[\[([^\]\n|]+)/g)) {
		links.push({ dest: (match[2] ?? '').trim(), embed: match[1] === '!', line: lineAt(match.index), hidden: hiddenAt(match.index) });
	}
	for (const match of prose.matchAll(/(!?)\[[^\]\n]*\]\(\s*([^)\s]+)/g)) {
		links.push({ dest: (match[2] ?? '').trim(), embed: match[1] === '!', line: lineAt(match.index), hidden: hiddenAt(match.index) });
	}

	return links;
}

function closingDashes(text: string): number {
	const match = /\n---[ \t]*(\r?\n|$)/.exec(text);

	return match === null ? -1 : match.index + match[0].length;
}

function lineEnd(text: string, index: number): number {
	const found = text.indexOf('\n', index);

	return found === -1 ? text.length : found;
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);

	return starts;
}

function findLine(starts: number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;

	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if ((starts[mid] ?? 0) <= offset) low = mid;
		else high = mid - 1;
	}

	return low + 1;
}
