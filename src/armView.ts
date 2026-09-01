import { Notice, Plugin, TFile, type MarkdownPostProcessorContext } from 'obsidian';
import { arm, armBlock, disarm, disarmedLanguages } from './disarm';

/**
 * How a switched-off block looks and how the reader switches it on.
 *
 * The suffix that disables a block also frees up its language name, so this
 * plugin can claim it: `dataviewjs-off` is nobody else's, which means a
 * disabled block is not a grey rectangle but a panel showing the code, what it
 * would do, and a button.
 *
 * That is the whole bargain. The package arrives complete — nothing removed,
 * nothing refused — and the reader decides per block, after reading it, with
 * the decision reversible at any time.
 */

/** Reading view: render the code plus a way to turn it on. */
export function registerDisarmedBlocks(plugin: Plugin): void {
	for (const language of disarmedLanguages()) {
		plugin.registerMarkdownCodeBlockProcessor(language, (source, el, ctx) => {
			renderDisarmed(plugin, source, el, ctx);
		});
	}

	plugin.addCommand({
		id: 'arm-note',
		name: 'Enable all blocks in this note',
		editorCheckCallback: (checking, _editor, view) => rewriteNote(plugin, view.file, arm, checking),
	});

	plugin.addCommand({
		id: 'disarm-note',
		name: 'Disable all blocks in this note',
		editorCheckCallback: (checking, _editor, view) => rewriteNote(plugin, view.file, disarm, checking),
	});
}

function renderDisarmed(plugin: Plugin, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
	const panel = el.createDiv({ cls: 'marketplace-disarmed' });

	// The code stays visible, unchanged, because reading it is the point —
	// the reader is being asked to make a judgement, not to trust a label.
	panel.createEl('pre').createEl('code', { text: source });

	const footer = panel.createDiv({ cls: 'marketplace-disarmed-footer' });
	// No per-block breakdown of what the code reaches for: that needed a
	// JavaScript parser in the plugin, and what the package as a whole does was
	// already spelled out on the install screen from the server's manifest.
	footer.createSpan({ cls: 'marketplace-disarmed-label', text: 'This block is off until you turn it on.' });

	const button = footer.createEl('button', { text: 'Enable this block' });
	button.addEventListener('click', () => {
		// getSectionInfo() is what maps this rendered element back to the
		// lines it came from; without it there is nothing to rewrite.
		const section = ctx.getSectionInfo(el);
		const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);

		if (section === null || !(file instanceof TFile)) {
			new Notice('Could not find this block in the note.');
			return;
		}

		void plugin.app.vault.process(file, (text) => armBlock(text, section.lineStart + 1));
	});
}

/**
 * Rewrites the whole note, both directions.
 *
 * `editorCheckCallback` so the commands only appear on a Markdown file, and so
 * the palette can offer them without running anything.
 */
function rewriteNote(plugin: Plugin, file: TFile | null, change: (text: string) => string, checking: boolean): boolean {
	if (file === null) return false;
	if (checking) return true;

	void plugin.app.vault.process(file, change);

	return true;
}
