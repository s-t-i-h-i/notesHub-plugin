import { ButtonComponent, Modal, Notice, Setting, TFile, TFolder } from 'obsidian';
import MarketplacePlugin from './main';
import { collectFiles, findBrokenLinks, findNameProblems, type BrokenLink } from './files';
import { publishFolder } from './api/publishApi';
import { UnauthorizedError } from './api/api';
import { isScannable, scanContent, type Finding } from './scan';
import { MAX_PUBLISH_BYTES } from './constants';
import { formatBytes } from './installs';
import { renderFindings, renderConfirmRow } from './review';

type FieldKey = 'title' | 'description' | 'tags';

const FIELDS: { key: FieldKey; name: string; desc?: string; multiline?: boolean }[] = [
	{ key: 'title', name: 'Title' },
	{ key: 'description', name: 'Description', multiline: true },
	{ key: 'tags', name: 'Tags', desc: 'Comma-separated' },
];

/** How many problems to list before it stops being readable. */
const MAX_LISTED = 20;

/** Checks config and the folder, and only opens the form if publishing could actually succeed. */
export function openPublishModal(plugin: MarketplacePlugin, folder: TFolder): void {
	// These checks run before collecting files: making the user fill out a
	// form just to then say "log in" is the wrong order, and there's no
	// point walking the folder tree either.
	if (!plugin.settings.token.trim()) {
		new Notice('Log in from the plugin settings to publish');
		return;
	}

	const files = collectFiles(folder);
	if (files.length === 0) {
		new Notice('No files to publish');
		return;
	}

	// Pass the file list into the modal so it isn't recomputed when packing.
	new PublishModal(plugin, folder, files).open();
}

class PublishModal extends Modal {
	private plugin: MarketplacePlugin;
	private folder: TFolder;
	private files: TFile[];
	private values: Record<FieldKey, string>;
	private bodyEl!: HTMLElement;

	constructor(plugin: MarketplacePlugin, folder: TFolder, files: TFile[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.folder = folder;
		this.files = files;
		this.values = {
			title: folder.name,
			description: '',
			tags: '',
		};
	}

	onOpen() {
		this.modalEl.addClass('marketplace-modal');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Publish: ${this.folder.name}` });
		this.bodyEl = contentEl.createDiv();

		void this.review();
	}

	/**
	 * A review screen shown before the form.
	 *
	 * Publishing moves content from a private vault into a public catalog,
	 * and that's effectively irreversible — once someone downloads a
	 * package, there's no taking it back. The author sees what they're
	 * about to send first.
	 */
	private async review() {
		this.bodyEl.empty();
		this.bodyEl.createDiv({ text: 'Checking contents...' });

		const prefix = this.folder.isRoot() ? '' : this.folder.path + '/';
		const nameProblems = findNameProblems(this.files, prefix);
		const links = findBrokenLinks(this.app, this.files);
		const findings = await this.scanFiles();
		const bytes = this.files.reduce((sum, file) => sum + file.stat.size, 0);

		this.bodyEl.empty();

		// File count and size up front: running "Publish" on the vault root
		// would send everything, and without this the author wouldn't notice.
		// The size is the uncompressed sum, so it can only hint at the limit —
		// the real check runs on the finished archive in publishApi.
		this.bodyEl.createDiv({
			cls: 'marketplace-detail-desc',
			text:
				`To be sent: ${this.files.length} files, ${formatBytes(bytes)}.` +
				(bytes > MAX_PUBLISH_BYTES
					? ` That is already over the ${formatBytes(MAX_PUBLISH_BYTES)} limit before compression, so publishing will probably fail.`
					: ''),
		});

		// A hard block, not a warning: installPackage() rejects the whole
		// archive for a name like this, so "publish anyway" would just move
		// the failure to every downloader instead of preventing it.
		if (nameProblems.length > 0) {
			this.renderNameProblems(nameProblems);
			return;
		}

		if (links.length === 0 && findings.length === 0) {
			this.renderForm();
			return;
		}

		if (links.length > 0) this.renderLinks(links);
		if (findings.length > 0) {
			this.bodyEl.createDiv({
				cls: 'marketplace-detail-desc',
				text: 'This content will execute or connect to the network for anyone who downloads the package:',
			});
			renderFindings(this.bodyEl, findings);
		}

		// This is a warning, not a hard block — a package can be
		// intentionally incomplete, and it's the author's call.
		renderConfirmRow(
			this.bodyEl,
			'Publish anyway',
			() => this.renderForm(),
			() => this.close(),
		);
	}

	/** Reads the package's text files and scans them for active content. */
	private async scanFiles(): Promise<Finding[]> {
		const findings: Finding[] = [];

		for (const file of this.files) {
			if (!isScannable(file.path)) continue;
			// cachedRead, not read: this is just for scanning, not editing
			findings.push(...scanContent(file.path, await this.app.vault.cachedRead(file)));
		}

		return findings;
	}

	private renderNameProblems(problems: string[]) {
		this.bodyEl.createEl('h4', { text: `Names no install could accept (${problems.length})` });
		this.bodyEl.createDiv({
			cls: 'marketplace-detail-desc',
			text: 'Every download would reject this archive outright. Rename or remove these before publishing.',
		});

		this.renderTruncatedList(problems, (list, problem) =>
			list.createDiv({ cls: 'marketplace-finding marketplace-finding-danger', text: problem }),
		);

		new Setting(this.bodyEl).addButton((button) =>
			button.setButtonText('Close').setCta().onClick(() => this.close()),
		);
	}

	private renderLinks(links: BrokenLink[]) {
		const outside = links.filter((link) => link.problem === 'outside');
		const unresolved = links.filter((link) => link.problem === 'unresolved');

		if (outside.length > 0) {
			this.renderLinkGroup(
				`Links outside the package (${outside.length})`,
				'The target exists in your vault but is not part of the package - the link will be dead for the recipient.',
				outside,
			);
		}
		if (unresolved.length > 0) {
			this.renderLinkGroup(
				`Links to nowhere (${unresolved.length})`,
				'These links do not lead anywhere, even for you.',
				unresolved,
			);
		}
	}

	private renderLinkGroup(title: string, desc: string, links: BrokenLink[]) {
		this.bodyEl.createEl('h4', { text: title });
		this.bodyEl.createDiv({ cls: 'marketplace-finding-path', text: desc });

		this.renderTruncatedList(links, (list, link) => {
			const row = list.createDiv({ cls: 'marketplace-finding marketplace-finding-warning' });
			row.createDiv({ cls: 'marketplace-finding-label', text: link.target });
			row.createDiv({ cls: 'marketplace-finding-path', text: `in: ${link.source}` });
		});
	}

	/** Renders at most MAX_LISTED items, with a "...and N more." row for the rest. */
	private renderTruncatedList<T>(
		items: T[],
		renderItem: (list: HTMLElement, item: T) => void,
	): void {
		const list = this.bodyEl.createDiv({ cls: 'marketplace-findings' });
		for (const item of items.slice(0, MAX_LISTED)) {
			renderItem(list, item);
		}
		if (items.length > MAX_LISTED) {
			list.createDiv({
				cls: 'marketplace-finding-path',
				text: `...and ${items.length - MAX_LISTED} more.`,
			});
		}
	}

	private renderForm() {
		this.bodyEl.empty();

		for (const field of FIELDS) {
			const setting = new Setting(this.bodyEl).setName(field.name);
			// Label above the field, control stretched full width - the default
			// two-column Setting row squeezes a description textarea into a
			// sliver next to its own label.
			setting.settingEl.addClass('marketplace-wide-field');
			if (field.desc) setting.setDesc(field.desc);

			const value = this.values[field.key];
			const onChange = (next: string) => (this.values[field.key] = next);

			if (field.multiline) {
				setting.addTextArea((text) => text.setValue(value).onChange(onChange));
			} else {
				setting.addText((text) => text.setValue(value).onChange(onChange));
			}
		}

		new Setting(this.bodyEl).addButton((button) =>
			button
				.setButtonText('Publish')
				.setCta()
				.onClick(() => void this.publish(button)),
		);
	}

	private async publish(button: ButtonComponent) {
		const title = this.values.title.trim();

		if (!title) {
			new Notice('Title is required');
			return;
		}

		button.setDisabled(true);
		button.setButtonText('Publishing...');

		try {
			await publishFolder(
				this.app,
				this.folder,
				this.files,
				{
					title,
					description: this.values.description.trim(),
					tags: this.values.tags
						.split(',')
						.map((tag) => tag.trim())
						.filter((tag) => tag.length > 0),
				},
				this.plugin.settings,
			);

			new Notice('Published');
			this.close();
		} catch (error) {
			console.error(error);
			// The token may have been revoked between opening the modal and
			// clicking publish, so point at settings instead of showing a bare "401".
			new Notice(
				error instanceof UnauthorizedError
					? 'The server rejected the token. Check the plugin settings.'
					: 'Publish error: ' +
							(error instanceof Error ? error.message : String(error)),
			);
			button.setDisabled(false);
			button.setButtonText('Publish');
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
