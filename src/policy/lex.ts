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

export interface Fragment {
	text: string;
	line: number;
	hidden: boolean;
	offset: number;
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
	/** Templater fragments: every <% ... %>, not only <%* ... %>. */
	templater: Fragment[];
	links: LinkRef[];
	/** The document with code, frontmatter and templater blanked out, offsets intact. */
	prose: string;
	/** Whether an offset sits inside a %% comment. */
	hiddenAt(offset: number): boolean;
}

export function lex(text: string): Lexed {
	const blank = [...text];
	const fences: Fence[] = [];
	const templater: Fragment[] = [];
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

		// Inline code first: its contents are shown, never run, so anything
		// found inside it would be a false alarm.
		if (char === '`') {
			const end = closeInlineCode(text, index);
			erase(index, end);
			index = end;
			continue;
		}

		// Templater evaluates JavaScript in EVERY <% ... %>, not only <%* ... %>.
		if (char === '<' && text[index + 1] === '%') {
			const close = text.indexOf('%>', index + 2);
			const end = close === -1 ? text.length : close + 2;
			templater.push({
				text: text.slice(index + 2, close === -1 ? text.length : close).replace(/^[-_*]|[-_]$/g, ''),
				line: lineAt(index),
				hidden: false,
				offset: index,
			});
			erase(index, end);
			index = end;
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

	for (const fence of fences) fence.hidden = hiddenAt(fence.offset);
	for (const fragment of templater) fragment.hidden = hiddenAt(fragment.offset);

	const prose = blank.join('');

	return { frontmatter, fences, templater, links: readLinks(prose, lineAt, hiddenAt), prose, hiddenAt };
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
