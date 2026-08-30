import { Setting } from 'obsidian';
import type { Finding } from './scan';

/**
 * Shared UI for showing scanner findings.
 *
 * A `Notice` won't do — it disappears after a few seconds, doesn't scroll,
 * and twenty findings would fill half the screen. This is exactly the
 * moment the user needs to actually read something and decide.
 */
export function renderFindings(parent: HTMLElement, findings: Finding[]): void {
	const dangers = findings.filter((finding) => finding.severity === 'danger');
	const warnings = findings.filter((finding) => finding.severity === 'warning');

	if (dangers.length > 0) {
		renderGroup(parent, 'Active content', dangers, 'marketplace-finding-danger');
	}
	if (warnings.length > 0) {
		renderGroup(parent, 'To review', warnings, 'marketplace-finding-warning');
	}
}

function renderGroup(
	parent: HTMLElement,
	title: string,
	findings: Finding[],
	cls: string,
): void {
	parent.createEl('h4', { text: `${title} (${findings.length})` });
	const list = parent.createDiv({ cls: 'marketplace-findings' });

	for (const finding of findings) {
		const row = list.createDiv({ cls: `marketplace-finding ${cls}` });
		row.createDiv({ cls: 'marketplace-finding-label', text: finding.label });
		row.createDiv({ cls: 'marketplace-finding-path', text: finding.path });
		if (finding.sample) {
			// Insert the snippet as text, never HTML — it's literally the
			// content we're flagging as code.
			row.createEl('code', { cls: 'marketplace-finding-sample', text: finding.sample });
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
