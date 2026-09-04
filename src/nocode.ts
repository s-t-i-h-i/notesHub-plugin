/**
 * NO-CODE SECURITY SCANNER (Zero-Code Publish Gate)
 *
 * Core rule: A shared package in the marketplace must NEVER contain executable code.
 *
 * Why an Allowlist instead of a Denylist?
 * If we try to maintain a blacklist of dangerous plugins or syntax (like `dataviewjs`),
 * a plugin created tomorrow with a new syntax could slip past undetected.
 * Instead, we use an ALLOWLIST of known safe, inert languages (plain text, markdown,
 * syntax-highlighted programming languages).
 * Any unknown or executable code fence is immediately refused.
 *
 * A false alarm costs an author one minor edit; a missed vulnerability exposes
 * readers' vaults to arbitrary code execution.
 *
 * Shared verbatim between the Cloudflare Worker backend and the Obsidian plugin.
 */

import { extensionOf } from './verify';

// ============================================================================
// 1. TYPES AND ERROR CLASSES
// ============================================================================

/** Custom error thrown when executable content or malformed files are encountered. */
export class CodeError extends Error {}

/**
 * Describes a single security finding ("hit") in a scanned file.
 */
export interface Hit {
	/** Line number in the file (1-indexed). */
	line: number;

	/** The category of prohibited content that was found. */
	kind:
		| 'fence'              // Disallowed code fence language (e.g. ```dataviewjs)
		| 'unterminated-fence' // A code fence that opened but was never closed
		| 'templater'          // Templater execution tag (e.g. <% tp.file.title %>)
		| 'dataview-inline'    // Inline Dataview JS expression (e.g. `$= ...`)
		| 'raw-code'           // Raw HTML <code> tag (which Dataview executes as inline query)
		| 'entity'             // Character entity that could obfuscate links/commands (e.g. &#36;=)
		| 'html'               // Executable HTML elements (<script>, <iframe>, <object>, <embed>)
		| 'html-event'         // HTML event handlers (e.g. onerror=, onclick=)
		| 'link-scheme'        // Dangerous URI schemes (e.g. javascript:, obsidian://)
		| 'mermaid-click'      // Interactive click callback inside a Mermaid diagram
		| 'excalidraw'         // Excalidraw drawing containing script metadata
		| 'canvas-link';       // Obsidian Canvas node embedding an external website

	/** The name of the code fence language (lowercased), only set when kind is 'fence'. */
	lang?: string;

	/** The index of the canvas node containing this hit (for .canvas files). */
	node?: number;
}

/** State tracked for an active code fence block while parsing line by line. */
interface StackFrame {
	/** The opening delimiter characters (e.g. "```" or "~~~"). */
	marker: string;

	/**
	 * How to scan the contents inside this fence:
	 * - 'skip': Opaque code block (e.g. ```python) - inner lines are syntax-highlighted text only.
	 * - 'markdown': Admonition / callout (e.g. ```ad-note) - inner lines contain markdown to be scanned.
	 * - 'mermaid': Mermaid diagram (```mermaid) - only scanned for interactive click actions.
	 */
	scan: 'skip' | 'markdown' | 'mermaid';

	/** Blockquote nesting depth (number of '>' characters) where this fence opened. */
	quotes: number;

	/** Column indentation where this fence opened. */
	indent: number;
}

/** Details about blockquote depth and indentation at the start of a line. */
interface ContainerPrefix {
	/** Number of blockquote markers ('>'). */
	quotes: number;
	/** Number of leading whitespace columns (spaces count as 1, tabs count as 4). */
	indent: number;
	/** Total character length of the container prefix on this line. */
	length: number;
}

// ============================================================================
// 2. SCANNING BUDGETS & BOUNDS
// ============================================================================

/** File extensions checked by the scanner. Images cannot execute, so opening them is unnecessary. */
const SCANNABLE_EXTENSIONS = ['md', 'canvas', 'svg'];

/** Maximum number of findings recorded per file to prevent unbounded memory growth. */
const MAX_HITS_PER_FILE = 500;

/** Maximum nodes/edges allowed in a single .canvas file. */
const MAX_CANVAS_NODES = 2000;

/** Maximum nesting depth for objects/arrays inside a canvas node. */
//! zrozumiec to
const MAX_CANVAS_DEPTH = 8;

/** Maximum number of problem locations reported in a single refusal message to the author. */
const MAX_REPORTED_PROBLEMS = 20;

/**
 * Determines whether a file needs security scanning based on its extension.
 */
export function isScannable(path: string): boolean {
	return SCANNABLE_EXTENSIONS.includes(extensionOf(path));
}

// ============================================================================
// 3. ALLOWLIST OF SAFE (INERT) CODE FENCE LANGUAGES
// ============================================================================

/**
 * Languages that ONLY color text and never execute scripts.
 *
 * Any language NOT listed here is automatically refused at publish time.
 * This guarantees that new plugins or unknown executable environments cannot slip through.
 */
const INERT = new Set([
	// Plain text & documentation
	'text', 'plain', 'plaintext', 'txt', 'md', 'markdown',

	// Configuration, data formats, and styles
	'json', 'json5', 'yaml', 'yml', 'toml', 'ini', 'xml',
	'html', 'css', 'scss', 'sass', 'less', 'sql', 'graphql', 'diff', 'patch', 'csv', 'log', 'http', 'json-ld',

	// Programming and scripting languages (inert code samples)
	'js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx',
	'python', 'py', 'ruby', 'rb', 'php', 'perl', 'lua', 'r', 'julia',
	'bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'bat', 'dockerfile', 'makefile', 'nix',
	'c', 'h', 'cpp', 'cxx', 'cs', 'csharp', 'java', 'kotlin', 'scala', 'swift', 'objc', 'go', 'rust', 'rs',
	'dart', 'elixir', 'erlang', 'haskell', 'clojure', 'lisp', 'ocaml', 'fsharp', 'zig', 'asm',
	'latex', 'tex', 'bibtex', 'vim', 'regex', 'ebnf', 'gitignore', 'properties', 'protobuf',

	// Read-only vault query blocks:
	// These read notes and display formatted tables or lists, but cannot run arbitrary JS.
	'dataview', 'tasks', 'query',

	// Safe input field binding (Meta Bind):
	// NOTE: `meta-bind-button` is intentionally excluded because clicking a button can run
	// arbitrary Obsidian commands (and execute code via other plugins).
	'meta-bind',
]);

// ============================================================================
// 4. DETECTION PATTERNS (REGULAR EXPRESSIONS)
// ============================================================================
//! zrozumiec dokladniej

/** Matches container prefixes: spaces/tabs and blockquote markers ('>'). */
const CONTAINER = /^[ \t]*(?:>[ \t]*)*/;

/** Matches opening or closing code fence markers (3+ backticks or tildes). */
const FENCE = /^(`{3,}|~{3,})[ \t]*(.*)$/;

/** Matches Obsidian Admonition / callout blocks (e.g. ```ad-note, ```ad-warning). */
const ADMONITION = /^ad-[a-z0-9-]+$/;

/** Matches interactive click handlers in Mermaid diagrams (e.g. `click A callback`). */
const MERMAID_CLICK = /^\s*click\s+\S/;

/**
 * Matches HTML attribute lists safely up to the closing `>`.
 * Handles quoted strings (single or double) and unquoted runs, stopping at `<`
 * to avoid quadratic regular expression backtracking.
 */
const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'<])*`;

/**
 * RAW PATTERNS: Checked against the entire raw file.
 * Templater post-processors run on rendered DOM text regardless of whether they
 * sit in paragraphs, code spans, or code blocks. Therefore, Templater tags cannot
 * be hidden inside fences.
 */
const RAW: [RegExp, Hit['kind']][] = [
	// Standard Templater syntax: <% ... %>
	[/<%/, 'templater'],

	// HTML entity encoded Templater syntax: &lt;% or &#60;%
	[/&(?:lt|#0*60|#[xX]0*3[cC]);%/, 'templater'],
];

/**
 * PROSE PATTERNS: Checked against prose text (where safe code block bodies are blanked out).
 */
const PROSE: [RegExp, Hit['kind']][] = [
	// Inline Dataview JS: `$= ...`
	[/`\s*\$=/, 'dataview-inline'],

	// Raw HTML <code> tags: Dataview reads decoded text of any <code> element, so
	// <code>$= ...</code> or <code>&#36;= ...</code> runs code.
	[/<code\b/i, 'raw-code'],

	// Active or embedding HTML tags
	[/<(script|iframe|object|embed)\b/i, 'html'],

	// HTML event handlers (e.g. <img onerror="..."), allowing space or slash before `on`
	[new RegExp(`<[a-z][a-z0-9-]*${ATTRS}[\\s/]on[a-z]+\\s*=`, 'i'), 'html-event'],

	// Dangerous URI schemes in Markdown links: [click](javascript:...) or [run](obsidian://...)
	[/]\(\s*(?:obsidian:\/\/|javascript:)/i, 'link-scheme'],

	// Dangerous URI schemes in HTML attributes: href="javascript:..." or href="obsidian://..."
	[/href\s*=\s*["']?\s*(?:obsidian:\/\/|javascript:)/i, 'link-scheme'],

	// Dangerous URI schemes in autolinks: <javascript:...> or <obsidian://...>
	[/<(?:obsidian:\/\/|javascript:)/i, 'link-scheme'],

	// Dangerous URI schemes in link reference definitions: [label]: obsidian://...
	[/\]:\s*(?:obsidian:\/\/|javascript:)/i, 'link-scheme'],
];

/**
 * Character references that could encode forbidden link schemes.
 */
const ENTITY: [RegExp, Hit['kind']][] = [
	[/&#\d{1,7};|&#[xX][0-9a-fA-F]{1,6};|&(?:colon|sol);/, 'entity'],
];

/** Matches Excalidraw plugin metadata in markdown frontmatter or body. */
const EXCALIDRAW = /^excalidraw-plugin\s*:/m;

// ============================================================================
// 5. TEXT PROCESSING & CONTAINER HELPERS
// ============================================================================

/**
 * Normalizes all line endings (CRLF -> LF) so regexes behave consistently across OSes.
 */
function normalise(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/**
 * Replaces a string with space characters of identical byte length.
 * Used to blank out code fences while keeping exact character offsets and line numbers.
 */
function blank(line: string): string {
	return ' '.repeat(line.length);
}

/**
 * Analyzes the container prefix (blockquotes and indentations) at the start of a line.
 */
function containerOf(rawLine: string): ContainerPrefix {
	const prefixMatch = CONTAINER.exec(rawLine)?.[0] ?? '';
	let quotes = 0;
	let indent = 0;
	let afterQuote = false;

	for (const char of prefixMatch) {
		if (char === '>') {
			quotes++;
			indent = 0;
			afterQuote = true;
			continue;
		}

		// A single space right after `>` is part of the blockquote delimiter, not an indent
		if (afterQuote && char === ' ') {
			afterQuote = false;
			continue;
		}
		afterQuote = false;

		// Tabs count as 4 columns in CommonMark
		indent += char === '\t' ? 4 : 1;
	}

	return { quotes, indent, length: prefixMatch.length };
}

/**
 * Determines whether a line has exited the container in which a code fence was opened.
 * For instance, a blockquote fence `> ``` ` must terminate if the blockquote ends.
 */
function escapes(frame: StackFrame, container: ContainerPrefix, rawLine: string): boolean {
	if (container.quotes === 0 && rawLine.trim() === '') {
		return frame.quotes > 0;
	}

	return container.quotes < frame.quotes || container.indent < frame.indent;
}

/**
 * Extracts fence information (marker and language) from a line, ignoring container prefixes.
 */
function fenceOf(rawLine: string, prefixLength: number): { marker: string; lang: string } | null {
	const content = rawLine.slice(prefixLength);
	const match = FENCE.exec(content);
	if (!match) return null;

	const marker = match[1] ?? '';
	const info = (match[2] ?? '').trim();

	// In CommonMark, a backtick fence info string cannot contain a backtick.
	// This prevents inline code spans at the start of a line from masquerading as fence openers.
	if (marker.startsWith('`') && info.includes('`')) {
		return null;
	}

	const lang = (info.split(/\s+/)[0] ?? '').toLowerCase();
	return { marker, lang };
}

/**
 * Computes an array of character offsets where each line begins.
 */
function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
		starts.push(i + 1);
	}
	return starts;
}

/**
 * Converts a character index into a 1-based line number using binary search.
 */
function lineAt(starts: number[], index: number): number {
	let low = 0;
	let high = starts.length - 1;

	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if ((starts[mid] as number) <= index) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}

	return low + 1;
}

/**
 * Finds all regex matches in text and records their line numbers into the hits array.
 */
function matchAll(
	text: string,
	starts: number[],
	pattern: RegExp,
	kind: Hit['kind'],
	hits: Hit[],
): void {
	const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
	const scan = new RegExp(pattern.source, flags);

	let found: RegExpExecArray | null;
	while ((found = scan.exec(text)) !== null && hits.length < MAX_HITS_PER_FILE) {
		const line = lineAt(starts, found.index);
		hits.push({ line, kind });

		if (found.index === scan.lastIndex) {
			scan.lastIndex++;
		}
	}
}

// ============================================================================
// 6. CORE SCANNER: MARKDOWN & CODE BLOCKS
// ============================================================================

/**
 * Scans markdown text for executable code, disallowed fences, and dangerous tags.
 *
 * Algorithm overview:
 * 1. Line-by-line pass: Tracks fences (`stack: StackFrame[]`). Safe opaque code block
 *    bodies are blanked out with spaces. Unsafe fences and invalid mermaid interactions
 *    are recorded immediately.
 * 2. Raw scan: Looks for Templater tags (<% ... %>) across the entire unblanked text.
 * 3. Prose scan: Looks for inline Dataview JS, raw <code>, and active HTML in the blanked text.
 */
export function scanCode(source: string): Hit[] {
	const text = normalise(source);
	const hits: Hit[] = [];
	const lines = text.split('\n');
	const proseLines: string[] = [];
	const stack: StackFrame[] = [];

	lines.forEach((rawLine, index) => {
		const line = index + 1;
		const container = containerOf(rawLine);

		// If the line escaped the container (e.g. blockquote ended), pop frames
		while (stack.length > 0 && escapes(stack[stack.length - 1] as StackFrame, container, rawLine)) {
			stack.pop();
		}

		const top = stack[stack.length - 1];
		const fence = fenceOf(rawLine, container.length);

		if (fence) {
			const makeFrame = (scan: StackFrame['scan']): StackFrame => ({
				marker: fence.marker,
				scan,
				quotes: container.quotes,
				indent: container.indent,
			});

			// Check if this line is closing an existing fence
			const isClosingFence =
				top &&
				fence.lang === '' &&
				fence.marker[0] === top.marker[0] &&
				fence.marker.length >= top.marker.length;

			if (isClosingFence) {
				stack.pop();
				proseLines.push(blank(rawLine));
				return;
			}

			// Inside an opaque code block, a fence line is merely code content, not real markup
			if (top && top.scan !== 'markdown') {
				proseLines.push(blank(rawLine));
				return;
			}

			// Opening a new fence
			if (fence.lang === '') {
				stack.push(makeFrame('skip'));
			} else if (ADMONITION.test(fence.lang)) {
				// Admonitions contain markdown, so we must scan their contents
				stack.push(makeFrame('markdown'));
			} else if (fence.lang === 'mermaid') {
				stack.push(makeFrame('mermaid'));
			} else {
				// Verify language against the inert allowlist
				if (!INERT.has(fence.lang) && hits.length < MAX_HITS_PER_FILE) {
					hits.push({ line, kind: 'fence', lang: fence.lang });
				}
				stack.push(makeFrame('skip'));
			}

			proseLines.push(blank(rawLine));
			return;
		}

		// Inside a Mermaid diagram, check for forbidden click interactions
		if (top && top.scan === 'mermaid') {
			const contentAfterContainer = rawLine.slice(container.length);
			if (MERMAID_CLICK.test(contentAfterContainer) && hits.length < MAX_HITS_PER_FILE) {
				hits.push({ line, kind: 'mermaid-click' });
			}
			proseLines.push(blank(rawLine));
			return;
		}

		// Inside an opaque code block, blank the line to hide it from the prose scan
		if (top && top.scan === 'skip') {
			proseLines.push(blank(rawLine));
			return;
		}

		// Top-level markdown or inside an admonition
		proseLines.push(rawLine);
	});

	// If any fence remained open at the end of the file, refuse the file
	if (stack.length > 0) {
		hits.push({ line: lines.length, kind: 'unterminated-fence' });
	}

	const starts = lineStarts(text);

	// Pass 1: Raw scan (catches Templater everywhere)
	for (const [pattern, kind] of RAW) {
		matchAll(text, starts, pattern, kind, hits);
	}

	// Pass 2: Prose scan (catches inline Dataview, HTML tags, and suspicious links)
	const blankedProse = proseLines.join('\n');
	for (const [pattern, kind] of [...PROSE, ...ENTITY]) {
		matchAll(blankedProse, starts, pattern, kind, hits);
	}

	return hits.sort((a, b) => a.line - b.line);
}

/**
 * Scans a markdown document, including checking for Excalidraw script metadata.
 */
function scanMarkdown(text: string): Hit[] {
	const hits: Hit[] = EXCALIDRAW.test(text) ? [{ line: 1, kind: 'excalidraw' }] : [];
	return hits.concat(scanCode(text));
}

// ============================================================================
// 7. CORE SCANNER: CANVAS & SVG
// ============================================================================

/**
 * Scans an Obsidian Canvas (.canvas) JSON document.
 * Checks for external link cards (which act like iframes) and inspects text within nodes.
 */
function scanCanvas(text: string): Hit[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new CodeError('The canvas is not valid JSON');
	}

	const doc = parsed as { nodes?: unknown; edges?: unknown };
	const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
	const edges = Array.isArray(doc?.edges) ? doc.edges : [];

	if (nodes.length + edges.length > MAX_CANVAS_NODES) {
		throw new CodeError(
			`The canvas holds more than ${MAX_CANVAS_NODES} nodes, which is more than can be checked. Split it up.`,
		);
	}

	const hits: Hit[] = [];

	/** Recursively scans all string properties inside an object or array */
	const scanStringsRecursively = (holder: unknown, nodeIndex: number | undefined, depth: number): void => {
		if (holder === null || typeof holder !== 'object' || hits.length >= MAX_HITS_PER_FILE) {
			return;
		}

		if (depth > MAX_CANVAS_DEPTH) {
			throw new CodeError(
				`The canvas nests deeper than ${MAX_CANVAS_DEPTH} levels, which is more than can be checked. Simplify it.`,
			);
		}

		for (const value of Object.values(holder as Record<string, unknown>)) {
			if (typeof value === 'string') {
				const markdownHits = scanMarkdown(value);
				for (const hit of markdownHits) {
					hits.push({ ...hit, node: nodeIndex });
				}
			} else {
				scanStringsRecursively(value, nodeIndex, depth + 1);
			}
		}
	};

	// Scan nodes
	nodes.forEach((node: unknown, index) => {
		if ((node as { type?: unknown } | null)?.type === 'link') {
			hits.push({ line: 1, kind: 'canvas-link', node: index });
		}
		scanStringsRecursively(node, index, 0);
	});

	// Scan edges
	edges.forEach((edge: unknown, index) => {
		scanStringsRecursively(edge, index, 0);
	});

	// Scan any root-level custom or extra properties
	const rootExtra: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
	if (Array.isArray(doc?.nodes)) delete rootExtra.nodes;
	if (Array.isArray(doc?.edges)) delete rootExtra.edges;
	scanStringsRecursively(rootExtra, undefined, 0);

	return hits;
}

/**
 * Scans an SVG file for embedded scripts, event handlers, and dangerous tags.
 */
function scanSvg(source: string): Hit[] {
	const text = normalise(source);
	const hits: Hit[] = [];
	const starts = lineStarts(text);

	for (const [pattern, kind] of [...RAW, ...PROSE]) {
		matchAll(text, starts, pattern, kind, hits);
	}

	return hits.sort((a, b) => a.line - b.line);
}

/**
 * Dispatches scanning to the appropriate scanner according to file extension.
 */
export function scanFile(path: string, text: string): Hit[] {
	const extension = extensionOf(path);
	if (extension === 'canvas') return scanCanvas(text);
	if (extension === 'svg') return scanSvg(text);

	return scanMarkdown(text);
}

// ============================================================================
// 8. PUBLIC API & HUMAN-READABLE REPORTING
// ============================================================================

/**
 * Translates a Hit violation into a clear, human-readable Polish/English message.
 */
export function describeHit(hit: Hit): string {
	switch (hit.kind) {
		case 'fence':
			return `block \`${hit.lang}\` is not inert`;
		case 'unterminated-fence':
			return 'a code fence is never closed, so the rest of the file cannot be checked';
		case 'link-scheme':
			return 'a link that runs a command';
		case 'templater':
			return 'Templater command';
		case 'dataview-inline':
			return 'inline Dataview JS';
		case 'raw-code':
			return 'raw <code> HTML, which Dataview reads as an inline query';
		case 'entity':
			return 'a character reference, which can spell a link that runs a command';
		case 'mermaid-click':
			return 'Mermaid click handler';
		case 'excalidraw':
			return 'Excalidraw drawing';
		case 'canvas-link':
			return 'canvas card embedding a remote page';
		case 'html-event':
			return 'HTML event handler';
		default:
			return 'HTML that runs or embeds';
	}
}

/**
 * Formats a Hit into a specific file and line identifier (e.g. "note.md:15" or "canvas.canvas node 2:1").
 */
export function locateHit(path: string, hit: Hit): string {
	return hit.node === undefined ? `${path}:${hit.line}` : `${path} node ${hit.node}:${hit.line}`;
}

/**
 * Returns an array of human-readable problem descriptions found in a file.
 */
export function problemsIn(path: string, text: string): string[] {
	return scanFile(path, text).map((hit) => `${locateHit(path, hit)} — ${describeHit(hit)}`);
}

/**
 * Formats a comprehensive refusal error message for the whole package.
 */
export function refusal(problems: string[]): string {
	const displayed = problems.slice(0, MAX_REPORTED_PROBLEMS).join('\n');
	const remaining = problems.length - MAX_REPORTED_PROBLEMS;

	return `This package may not contain anything that runs by itself:\n${displayed}${
		remaining > 0 ? `\n...and ${remaining} more` : ''
	}`;
}

/**
 * The publish gate check for a single file. Throws a CodeError if any violations exist.
 */
export function assertNoCode(path: string, text: string): void {
	const problems = problemsIn(path, text);
	if (problems.length > 0) {
		throw new CodeError(refusal(problems));
	}
}
