/**
 * Scans package files for "active" content — code that runs when a note is
 * opened. Obsidian itself doesn't execute JS from notes, but plugins do:
 * a ```dataviewjs block or a Templater `<%* %>` command is basically eval
 * with full app access (the whole vault, plus the network), and it looks
 * exactly like any other note until you open it.
 *
 * This is a heuristic scanner, so it can false-positive — it warns instead
 * of blocking, and leaves the decision to the person who can tell whether
 * they wrote that dataviewjs block themselves.
 */

export type Severity = 'danger' | 'warning';

export interface Finding {
	/** File path inside the package. */
	path: string;
	severity: Severity;
	/** Short, user-facing name for the risk. */
	label: string;
	/** The snippet that triggered the match, so the user can judge it themselves. */
	sample: string;
}

interface Rule {
	pattern: RegExp;
	severity: Severity;
	label: string;
}

/**
 * Rules for text files (.md).
 *
 * Patterns are kept simple with no nested quantifiers — this regex runs on
 * content from strangers, so catastrophic backtracking would be a
 * self-inflicted DoS.
 */
const MARKDOWN_RULES: Rule[] = [
	// --- code execution ---
	{
		pattern: /```+\s*(dataviewjs|jsx:|js-engine|meta-bind-js|run-\w+|python|preload)\b/i,
		severity: 'danger',
		label: 'Code block executed by plugins (Dataview/JS Engine/Execute Code)',
	},
	{
		pattern: /<%[\s\S]{0,4}?\*/,
		severity: 'danger',
		label: 'Templater execution command (<%* ... %>)',
	},
	{
		pattern: /<%[-_]?\s*tp\.(user|system|file|config)\b/i,
		severity: 'danger',
		label: 'Templater call (tp.*)',
	},
	{ pattern: /<script[\s>]/i, severity: 'danger', label: '<script> tag' },
	{
		pattern: /<(iframe|object|embed|applet)[\s>]/i,
		severity: 'danger',
		label: 'Embedded frame or object (<iframe>/<object>)',
	},
	{
		// matches on<event>= right after a tag character: onerror=, onload=, onclick=...
		pattern: /<[a-z][^>\n]{0,200}\son[a-z]{3,15}\s*=/i,
		severity: 'danger',
		label: 'HTML event attribute (onerror/onload/...)',
	},
	{ pattern: /javascript:/i, severity: 'danger', label: 'javascript: address' },
	{ pattern: /data:text\/html/i, severity: 'danger', label: 'data:text/html address' },

	// --- remote/local content: doesn't execute, but leaks information ---
	{
		pattern: /!\[[^\]\n]{0,200}\]\(\s*https?:\/\//i,
		severity: 'warning',
		label: 'Image loaded from the network (reveals your IP when the note is opened)',
	},
	{
		pattern: /<img[^>\n]{0,200}src\s*=\s*["']?https?:\/\//i,
		severity: 'warning',
		label: 'Image loaded from the network (reveals your IP when the note is opened)',
	},
	{
		pattern: /obsidian:\/\//i,
		severity: 'warning',
		label: 'obsidian:// address (can trigger actions in the app)',
	},
	{
		pattern: /(?:^|[\s("'])(?:file|app):\/\//i,
		severity: 'warning',
		label: 'Reference to a local file (file:// or app://)',
	},
];

/** SVG is an XML document, not just an image — it can carry scripts and network calls. */
const SVG_RULES: Rule[] = [
	{ pattern: /<script[\s>]/i, severity: 'danger', label: 'Script in SVG file' },
	{
		pattern: /<[a-z][^>\n]{0,200}\son[a-z]{3,15}\s*=/i,
		severity: 'danger',
		label: 'Event attribute in SVG file',
	},
	{ pattern: /<foreignObject[\s>]/i, severity: 'danger', label: 'foreignObject in SVG (embeds HTML)' },
	{ pattern: /javascript:/i, severity: 'danger', label: 'javascript: address in SVG' },
	{
		pattern: /(?:xlink:)?href\s*=\s*["']?https?:\/\//i,
		severity: 'warning',
		label: 'SVG fetches a resource from the network',
	},
];

/** Extensions worth reading at all — raster images are skipped. */
const SCANNABLE = new Set(['md', 'canvas', 'svg']);

export function isScannable(path: string): boolean {
	return SCANNABLE.has(extensionOf(path));
}

/**
 * Scans one file's contents.
 *
 * `content` is already decoded text — decoding is the caller's job, since it
 * comes from the vault when publishing and from the archive when installing.
 */
export function scanContent(path: string, content: string): Finding[] {
	const extension = extensionOf(path);

	if (extension === 'canvas') return scanCanvas(path, content);
	if (extension === 'svg') return applyRules(path, content, SVG_RULES);
	if (extension === 'md') return applyRules(path, content, MARKDOWN_RULES);

	return [];
}

function applyRules(path: string, content: string, rules: Rule[]): Finding[] {
	const findings: Finding[] = [];

	for (const rule of rules) {
		const match = rule.pattern.exec(content);
		// One finding per rule: twenty remote images in one note is the same
		// decision as one, and it keeps the list readable.
		if (match) {
			findings.push({
				path,
				severity: rule.severity,
				label: rule.label,
				sample: excerpt(content, match.index),
			});
		}
	}

	return findings;
}

/**
 * Canvas files are JSON, not free text — regexes here would false-positive
 * on plain node descriptions. We only care about `link` nodes: a live
 * embedded web page that loads the moment the canvas is opened.
 */
function scanCanvas(path: string, content: string): Finding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [{ path, severity: 'warning', label: 'Corrupted canvas file (not valid JSON)', sample: '' }];
	}

	const nodes = (parsed as { nodes?: unknown })?.nodes;
	if (!Array.isArray(nodes)) return [];

	const findings: Finding[] = [];
	let remoteSeen = false;

	for (const node of nodes) {
		const entry = node as { type?: unknown; url?: unknown };
		if (entry?.type === 'link' && typeof entry.url === 'string' && !remoteSeen) {
			remoteSeen = true;
			findings.push({
				path,
				severity: 'danger',
				label: 'Canvas embeds a live web page (link-type node)',
				sample: entry.url.slice(0, 120),
			});
		}
	}

	return findings;
}

/** A snippet around the match, so the user doesn't have to take our word for it. */
function excerpt(content: string, index: number): string {
	const start = Math.max(0, index - 20);
	return content
		.slice(start, start + 120)
		.replace(/\s+/g, ' ')
		.trim();
}

/** Shared with installs.ts, which also needs to tell a dotted folder name from a real extension. */
export function extensionOf(path: string): string {
	const dot = path.lastIndexOf('.');
	const slash = path.lastIndexOf('/');
	return dot === -1 || dot < slash ? '' : path.slice(dot + 1).toLowerCase();
}
