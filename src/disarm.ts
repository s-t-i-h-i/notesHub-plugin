/**
 * Turning someone else's code off without taking it away.
 *
 * A package installs whole and readable, but the fragments that would start on
 * their own the moment a note is opened are switched off first. Nothing is
 * removed, nothing is rewritten beyond a suffix, and the reader turns any of it
 * back on with one click.
 *
 * The mechanism is deliberately just text:
 *
 *   ```dataviewjs   ->  ```dataviewjs-off
 *   `$= code()`     ->  `off:$= code()`
 *   <iframe src=…>  ->  <iframe data-off-src=…>
 *
 * Dataview matches the language exactly, so `dataviewjs-off` runs nothing while
 * the code stays visible, character for character. There is no state to lose,
 * no record to keep in sync, and someone can undo it by hand in the editor if
 * this plugin is not around.
 *
 * A plain Templater command is NOT disarmed, on purpose. It runs when the reader
 * invokes it, not when a note is opened, and an install lands in the download
 * folder rather than a template folder. Disarming it would be friction with
 * nothing behind it — which is exactly what the old warning screen was.
 *
 * Its DYNAMIC form is another matter and is switched off:
 *
 *   <%+ code %>     ->  <%off:+ code %>
 *
 * Measured in Obsidian with Templater 2.25: a dynamic command is executed by a
 * markdown post-processor when the note is opened, with no command from anyone.
 * Parking the marker after "<%" stops the dynamic pattern from matching while
 * leaving the fragment where Templater's ordinary command path can still find
 * it — so this demotes it to the trigger every other Templater tag already has,
 * rather than pretending to delete it.
 */

import { INLINE_OFF, lex, type Fence } from './policy/lex';
import { scanTags } from './policy/html';
import { DISARM_SUFFIX, interpreterFor, selfStartingFences } from './policy/interpreters';

/**
 * Whether Obsidian can be handed a renderer for this language at all.
 *
 * registerMarkdownCodeBlockProcessor() builds the selector `code.language-<lang>`
 * and runs it over every rendered note in the vault. A language that is not a
 * valid class name makes that selector throw, inside every reading-view render,
 * in notes that have nothing to do with any package — which is how `jsx:`
 * blanked out reading mode vault-wide in 0.2.0.
 *
 * So a block whose language cannot carry a renderer is left running rather than
 * switched off: off with nothing to draw it is a dead block with no way back
 * except editing the note by hand.
 */
function renderable(lang: string): boolean {
	return /^[a-z][a-z0-9_-]*$/i.test(lang);
}

/** Attributes that name the remote document an embed would load. */
const REMOTE_ATTRS = ['src', 'data'];

/** Where a disarmed remote source is parked. */
function offAttr(attr: string): string {
	return `data-off-${attr}`;
}

interface Edit {
	from: number;
	to: number;
	text: string;
	/**
	 * The line the manifest numbers this construct by.
	 *
	 * Carried rather than derived from `from`, because the two differ: an
	 * attribute can sit lines below the `<` its finding is reported at. Matching
	 * a finding against an edit only works if both agree on the number.
	 */
	line: number;
}

/**
 * Fence languages this plugin renders itself once they are switched off.
 *
 * Derived from the same table disarmedLang() consults, never listed by hand:
 * a language switched off with no processor registered for it renders as a
 * blank block with no way to turn it back on except editing the note.
 */
export function disarmedLanguages(): string[] {
	return selfStartingFences().filter(renderable).map((lang) => lang + DISARM_SUFFIX);
}

/** Switches off everything that would run on opening the note. */
export function disarm(text: string): string {
	return apply(text, collect(text, 'disarm'));
}

/** Switches all of it back on. The exact inverse of disarm(). */
export function arm(text: string): string {
	return apply(text, collect(text, 'arm'));
}

/**
 * Switches on the single block starting at `line`.
 *
 * Per block rather than per file because that is the decision the reader is
 * actually making: they have just read this one and want to see what it does.
 */
export function armBlock(text: string, line: number): string {
	return apply(
		text,
		collect(text, 'arm').filter((edit) => lineOf(text, edit.from) === line),
	);
}

/**
 * The edits, in one place for both directions.
 *
 * Sharing the traversal is what keeps disarm() and arm() exact inverses of each
 * other. Two separate walks would drift the first time one of them learned
 * about a construct the other did not.
 */
function collect(text: string, direction: 'disarm' | 'arm'): Edit[] {
	const document = lex(text);
	const edits: Edit[] = [];

	for (const fence of document.fences) {
		const interpreter = interpreterFor(fence.lang);

		// An admonition holds Markdown, so what is nested inside it runs too.
		if (interpreter?.nested === true) {
			const body = bodyOffset(text, fence.offset);
			for (const nested of collect(fence.text, direction)) {
				edits.push({ from: nested.from + body, to: nested.to + body, text: nested.text, line: nested.line });
			}
			continue;
		}

		const target = direction === 'disarm' ? disarmedLang(fence) : armedLang(fence);
		if (target === null) continue;

		const span = langSpan(text, fence.offset);
		if (span !== null) edits.push({ from: span.from, to: span.to, text: target, line: fence.line });
	}

	// Dataview claims an inline span by prefix, so breaking the prefix is the
	// same move as renaming a fence: nothing matches, every character stays on
	// screen, and putting it back is the exact inverse.
	for (const query of document.inline) {
		if (direction === 'disarm') {
			// A DQL query executes nothing — left alone for the same reason the
			// ```dataview fence is.
			if (query.kind !== 'js') continue;
			edits.push({ from: query.prefixAt, to: query.prefixAt, text: INLINE_OFF, line: query.line });
		} else {
			if (query.kind !== 'off') continue;
			edits.push({ from: query.prefixAt, to: query.prefixAt + INLINE_OFF.length, text: '', line: query.line });
		}
	}

	// Templater's dynamic command starts on its own, so it belongs here; the
	// plain one still waits for the reader and is left as it is.
	for (const fragment of document.templater) {
		// Two past the '<' is directly after "<%", which is where the marker has
		// to sit: Templater's pattern allows modifiers between "<%" and the '+',
		// so anything later could be stepped over.
		const at = fragment.offset + 2;

		if (direction === 'disarm') {
			if (!fragment.dynamic) continue;
			edits.push({ from: at, to: at, text: INLINE_OFF, line: fragment.line });
		} else {
			if (!fragment.off) continue;
			edits.push({ from: at, to: at + INLINE_OFF.length, text: '', line: fragment.line });
		}
	}

	// Remote sources in the prose. Fences are blanked out in `prose`, so an
	// <iframe> written inside a code sample is left alone — it is being shown,
	// not used.
	//
	// <object> and <embed> are switched off too even though Obsidian strips them
	// today (measured — see policy/html.ts). That allowlist is someone else's,
	// and a package installed now should not start loading remote documents the
	// day it changes.
	for (const tag of scanTags(document.prose)) {
		if (tag.name !== 'iframe' && tag.name !== 'object' && tag.name !== 'embed') continue;

		// <object> names its resource in `data`, not `src`. Parking only `src`
		// left the one tag whose attribute differs completely unprotected — and
		// forward defense that misses the actual attribute is not defense.
		for (const attr of REMOTE_ATTRS) {
			const from = direction === 'disarm' ? attr : offAttr(attr);
			const to = direction === 'disarm' ? offAttr(attr) : attr;
			if (!tag.attrs.has(from)) continue;

			const at = attributeSpan(text, tag.offset, tag.raw, from);
			if (at !== null) edits.push({ from: at.from, to: at.to, text: to, line: tag.line });
		}
	}

	return edits;
}

/** The switched-off spelling of a fence language, or null when it should stay as it is. */
function disarmedLang(fence: Fence): string | null {
	// Same test disarmedLanguages() applies, so the list switched off and the
	// list with a renderer stay one list.
	if (!renderable(fence.lang)) return null;

	const interpreter = interpreterFor(fence.lang);
	if (interpreter === null) return null;
	// Only what starts by itself. A Templater template or an Execute Code block
	// waits for the reader either way, so switching it off buys nothing.
	if (interpreter.trigger !== 'render' || !interpreter.js) return null;

	return fence.lang + DISARM_SUFFIX;
}

function armedLang(fence: Fence): string | null {
	if (!fence.lang.endsWith(DISARM_SUFFIX)) return null;

	// The same test disarmedLang() applies, not a looser one. interpreterFor()
	// answers with a synthesized "unrecognised block" for any language it does
	// not know, so asking merely whether it returns something would strip the
	// suffix off a reader's own ```mynotes-off fence that disarm never created.
	const original = fence.lang.slice(0, -DISARM_SUFFIX.length);
	const interpreter = interpreterFor(original);

	return interpreter !== null && interpreter.trigger === 'render' && interpreter.js ? original : null;
}

/** Where the language token sits on a fence's opening line. */
function langSpan(text: string, fenceOffset: number): { from: number; to: number } | null {
	const line = text.slice(fenceOffset, lineEnd(text, fenceOffset));
	const match = /^( {0,3})(`{3,}|~{3,})([ \t]*)(\S+)/.exec(line);
	if (match === null) return null;

	const from = fenceOffset + (match[1] ?? '').length + (match[2] ?? '').length + (match[3] ?? '').length;

	return { from, to: from + (match[4] ?? '').length };
}

/** Where an attribute's NAME sits, so only the name is rewritten and the value is untouched. */
function attributeSpan(text: string, tagOffset: number, raw: string, name: string): { from: number; to: number } | null {
	const match = new RegExp(`(^|[\\s"'/])(${name})\\s*=`, 'i').exec(raw);
	if (match === null) return null;

	const from = tagOffset + match.index + (match[1] ?? '').length;

	return { from, to: from + name.length };
}

/** Applies edits back to front, so earlier offsets stay valid. */
function apply(text: string, edits: Edit[]): string {
	let result = text;

	for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
		result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
	}

	return result;
}

/**
 * Switches a canvas off, and back on.
 *
 * A canvas is JSON whose `text` nodes hold Markdown, and Obsidian renders them
 * exactly like a note — so a ```dataviewjs block in one runs on opening the
 * canvas. disarm() cannot see it from the outside: inside the JSON the fence is
 * a string with escaped newlines, so the lexer finds no fence at all.
 */
export function disarmCanvas(text: string): string {
	return mapCanvas(text, disarm);
}

export function armCanvas(text: string): string {
	return mapCanvas(text, arm);
}

/**
 * Switches on the one canvas block whose code is `source`.
 *
 * armBlock() finds its block by line, which a canvas cannot provide —
 * getSectionInfo() answers null there because the Markdown lives inside JSON.
 * The block's own code is the only handle the rendered panel has, so that is
 * what identifies it.
 *
 * Matched as a switched-off fence whose body IS the code, never as a substring
 * of the node: both the node and the body are written by the package author, so
 * a plain indexOf could be pointed at a decoy copy one line below something else
 * and arm that instead — the reader would approve one block and start another.
 * An ambiguous match arms nothing, because there is no safe way to guess which
 * block the reader was looking at.
 */
export function armCanvasBlock(text: string, source: string): string {
	let armedOne = false;

	return mapCanvas(text, (node) => {
		if (armedOne) return node;

		const [fence, ...rest] = lex(node).fences.filter(
			(candidate) => candidate.lang.endsWith(DISARM_SUFFIX) && candidate.text === source,
		);
		if (fence === undefined || rest.length > 0) return node;

		armedOne = true;
		return armBlock(node, fence.line);
	});
}

/**
 * The lines disarm() actually switched something off in.
 *
 * The manifest reports one line per finding, so this is what lets a caller ask
 * "was THIS fragment neutralised" instead of "did this file change at all" —
 * one construct we know how to switch off must not vouch for one we do not.
 */
export function disarmedLines(text: string): Set<number> {
	return new Set(collect(text, 'disarm').map((edit) => edit.line));
}

/**
 * The same for a canvas, whose findings are numbered by the line inside the
 * node they came from — so the answer is the union over its text nodes.
 *
 * `undisarmable` reports a node that is not Markdown at all. A link card embeds
 * a remote page with no token to break, so nothing here can switch it off, and
 * saying so is the only honest answer.
 */
export function disarmedCanvasLines(text: string): { lines: Set<number>; undisarmable: boolean } {
	const lines = new Set<number>();
	let undisarmable = false;

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { lines, undisarmable: true };
	}

	const nodes = (parsed as { nodes?: unknown })?.nodes;
	if (!Array.isArray(nodes)) return { lines, undisarmable: false };

	for (const node of nodes) {
		const entry = node as { type?: unknown; text?: unknown };

		if (entry?.type === 'text' && typeof entry.text === 'string') {
			for (const line of disarmedLines(entry.text)) lines.add(line);
		} else if (entry?.type === 'link') {
			undisarmable = true;
		}
	}

	return { lines, undisarmable };
}

/**
 * Applies a text change to every canvas node that holds Markdown.
 *
 * Returns the input untouched when nothing changed, rather than re-serialising
 * it: JSON.stringify would rewrite the author's formatting, and an update would
 * then read every canvas in the package as edited by the reader.
 */
function mapCanvas(text: string, change: (node: string) => string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// The server refuses a canvas that is not JSON, so this is a local file
		// someone hand-edited. Leaving it alone beats throwing mid-install.
		return text;
	}

	const nodes = (parsed as { nodes?: unknown })?.nodes;
	if (!Array.isArray(nodes)) return text;

	let changed = false;
	for (const node of nodes) {
		const entry = node as { type?: unknown; text?: unknown };
		if (entry?.type !== 'text' || typeof entry.text !== 'string') continue;

		const next = change(entry.text);
		if (next === entry.text) continue;

		entry.text = next;
		changed = true;
	}

	return changed ? JSON.stringify(parsed) : text;
}

function bodyOffset(text: string, fenceOffset: number): number {
	return Math.min(text.length, lineEnd(text, fenceOffset) + 1);
}

function lineEnd(text: string, index: number): number {
	const found = text.indexOf('\n', index);

	return found === -1 ? text.length : found;
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;

	return line;
}
