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
 *   <iframe src=…>  ->  <iframe data-off-src=…>
 *
 * Dataview matches the language exactly, so `dataviewjs-off` runs nothing while
 * the code stays visible, character for character. There is no state to lose,
 * no record to keep in sync, and someone can undo it by hand in the editor if
 * this plugin is not around.
 *
 * Templater is NOT disarmed, on purpose. It runs when the reader invokes it,
 * not when a note is opened, and an install lands in the download folder rather
 * than a template folder. Disarming it would be friction with nothing behind it
 * — which is exactly what the old warning screen was.
 */

import { lex, type Fence } from './policy/lex';
import { scanTags } from './policy/html';
import { interpreterFor, selfStartingFences } from './policy/interpreters';

/** Appended to a fence language so no interpreter matches it. */
const DISARM_SUFFIX = '-off';

/** Attribute name a disarmed remote source is parked under. */
const OFF_ATTR = 'data-off-src';

interface Edit {
	from: number;
	to: number;
	text: string;
}

/**
 * Fence languages this plugin renders itself once they are switched off.
 *
 * Derived from the same table disarmedLang() consults, never listed by hand:
 * a language switched off with no processor registered for it renders as a
 * blank block with no way to turn it back on except editing the note.
 */
export function disarmedLanguages(): string[] {
	return selfStartingFences().map((lang) => lang + DISARM_SUFFIX);
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
				edits.push({ from: nested.from + body, to: nested.to + body, text: nested.text });
			}
			continue;
		}

		const target = direction === 'disarm' ? disarmedLang(fence) : armedLang(fence);
		if (target === null) continue;

		const span = langSpan(text, fence.offset);
		if (span !== null) edits.push({ from: span.from, to: span.to, text: target });
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

		const from = direction === 'disarm' ? 'src' : OFF_ATTR;
		const to = direction === 'disarm' ? OFF_ATTR : 'src';
		if (!tag.attrs.has(from)) continue;

		const at = attributeSpan(text, tag.offset, tag.raw, from);
		if (at !== null) edits.push({ from: at.from, to: at.to, text: to });
	}

	return edits;
}

/** The switched-off spelling of a fence language, or null when it should stay as it is. */
function disarmedLang(fence: Fence): string | null {
	const interpreter = interpreterFor(fence.lang);
	if (interpreter === null) return null;
	// Only what starts by itself. A Templater template or an Execute Code block
	// waits for the reader either way, so switching it off buys nothing.
	if (interpreter.trigger !== 'render' || !interpreter.js) return null;

	return fence.lang + DISARM_SUFFIX;
}

function armedLang(fence: Fence): string | null {
	if (!fence.lang.endsWith(DISARM_SUFFIX)) return null;

	const original = fence.lang.slice(0, -DISARM_SUFFIX.length);
	// Only switch on something we switched off: a language that happens to end
	// in "-off" on its own is left alone.
	return interpreterFor(original) === null ? null : original;
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
