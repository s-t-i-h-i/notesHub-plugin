import type { App, TFile } from 'obsidian';
import { extensionOf } from './verify';

/**
 * Resolves and rewrites package links and tags.
 *
 * - On publish: Resolves internal links using the author's vault metadata
 *   cache and makes them package-relative.
 * - On install: Prepends the target folder path to package-relative links,
 *   and optionally namespaces tags under a chosen prefix.
 */

/** A text replacement at a character range. */
export interface Edit {
	start: number;
	end: number;
	original: string;
	text: string;
}

/** Rewrites file content for installation. */
export type Localize = (path: string, data: Uint8Array) => Uint8Array;

/** Wikilink pattern: [[target]] or ![[target|size]]. */
const WIKI = /^(!?)\[\[([^[\]\n]+)\]\]$/;

/** Markdown link pattern: [text](target) or ![alt](target). */
const MD = /^(!?)\[([^\]]*)\]\(\s*<?([^)<>\s]*)>?\s*\)$/;

/** Global regexes matching wikilinks and markdown links in text. */
const WIKI_ALL = /(!?)\[\[([^[\]\n]+)\]\]/g;
const MD_ALL = /(!?)\[([^\]]*)\]\(\s*<?([^)<>\s]*)>?\s*\)/g;

/** Matches external URLs, schemes, or anchor-only links that should not be rewritten. */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Characters that must not reach a rewritten link. [ ] | # ^ break wikilink
 * syntax; ` $ = < > are inert in a path but not in a note, and the folder is
 * spliced in verbatim. Checked here as well as in toFolderName() because the
 * download folder is a free-text setting that never passes through it.
 */
const UNSAFE_ROOT = /[[\]|#^`$=<>]/;

/** Matches an Obsidian tag, excluding preceding word characters. */
const TAG = /(^|[^\p{L}\p{N}_/\\-])#([\p{L}\p{N}_/-]+)/gu;

/** Matches frontmatter block at the start of a file. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Characters stripped from tag prefixes to ensure valid tag syntax. */
const TAG_PREFIX_ALLOWED = /[^\p{L}\p{N}_-]+/gu;

/** Strict UTF-8 decoder. Throws if content is binary or non-UTF-8. */
const DECODER = new TextDecoder('utf-8', { fatal: true });
const ENCODER = new TextEncoder();

// ---------------------------------------------------------------- publishing

/**
 * Resolves internal links in a note using the author's vault cache and makes
 * them package-relative. Targets outside the package or broken links are skipped.
 */
export function resolveLinks(app: App, file: TFile, prefix: string, inPackage: Set<string>): Edit[] {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return [];

	const edits: Edit[] = [];
	for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
		const { path, subpath } = splitSubpath(ref.link);
		if (path === '') continue;

		const dest = app.metadataCache.getFirstLinkpathDest(path, file.path);
		if (dest === null || !inPackage.has(dest.path)) continue;

		const text = retarget(ref.original, dest.path.slice(prefix.length), subpath);
		if (text === null || text === ref.original) continue;

		edits.push({ start: ref.position.start.offset, end: ref.position.end.offset, original: ref.original, text });
	}

	return edits;
}

/**
 * Applies substitutions back to front to preserve offsets. Drops any edit
 * if the text at those offsets no longer matches the expected original.
 */
export function applyEdits(text: string, edits: Edit[]): string {
	let out = text;

	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		if (out.slice(edit.start, edit.end) !== edit.original) continue;
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
	}

	return out;
}

/**
 * Normalizes in-package links for a published file without modifying the author's vault.
 */
export function normalize(app: App, file: TFile, data: Uint8Array, prefix: string, inPackage: Set<string>): Uint8Array {
	const extension = extensionOf(file.path);
	if (extension !== 'md' && extension !== 'canvas') return data;

	return transform(data, (text) =>
		extension === 'canvas'
			? resolveCanvas(app, file, text, prefix, inPackage)
			: applyEdits(text, resolveLinks(app, file, prefix, inPackage)),
	);
}

/**
 * Rewrites file links and markdown text nodes within a canvas to be package-relative.
 */
export function resolveCanvas(app: App, file: TFile, text: string, prefix: string, inPackage: Set<string>): string {
	return mapCanvas(text, {
		file: (path) => (inPackage.has(path) ? path.slice(prefix.length) : null),
		text: (body) =>
			rewriteTargets(body, (linkpath) => {
				const dest = app.metadataCache.getFirstLinkpathDest(linkpath, file.path);

				return dest !== null && inPackage.has(dest.path) ? dest.path.slice(prefix.length) : null;
			}),
	});
}

// ------------------------------------------------------------------ installing

/**
 * Creates a transformer to rewrite package links and tags during installation
 * and update comparisons.
 */
export function localizer(root: string, paths: string[], tagPrefix: string): Localize {
	if (UNSAFE_ROOT.test(root)) return (_path, data) => data;

	const index = new Map(paths.map((path) => [path.toLowerCase(), path]));
	// Sanitize prefix to ensure valid tag syntax.
	const prefix = tagPrefix.replace(TAG_PREFIX_ALLOWED, '');

	const target = (linkpath: string): string | null => {
		const relative = index.get(linkpath.toLowerCase()) ?? index.get(`${linkpath.toLowerCase()}.md`);
		if (relative === undefined) return null;

		// Match case-insensitively and preserve whether .md extension was originally shown.
		return `${root}/${extensionOf(linkpath) === '' ? stripMd(relative) : relative}`;
	};

	return (path, data) => {
		const extension = extensionOf(path);
		if (extension !== 'md' && extension !== 'canvas') return data;

		return transform(data, (text) =>
			extension === 'canvas'
				? mapCanvas(text, { file: target, text: (body) => prefixTags(rewriteTargets(body, target), prefix) })
				: prefixTags(rewriteTargets(text, target), prefix),
		);
	};
}

/**
 * Decodes, rewrites, and re-encodes text. Returns original data if unchanged
 * or if decoding fails.
 */
function transform(data: Uint8Array, rewrite: (text: string) => string): Uint8Array {
	let text: string;
	try {
		text = DECODER.decode(data);
	} catch {
		return data;
	}

	const out = rewrite(text);

	return out === text ? data : ENCODER.encode(out);
}

/** Converts a package title into a valid tag segment (lowercase, slugified). */
export function tagSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(TAG_PREFIX_ALLOWED, '')
		// Stripping punctuation strands the dashes around it: "a `$= b" -> "a--b".
		// Only new installs slug a title, so collapsing here cannot move an
		// existing install's stored prefix out from under its files.
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

// --------------------------------------------------------------------- shared

/** Rewrites links whose targets are resolved by the callback. */
function rewriteTargets(text: string, resolve: (linkpath: string) => string | null): string {
	const edits: Edit[] = [];
	// A link inside a fence or a code span is a syntax example, not a link to
	// follow — rewriting it corrupts a note that documents Obsidian itself.
	// The publish side gets this free (the metadata cache skips code), so
	// without this the two ends of the same rewrite disagree.
	const masked = maskCode(text);

	for (const pattern of [WIKI_ALL, MD_ALL]) {
		// Create a fresh regex instance to avoid shared lastIndex state.
		const scan = new RegExp(pattern.source, pattern.flags);
		let match: RegExpExecArray | null;
		while ((match = scan.exec(text)) !== null) {
			// Scanned over the real text so the edit's `original` always matches;
			// the mask only answers "was this opening bracket inside code?".
			if (masked[match.index] !== text[match.index]) continue;

			const original = match[0];
			const raw = pattern === WIKI_ALL ? match[2] : match[3];
			if (raw === undefined || EXTERNAL.test(raw)) continue;

			const written = pattern === WIKI_ALL ? (raw.split('|')[0] ?? '') : decodeTarget(raw);
			const { path, subpath } = splitSubpath(written);
			if (path === '') continue;

			const relative = resolve(path);
			if (relative === null) continue;

			const replacement = retarget(original, relative, subpath);
			if (replacement === null || replacement === original) continue;

			edits.push({ start: match.index, end: match.index + original.length, original, text: replacement });
		}
	}

	return applyEdits(text, edits);
}

/**
 * Retargets a link to a relative path while preserving wikilink aliases,
 * embeds, and subpaths.
 */
function retarget(original: string, relative: string, subpath: string): string | null {
	const wiki = WIKI.exec(original);
	if (wiki !== undefined && wiki !== null) {
		const embed = wiki[1] ?? '';
		const body = wiki[2] ?? '';
		const pipe = body.indexOf('|');
		const path = stripMd(relative);
		// Only validate path; subpaths intentionally use '#' and '^'.
		if (UNSAFE_ROOT.test(path)) return null;

		const target = `${path}${subpath}`;
		if (embed === '!') return `![[${target}${pipe === -1 ? '' : body.slice(pipe)}]]`;

		// Nothing moved, so an alias would only repeat the target back.
		if (pipe === -1 && target === body) return original;

		// The alias carries what the reader saw before, or Obsidian would start
		// displaying the whole rewritten path. It repeats the body verbatim:
		// trimming the subpath off it would hide which heading was linked.
		const shown = pipe === -1 ? body : body.slice(pipe + 1);

		return `[[${target}|${shown}]]`;
	}

	const md = MD.exec(original);
	if (md !== null) return `${md[1] ?? ''}[${md[2] ?? ''}](${encodeTarget(`${relative}${subpath}`)})`;

	// Skip unrecognized link formats.
	return null;
}

/** Traverses canvas JSON nodes and rewrites file paths and text nodes. */
function mapCanvas(
	text: string,
	map: { file: (path: string) => string | null; text: (body: string) => string },
): string {
	let canvas: { nodes?: unknown[] };
	try {
		canvas = JSON.parse(text) as { nodes?: unknown[] };
	} catch {
		return text;
	}

	if (!Array.isArray(canvas.nodes)) return text;

	let changed = false;
	for (const node of canvas.nodes as Record<string, unknown>[]) {
		if (node === null || typeof node !== 'object') continue;

		if (node.type === 'file' && typeof node.file === 'string') {
			const moved = map.file(node.file);
			if (moved !== null && moved !== node.file) {
				node.file = moved;
				changed = true;
			}
			continue;
		}

		// Text nodes contain Markdown formatted strings.
		if (node.type === 'text' && typeof node.text === 'string') {
			const rewritten = map.text(node.text);
			if (rewritten !== node.text) {
				node.text = rewritten;
				changed = true;
			}
		}
	}

	return changed ? JSON.stringify(canvas) : text;
}

/** Splits a link target into path and #subpath. */
function splitSubpath(link: string): { path: string; subpath: string } {
	const hash = link.indexOf('#');

	return hash === -1 ? { path: link, subpath: '' } : { path: link.slice(0, hash), subpath: link.slice(hash) };
}

function stripMd(path: string): string {
	return extensionOf(path) === 'md' ? path.slice(0, -3) : path;
}

function decodeTarget(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		// Fallback to raw target if URI decoding fails.
		return target;
	}
}

/** Escapes parentheses in link targets to prevent breaking Markdown link syntax. */
function encodeTarget(target: string): string {
	return encodeURI(target).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// ----------------------------------------------------------------------- tags

/** Prefixes tags with a namespace in markdown text and frontmatter. */
function prefixTags(text: string, prefix: string): string {
	if (prefix === '') return text;

	const edits: Edit[] = [];
	const nest = (body: string, start: number) => {
		// Skip pure numbers, identical prefixes, or already nested tags.
		if (/^\d+$/.test(body) || body === prefix || body.startsWith(`${prefix}/`)) return;
		edits.push({ start, end: start + body.length, original: body, text: `${prefix}/${body}` });
	};

	const masked = maskCodeAndLinks(text);
	let match: RegExpExecArray | null;
	const scan = new RegExp(TAG.source, TAG.flags);
	while ((match = scan.exec(masked)) !== null) {
		const body = match[2];
		if (body !== undefined) nest(body, match.index + match[0].indexOf('#') + 1);
	}

	frontmatterTags(text, nest);

	return applyEdits(text, edits);
}

/** Rewrites tags declared in YAML frontmatter (list, inline array, or comma-separated). */
function frontmatterTags(text: string, nest: (body: string, start: number) => void): void {
	const block = FRONTMATTER.exec(text);
	if (block === null) return;

	const opening = /^---\r?\n/.exec(block[0]);
	const body = block[1];
	if (opening === null || body === undefined) return;

	let offset = opening[0].length;
	let inList = false;

	for (const line of body.split('\n')) {
		// \r? like the item pattern below: '.' does not match \r in JS.
		const key = /^(?:tags|tag)\s*:[ \t]*(.*)\r?$/.exec(line);
		const item = /^[ \t]*-[ \t]*(.*?)[ \t]*\r?$/.exec(line);
		const entry = item?.[1] ?? '';

		if (key !== null) {
			const rest = key[1] ?? '';
			// Empty value means tag items follow on subsequent lines.
			inList = rest === '';
			if (rest !== '') {
				const inline = /^\[(.*)\]$/.exec(rest);
				const list = inline?.[1];
				// `line` may still carry the \r that `rest` had stripped.
				const start = offset + line.replace(/\r$/, '').length - rest.length;
				nestList(list ?? rest, list === undefined ? start : start + 1, nest);
			}
		} else if (inList && entry !== '') {
			nestOne(entry, offset + line.indexOf(entry, line.indexOf('-')), nest);
		} else if (!/^[ \t]/.test(line)) {
			inList = false;
		}

		offset += line.length + 1;
	}
}

/** Rewrites a comma-separated list of tags at their respective offsets. */
function nestList(list: string, start: number, nest: (body: string, start: number) => void): void {
	let cursor = 0;
	for (const part of list.split(',')) {
		const item = part.trim();
		if (item !== '') nestOne(item, start + cursor + part.indexOf(item), nest);
		cursor += part.length + 1;
	}
}

/** Rewrites a single frontmatter tag entry. */
function nestOne(raw: string, start: number, nest: (body: string, start: number) => void): void {
	const quoted = /^(['"])(.*)\1$/.exec(raw);
	const body = quoted === null ? raw : (quoted[2] ?? '');
	if (body === '' || !/^[\p{L}\p{N}_/-]+$/u.test(body)) return;

	nest(body, quoted === null ? start : start + 1);
}

/** Blanks a run out, keeping its length so offsets stay put (see mine 45). */
const blank = (part: string) => ' '.repeat(part.length);

/**
 * Masks out code blocks and inline code with spaces to preserve exact
 * character offsets for later replacement.
 */
function maskCode(text: string): string {
	let fence = '';

	const lines = text.split('\n').map((line) => {
		const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line);

		const opened = marker?.[1];

		if (fence !== '') {
			if (opened !== undefined && opened[0] === fence[0] && opened.length >= fence.length) fence = '';

			return blank(line);
		}

		if (opened !== undefined) {
			fence = opened;

			return blank(line);
		}

		return line.replace(/`+[^`\n]*`+/g, blank);
	});

	return lines.join('\n');
}

/** maskCode() plus links, so a link's subpath '#' is not matched as a tag. */
function maskCodeAndLinks(text: string): string {
	return maskCode(text)
		.replace(new RegExp(WIKI_ALL.source, WIKI_ALL.flags), blank)
		.replace(new RegExp(MD_ALL.source, MD_ALL.flags), blank);
}
