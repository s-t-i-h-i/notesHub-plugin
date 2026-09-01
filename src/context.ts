/**
 * What a package would actually do in THIS vault.
 *
 * The server describes a package for everyone. Only the reader's own app knows
 * whether the plugin that would run it is even installed: a ```dataviewjs block
 * is executable code for someone with Dataview and a grey box for everyone
 * else. Saying so is the difference between a warning people read and a
 * warning people click past.
 *
 * This is UX, never enforcement. It runs on the reader's machine and an
 * attacker skips it by not using the plugin at all, which is exactly why the
 * decision that matters is made by the server.
 */

import type { App } from 'obsidian';

export interface VaultContext {
	/**
	 * No community plugin is switched on in this vault.
	 *
	 * Deliberately NOT called "restricted mode". Restricted mode produces this
	 * state, but so does a fresh vault and one that only uses core plugins, and
	 * there is no documented way to tell them apart. Naming it after what we can
	 * actually observe keeps the sentence we show from being confidently wrong
	 * for a very common setup.
	 */
	noCommunityPlugins: boolean;
	/** Ids of the community plugins currently switched on. */
	enabled: Set<string>;
	/** False when the app didn't tell us — then we say nothing rather than guess. */
	known: boolean;
}

/**
 * Interpreter names, as the manifest spells them, mapped to plugin ids.
 *
 * Names not listed here are Obsidian's own (HTML, SVG, Mermaid, an embed), and
 * those run whatever the reader has installed.
 */
const PLUGIN_IDS: Record<string, string> = {
	Dataview: 'dataview',
	Templater: 'templater-obsidian',
	'JS Engine': 'js-engine',
	'Meta Bind': 'obsidian-meta-bind-plugin',
	'Execute Code': 'execute-code',
	Excalidraw: 'obsidian-excalidraw-plugin',
	CustomJS: 'customjs',
	Tasks: 'obsidian-tasks-plugin',
	Admonition: 'obsidian-admonition',
};

/**
 * Reads the app's plugin state.
 *
 * `app.plugins` is not part of Obsidian's documented API, so every access is
 * guarded and a miss reports `known: false`. The alternative — assuming — would
 * put a confident sentence in front of the reader with nothing behind it.
 */
export function readContext(app: App): VaultContext {
	const plugins = (app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
	const enabled = plugins?.enabledPlugins;

	if (!(enabled instanceof Set)) return { noCommunityPlugins: false, enabled: new Set(), known: false };

	return { noCommunityPlugins: enabled.size === 0, enabled, known: true };
}

/**
 * Whether this interpreter would run here.
 *
 * null means "we don't know" and has to stay distinguishable from false —
 * telling someone "this won't run" when we couldn't check would be worse than
 * saying nothing at all.
 */
export function willRun(context: VaultContext, interpreter: string): boolean | null {
	if (!context.known) return null;

	const id = PLUGIN_IDS[interpreter];
	// Obsidian's own rendering: an iframe, an embed, a diagram. Always active.
	if (id === undefined) return true;

	return context.enabled.has(id);
}
