/**
 * The vocabulary of the manifest.
 *
 * The old scanner had two levels, 'danger' and 'warning', and collapsed every
 * kind of risk into them. That threw away the two things a reader actually
 * needs: what the content can do, and when it starts. A ```dataviewjs block
 * runs the moment a note is opened; a Templater template does nothing until
 * someone runs it on purpose. Both used to read as 'danger', so the screen was
 * half noise and people learned to click past it.
 *
 * Shared verbatim between the worker and the plugin.
 */

export type Capability =
	/** Arbitrary JavaScript with the app's own permissions. */
	| 'js'
	| 'vault-read'
	| 'vault-write'
	/** The code itself reaches the network. */
	| 'network'
	/** The note pulls a remote resource when opened — a beacon for the reader's IP. */
	| 'network-passive'
	/** A live remote page inside the note. */
	| 'remote-embed'
	/** Outside the app: require, process, a shell. */
	| 'native'
	/** Runs Obsidian commands, directly or through an obsidian:// address. */
	| 'command'
	| 'storage'
	/**
	 * Present in the file, but Obsidian strips it before rendering — measured,
	 * see the table in html.ts.
	 *
	 * Reported rather than dropped, for two reasons: an author shipping a
	 * <script> is worth knowing about even when it cannot run, and the day
	 * Obsidian's allowlist changes we want the finding already there instead of
	 * a silence we would have to notice.
	 */
	| 'inert'
	/** We could not work out what it does. The loudest entry, not a missing one. */
	| 'opaque';

/**
 * When the fragment starts running. This is the axis that decides whether
 * something has to be disarmed on install or merely mentioned.
 */
export type Trigger =
	/** On opening the note. Nobody consented to this. */
	| 'render'
	/** When the reader clicks something in the note. */
	| 'click'
	/** Only when the reader runs a plugin command on the file. */
	| 'command';

export interface Finding {
	/** Path inside the package. */
	path: string;
	/** 1-based line the fragment starts on, so the author can go straight to it. */
	line: number;
	capabilities: Capability[];
	trigger: Trigger;
	/** Who runs it, e.g. "Dataview" — a name the reader can act on. */
	interpreter: string;
	/** Hosts the fragment reaches. "Connects to the network" without one says nothing. */
	hosts: string[];
	/**
	 * Inside a %% comment. Templater and Dataview read the raw file, so a
	 * comment hides a fragment from the reader without stopping it — that
	 * raises the weight rather than lowering it.
	 */
	hidden: boolean;
	/** The fragment itself, so nobody has to take our word for it. */
	sample: string;
}

export interface Manifest {
	/** Bumped whenever the analysis changes, so old rows can be told apart. */
	version: number;
	findings: Finding[];
}

/** Bump on any change to what the analysis reports. */
export const POLICY_VERSION = 1;

/** A short, single-line excerpt of the offending fragment. */
export function excerpt(text: string, limit = 160): string {
	const flat = text.replace(/\s+/g, ' ').trim();

	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** The host of an absolute http(s) address, or null for anything else. */
export function hostOf(value: string): string | null {
	if (!/^https?:\/\//i.test(value.trim())) return null;

	try {
		return new URL(value.trim()).host.toLowerCase();
	} catch {
		return null;
	}
}
