import { Setting } from 'obsidian';
import type { Capability, Finding } from './policy/types';
import { willRun, type VaultContext } from './context';

/**
 * The manifest, written for a person.
 *
 * The old screen listed raw matches — one row per regex hit, with a snippet.
 * Twenty rows of that is a wall, and a wall is something people dismiss. What
 * a reader needs first is one sentence per thing the package can do, with the
 * hosts named; the evidence belongs underneath, for whoever wants to check.
 *
 * Two things the old screen could not say, and both change the decision:
 * WHEN something runs (on opening a note, or only when you ask for it), and
 * whether it would run in THIS vault at all.
 */

/** One line of plain language per capability, ordered worst first. */
const WORDING: [Capability, string][] = [
	['opaque', 'contains code that cannot be checked'],
	['native', 'reaches outside Obsidian'],
	['vault-write', 'writes files in your vault'],
	['vault-read', 'reads your vault'],
	['network', 'sends and receives data over the network'],
	['command', 'runs Obsidian commands'],
	['remote-embed', 'embeds a live page from the web'],
	['network-passive', 'loads images or styles from the web'],
	['storage', 'reads the clipboard or local storage'],
	['js', 'runs code'],
	['inert', 'contains markup Obsidian removes before rendering (it does not run)'],
];

const TRIGGER_WORDING: Record<string, string> = {
	render: 'when a note is opened',
	click: 'when you click something',
	command: 'only when you run it',
};

/**
 * The capabilities as one readable clause: "reads your vault and runs code".
 *
 * Shared with the disabled-block panel so the wording a reader sees before
 * installing is the wording they see again next to the button.
 */
export function describeCapabilities(capabilities: Capability[]): string {
	const words = WORDING.filter(([capability]) => capabilities.includes(capability)).map(([, wording]) => wording);
	if (words.length === 0) return 'does nothing we can name';
	if (words.length === 1) return words[0] as string;

	return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Renders the manifest for the reader who is about to install the package. */
export function renderManifest(parent: HTMLElement, findings: Finding[], context: VaultContext): void {
	if (findings.length === 0) {
		parent.createDiv({ cls: 'marketplace-detail-desc', text: 'Nothing in this package runs code or reaches the network.' });
		return;
	}

	parent.createEl('h4', { text: 'What this package does' });
	const list = parent.createDiv({ cls: 'marketplace-findings' });

	for (const [capability, wording] of WORDING) {
		const matching = findings.filter((found) => found.capabilities.includes(capability));
		if (matching.length === 0) continue;

		renderCapability(list, capability, wording, matching, context);
	}

	if (context.noCommunityPlugins) {
		// True whether that is restricted mode or simply a vault with none
		// installed — and we cannot tell those apart, so we say the part we know.
		parent.createDiv({
			cls: 'marketplace-detail-desc',
			text: 'No community plugins are enabled in this vault, so anything above that needs one will not run here.',
		});
	}

	renderEvidence(parent, findings);
}

function renderCapability(
	list: HTMLElement,
	capability: Capability,
	wording: string,
	findings: Finding[],
	context: VaultContext,
): void {
	// Anything that starts on its own is the reason this screen exists, so the
	// row says so first.
	const startsByItself = findings.some((found) => found.trigger === 'render');
	const row = list.createDiv({
		cls: `marketplace-finding ${startsByItself || capability === 'opaque' ? 'marketplace-finding-danger' : 'marketplace-finding-warning'}`,
	});

	row.createDiv({ cls: 'marketplace-finding-label', text: wording });

	const interpreters = [...new Set(findings.map((found) => found.interpreter))];
	const triggers = [...new Set(findings.map((found) => TRIGGER_WORDING[found.trigger] ?? found.trigger))];
	row.createDiv({
		cls: 'marketplace-finding-path',
		text: `${findings.length} ${findings.length === 1 ? 'place' : 'places'} · ${interpreters.join(', ')} · ${triggers.join(', ')}`,
	});

	// "Connects to the network" without an address is not information.
	const hosts = [...new Set(findings.flatMap((found) => found.hosts))];
	if (hosts.length > 0) row.createDiv({ cls: 'marketplace-finding-path', text: hosts.join(', ') });

	// A fragment hidden in a %% comment is invisible in reading view but still
	// read by Templater and Dataview, so it is worth calling out by name.
	if (findings.some((found) => found.hidden)) {
		row.createDiv({ cls: 'marketplace-finding-label', text: 'Some of this is hidden inside a comment.' });
	}

	const inactive = interpreters.filter((name) => willRun(context, name) === false);
	if (inactive.length === interpreters.length && interpreters.length > 0) {
		row.createDiv({
			cls: 'marketplace-finding-path',
			text: `You do not have ${inactive.join(' or ')}, so this will not run here.`,
		});
	}
}

/** The fragments themselves, folded away — evidence for whoever wants it, not a wall for everyone. */
function renderEvidence(parent: HTMLElement, findings: Finding[]): void {
	const details = parent.createEl('details', { cls: 'marketplace-findings' });
	details.createEl('summary', { text: `Show the ${findings.length} ${findings.length === 1 ? 'fragment' : 'fragments'} behind this` });

	for (const found of findings) {
		const row = details.createDiv({ cls: 'marketplace-finding' });
		row.createDiv({ cls: 'marketplace-finding-path', text: `${found.path}:${found.line} · ${found.interpreter}` });
		if (found.sample) {
			// Inserted as text, never as HTML — this is literally the content
			// being flagged as code.
			row.createEl('code', { cls: 'marketplace-finding-sample', text: found.sample });
		}
	}
}

/** A confirm/cancel button pair in one row. */
export function renderConfirmRow(
	parent: HTMLElement,
	confirmLabel: string,
	onConfirm: () => void,
	onCancel: () => void,
	warn = true,
): void {
	new Setting(parent)
		.addButton((button) => {
			button.setButtonText(confirmLabel).onClick(onConfirm);
			// A risky action doesn't get the call-to-action style — that
			// emphasis belongs to backing out, not going through with it.
			if (warn) button.setWarning();
		})
		.addButton((button) => button.setButtonText('Cancel').setCta().onClick(onCancel));
}
