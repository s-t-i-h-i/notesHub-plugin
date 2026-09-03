/**
 * Who runs what, and when.
 *
 * One table, one line per plugin, so adding an interpreter is data rather than
 * a new branch somewhere in the analysis.
 *
 * The `trigger` column is the one the old scanner did not have. It flattened
 * everything into 'danger', which put a ```dataviewjs block — code that starts
 * the moment a note is opened — next to a Templater template that does nothing
 * until someone runs it on purpose. Keeping them apart is what lets a package
 * ship both without the warning screen turning into noise.
 *
 * Shared verbatim between the worker and the plugin.
 */

import type { Capability, Trigger } from './types';

export interface Interpreter {
	/** A name the reader can act on: "Dataview", not "code block". */
	name: string;
	trigger: Trigger;
	/** Whether the block body is JavaScript worth handing to the parser. */
	js: boolean;
	/** Granted by the interpreter itself, whatever the body turns out to say. */
	base: Capability[];
	/** The body is Markdown in its own right and has to be read again. */
	nested?: boolean;
}

const FENCES: Record<string, Interpreter> = {
	dataviewjs: { name: 'Dataview', trigger: 'render', js: true, base: [] },
	'jsx:': { name: 'Dataview', trigger: 'render', js: true, base: [] },
	'js-engine': { name: 'JS Engine', trigger: 'render', js: true, base: [] },
	'meta-bind-js': { name: 'Meta Bind', trigger: 'render', js: true, base: [] },
	'meta-bind-button': { name: 'Meta Bind', trigger: 'click', js: false, base: ['command'] },
	customjs: { name: 'CustomJS', trigger: 'render', js: true, base: [] },

	// A DQL query is not JavaScript and cannot execute anything. Refusing it
	// would be exactly the pointless restriction we set out to avoid — but it
	// does read the whole vault, and that belongs in the manifest.
	dataview: { name: 'Dataview', trigger: 'render', js: false, base: ['vault-read'] },
	tasks: { name: 'Tasks', trigger: 'render', js: false, base: ['vault-read'] },
	query: { name: 'Obsidian', trigger: 'render', js: false, base: ['vault-read'] },

	mermaid: { name: 'Mermaid', trigger: 'render', js: false, base: [] },
};

/**
 * Appended to a fence language to switch it off. Lives here because both the
 * suffix and the table it applies to have to agree on what it means.
 */
export const DISARM_SUFFIX = '-off';

/** Execute Code runs the block through a real interpreter on the reader's machine. */
const EXECUTE_CODE = /^run-[a-z0-9+#-]+$/;

/** Admonition blocks hold Markdown, so whatever is nested inside them runs too. */
const ADMONITION = /^ad-[a-z0-9-]+$/;

/**
 * Languages that only ever colour text.
 *
 * Without this list every ```python and ```json sample would be reported as an
 * unrecognised interpreter — and a manifest that shouts about ordinary code
 * samples teaches people to click past the entry that mattered. Being wrong
 * here costs a false alarm, never a miss, because anything absent is reported.
 */
const HIGHLIGHT_ONLY = new Set([
	'text', 'plain', 'plaintext', 'txt', 'md', 'markdown', 'json', 'json5', 'yaml', 'yml', 'toml', 'ini', 'xml',
	'html', 'css', 'scss', 'sass', 'less', 'sql', 'graphql', 'diff', 'patch', 'csv', 'log', 'http',
	'js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'json-ld',
	'python', 'py', 'ruby', 'rb', 'php', 'perl', 'lua', 'r', 'julia',
	'bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'bat', 'dockerfile', 'makefile', 'nix',
	'c', 'h', 'cpp', 'cxx', 'cs', 'csharp', 'java', 'kotlin', 'scala', 'swift', 'objc', 'go', 'rust', 'rs',
	'dart', 'elixir', 'erlang', 'haskell', 'clojure', 'lisp', 'ocaml', 'fsharp', 'zig', 'asm',
	'latex', 'tex', 'bibtex', 'vim', 'regex', 'ebnf', 'gitignore', 'properties', 'protobuf',
]);

/** Frontmatter keys that change what the whole file is. */
const FRONTMATTER: [RegExp, Interpreter][] = [
	[
		/^excalidraw-plugin\s*:/m,
		// An Excalidraw drawing lives inside a .md file and can carry Script
		// elements, so the same extension means a different interpreter.
		{ name: 'Excalidraw', trigger: 'render', js: false, base: ['js'] },
	],
];

/**
 * The interpreter for a fence's info string.
 *
 * An unknown language is NOT silently safe: some plugin may execute it
 * tomorrow, and the reader is better told that we don't recognise it than left
 * to assume we approved it.
 */
export function interpreterFor(lang: string): Interpreter | null {
	if (lang === '') return null;

	const known = FENCES[lang];
	if (known) return known;

	// A switched-off block still ships its code, and the suffix is not ours
	// alone — an author can write ```dataviewjs-off themselves. Describing it as
	// an unrecognised block gave it no capabilities at all, so a package whose
	// only content was a pre-disarmed block advertised itself as doing nothing
	// while offering a one-click button to run it. Reported as what it is: the
	// same interpreter, waiting on a click instead of starting by itself.
	if (lang.endsWith(DISARM_SUFFIX)) {
		const armed = FENCES[lang.slice(0, -DISARM_SUFFIX.length)];
		if (armed && armed.trigger === 'render' && armed.js) return { ...armed, trigger: 'click' };
	}

	if (EXECUTE_CODE.test(lang)) {
		return { name: 'Execute Code', trigger: 'click', js: lang === 'run-js', base: ['native'] };
	}
	if (ADMONITION.test(lang)) {
		// A ```dataviewjs block nested inside an admonition runs exactly as it
		// would outside one, so the body has to be read as Markdown again.
		return { name: 'Admonition', trigger: 'render', js: false, base: [], nested: true };
	}
	if (HIGHLIGHT_ONLY.has(lang)) return null;

	return { name: `unrecognised block (${lang})`, trigger: 'render', js: false, base: [] };
}

/**
 * Fence languages that run JavaScript the moment a note is opened.
 *
 * The one list the plugin switches off and the one it registers a renderer for
 * have to be the same list, or a block gets disabled with nothing to draw it —
 * a blank panel with no way back except editing the note by hand. Derived from
 * the table rather than written out beside it.
 */
export function selfStartingFences(): string[] {
	return Object.entries(FENCES)
		.filter(([, interpreter]) => interpreter.trigger === 'render' && interpreter.js)
		.map(([lang]) => lang);
}

export function frontmatterInterpreter(frontmatter: string): Interpreter | null {
	for (const [pattern, interpreter] of FRONTMATTER) {
		if (pattern.test(frontmatter)) return interpreter;
	}

	return null;
}

/**
 * Mermaid's `click` directive turns a diagram node into a link or a callback.
 * Nothing else in a diagram runs, so the rest of the syntax is left alone.
 */
export function mermaidClicks(body: string): boolean {
	return /^\s*click\s+\S/m.test(body);
}
