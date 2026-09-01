/**
 * Tag-and-attribute scanner for HTML inside notes and for .svg files.
 *
 * Not a tree parser: nothing here needs nesting, only "which tags appear and
 * with which attributes". A tree would also invite us to reason about what the
 * browser will do with malformed markup, which is a guess either way.
 *
 * MEASURED, not assumed. Obsidian sanitises HTML before rendering, and guessing
 * which half survives produces a manifest that shouts about harmless markup and
 * stays quiet about the live parts — which teaches people to click past it. The
 * table below is what a probe note actually did in reading view: every
 * construct pointed at its own path on a local server, and script execution
 * reported itself by fetching too.
 *
 *   LIVE — fetches when the note is opened, so it leaks the reader's address:
 *     <img src>, <img srcset>, <source srcset>, <video poster>, markdown ![](…)
 *     <iframe src="http(s)">          — and renders a live remote page
 *     style="…url(https://…)"         — an attribute, and it looks like nothing
 *     inline <svg><image href="…">
 *
 *   INERT — removed by the sanitiser, nothing fetched, nothing ran:
 *     <script> and <script src>, in HTML and in inline SVG alike
 *     every on* handler (onerror and onload were given a real chance to fire)
 *     <object>, <embed>
 *     <style> blocks: both @import and url()
 *     <link rel="stylesheet">
 *     <foreignObject> contents
 *     <iframe srcdoc> and <iframe src="data:text/html,…">
 *     a .svg FILE embedded with ![[x.svg]] — its <script> AND its remote href,
 *     because Obsidian renders it through <img>, where neither is allowed
 *
 * This is one Obsidian version on one platform, and it is someone else's
 * allowlist. So the inert half is reported as 'inert' rather than dropped: the
 * finding is already in place if that allowlist ever changes.
 *
 * `javascript:` and `obsidian://` in an href are NOT in the table — they need a
 * click, which the probe could not deliver. They stay weighted as click-triggered.
 *
 * Shared verbatim between the worker and the plugin.
 */

import { type Capability, type Trigger, excerpt, hostOf } from './types';

export interface HtmlTag {
	/** Lowercased tag name. */
	name: string;
	/** Lowercased attribute names mapped to their raw values. */
	attrs: Map<string, string>;
	/** Text between this tag and its closer — only kept for <script> and <style>. */
	text: string;
	/** 1-based line the tag starts on. */
	line: number;
	/** Offset of the '<' in the text handed to scanTags — the disarm rewrite needs it. */
	offset: number;
	raw: string;
}

/** What a fragment of markup does, before it is tied to a file or a package. */
export interface HtmlEffect {
	capabilities: Capability[];
	trigger: Trigger;
	interpreter: string;
	hosts: string[];
	line: number;
	offset: number;
	sample: string;
}

/** Attributes that name a resource the renderer will fetch. */
const URL_ATTRS = ['src', 'href', 'xlink:href', 'data', 'poster', 'srcset', 'action', 'formaction'];

/**
 * Tags that put a live remote document inside the note.
 *
 * Only <iframe> — <object> and <embed> are stripped, measured. They are still
 * listed below so they are reported as inert rather than passing unmentioned.
 */
const EMBEDS = new Set(['iframe']);

/** Stripped before rendering: reported, but they carry no capability. */
const STRIPPED_TAGS = new Set(['script', 'object', 'embed', 'applet', 'frame', 'style', 'link', 'foreignobject']);

export function scanTags(text: string): HtmlTag[] {
	const tags: HtmlTag[] = [];
	let index = 0;
	let line = 1;

	while (index < text.length) {
		const char = text[index];

		if (char === '\n') {
			line++;
			index++;
			continue;
		}
		if (char !== '<') {
			index++;
			continue;
		}

		// Comments, doctypes and CDATA carry no attributes; skipping them
		// wholesale also stops "<!-- <script> -->" from being read as a tag.
		if (text.startsWith('<!--', index)) {
			index = skipTo(text, index, '-->');
			continue;
		}
		if (text.startsWith('<![CDATA[', index)) {
			index = skipTo(text, index, ']]>');
			continue;
		}
		if (text.startsWith('<!', index) || text.startsWith('<?', index)) {
			index = skipTo(text, index, '>');
			continue;
		}
		// A closing tag has no attributes of its own.
		if (text[index + 1] === '/') {
			index = skipTo(text, index, '>');
			continue;
		}
		if (!/[a-zA-Z]/.test(text[index + 1] ?? '')) {
			index++;
			continue;
		}

		const tag = readTag(text, index, line);
		if (tag === null) {
			index++;
			continue;
		}

		// Only <style>: its url() names a host worth reporting even though the
		// block itself is stripped before rendering.
		if (tag.tag.name === 'style') {
			const closer = text.toLowerCase().indexOf('</style', tag.end);
			tag.tag.text = text.slice(tag.end, closer === -1 ? text.length : closer);
		}

		tags.push(tag.tag);
		line += countNewlines(text.slice(index, tag.end));
		index = tag.end;
	}

	return tags;
}

/**
 * What the markup will do, tag by tag.
 *
 * Reported rather than judged: publishing is not blocked by any of this, so
 * the job here is an accurate description, not a verdict.
 */
export function analyzeTags(tags: HtmlTag[], svg: boolean): HtmlEffect[] {
	const effects: HtmlEffect[] = [];
	const add = (
		tag: HtmlTag,
		capabilities: Capability[],
		trigger: Trigger,
		interpreter: string,
		hosts: string[] = [],
	) => {
		effects.push({ capabilities, trigger, interpreter, hosts, line: tag.line, offset: tag.offset, sample: excerpt(tag.raw) });
	};

	for (const tag of tags) {
		const where = svg ? 'SVG' : 'HTML';

		// An .svg FILE is rendered through <img>, where scripts do not run and
		// remote references are not fetched. Measured: neither its <script> nor
		// its <image href> did anything.
		const passive: Capability[] = svg ? ['inert'] : ['network-passive'];

		if (STRIPPED_TAGS.has(tag.name)) {
			// A <style> block does not fetch, but the address it names still
			// says what the author meant to do, so it is kept on the finding.
			add(tag, ['inert'], 'render', where, cssHosts(tag.text));
			continue;
		}

		if (EMBEDS.has(tag.name)) {
			const source = tag.attrs.get('src') ?? '';
			// srcdoc and a data: source are both stripped; only an http(s) src
			// actually loads.
			const host = hostOf(source);
			if (host) add(tag, ['remote-embed'], 'render', 'Obsidian', [host]);
			else add(tag, ['inert'], 'render', 'Obsidian');
			continue;
		}

		for (const [name, value] of tag.attrs) {
			// on* handlers: onerror, onload, onclick... All stripped, measured
			// with handlers that had a real chance to fire.
			if (/^on[a-z]{3,15}$/.test(name)) {
				add(tag, ['inert'], 'render', where);
				continue;
			}

			// The style ATTRIBUTE survives and fetches. A <style> BLOCK does not
			// — that difference is exactly why this was measured rather than
			// reasoned about.
			if (name === 'style') {
				for (const host of cssHosts(value)) add(tag, passive, 'render', 'Obsidian', [host]);
				continue;
			}

			if (!URL_ATTRS.includes(name)) continue;

			// Not measured: both need a click, which the probe could not give
			// them. Weighted as click-triggered rather than dismissed.
			if (/^\s*javascript:/i.test(value)) {
				add(tag, ['js'], 'click', 'Obsidian');
			} else if (/^\s*data:text\/html/i.test(value)) {
				add(tag, ['inert'], 'render', 'Obsidian');
			} else if (/^\s*obsidian:\/\//i.test(value)) {
				// obsidian://advanced-uri can run commands and templates. This
				// is a click away from arbitrary execution, not a curiosity.
				add(tag, ['command'], 'click', 'Obsidian');
			} else {
				// srcset holds several candidates; each is a separate fetch.
				for (const candidate of value.split(',')) {
					const host = hostOf(candidate.trim().split(/\s+/)[0] ?? '');
					if (host) add(tag, passive, name === 'href' ? 'click' : 'render', 'Obsidian', [host]);
				}
			}
		}
	}

	return effects;
}

/** Hosts named by url(...) or @import inside CSS. */
function cssHosts(css: string): string[] {
	const hosts = new Set<string>();

	for (const match of css.matchAll(/url\(\s*['"]?([^'")]+)/gi)) {
		const host = hostOf(match[1] ?? '');
		if (host) hosts.add(host);
	}
	for (const match of css.matchAll(/@import\s+['"]([^'"]+)/gi)) {
		const host = hostOf(match[1] ?? '');
		if (host) hosts.add(host);
	}

	return [...hosts];
}

/** Reads one opening tag; returns null when it never closes. */
function readTag(text: string, start: number, line: number): { tag: HtmlTag; end: number } | null {
	// One accessor for the whole scan: reading past the end has to answer ''
	// rather than undefined, or every comparison below becomes a null check.
	const at = (index: number) => text[index] ?? '';

	let index = start + 1;
	let name = '';
	while (index < text.length && /[a-zA-Z0-9:-]/.test(at(index))) name += at(index++);

	const attrs = new Map<string, string>();

	for (;;) {
		while (index < text.length && /\s/.test(at(index))) index++;
		if (index >= text.length) return null;

		if (at(index) === '>') {
			index++;
			break;
		}
		if (at(index) === '/' && at(index + 1) === '>') {
			index += 2;
			break;
		}

		let attr = '';
		while (index < text.length && !/[\s=>/]/.test(at(index))) attr += at(index++);
		if (attr === '') {
			// Not something we can read as an attribute — give up on this tag
			// rather than guess our way through it.
			index++;
			continue;
		}

		while (index < text.length && /\s/.test(at(index))) index++;

		let value = '';
		if (at(index) === '=') {
			index++;
			while (index < text.length && /\s/.test(at(index))) index++;

			const quote = at(index);
			if (quote === '"' || quote === "'") {
				index++;
				while (index < text.length && at(index) !== quote) value += at(index++);
				index++;
			} else {
				while (index < text.length && !/[\s>]/.test(at(index))) value += at(index++);
			}
		}

		attrs.set(attr.toLowerCase(), value);
	}

	return {
		tag: { name: name.toLowerCase(), attrs, text: '', line, offset: start, raw: text.slice(start, index) },
		end: index,
	};
}

function skipTo(text: string, index: number, marker: string): number {
	const found = text.indexOf(marker, index);

	return found === -1 ? text.length : found + marker.length;
}

function countNewlines(text: string): number {
	let count = 0;
	for (const char of text) if (char === '\n') count++;

	return count;
}
