import { ButtonComponent, Modal, Notice, Setting, TFile, TFolder } from 'obsidian';
import MarketplacePlugin from './main';
import { collectFiles, findBrokenLinks, findNameProblems, type BrokenLink } from './files';
import { publishFolder } from './api/publishApi';
import { fetchPackages, fetchTags, MAX_IDS_PER_QUERY, type Package } from './api/packagesApi';
import { UnauthorizedError } from './api/api';
import { extensionOf, hasExif } from './verify';
import { isScannable, problemsIn } from './nocode';
import { formatBytes } from './installs';
import { renderConfirmRow } from './ui';

type FieldKey = 'title' | 'description';

const FIELDS: { key: FieldKey; name: string; desc?: string; multiline?: boolean }[] = [
	{ key: 'title', name: 'Title' },
	{ key: 'description', name: 'Description', multiline: true },
];

/**
 * How many tags one package may carry.
 *
 * The cap and the vocabulary are both enforced by the server; this is the
 * copy that keeps the form honest about what will be stored.
 */
const MAX_TAGS = 4;

/** How many problems to list before it stops being readable. */
const MAX_LISTED = 20;

/**
 * The tags to pre-select for a package being replaced.
 *
 * Anything outside the vocabulary is dropped rather than carried invisibly: the
 * server drops it too, and no chip would show it.
 *
 * Unless the vocabulary is itself what is missing. An unreachable catalog
 * leaves it empty, which would filter every tag away while renderTagPicker()
 * stays hidden — so publishing an update would silently clear tags the package
 * already had. With nothing to check against, they go back unchanged and the
 * server's own filter decides.
 */
function keepKnownTags(tags: string[], vocabulary: string[]): string[] {
	return vocabulary.length === 0 ? [...tags] : tags.filter((tag) => vocabulary.includes(tag));
}

/** Checks config and the folder, and only opens the form if publishing could actually succeed. */
/** The formats hasExif() understands. */
function isPhoto(path: string): boolean {
	return extensionOf(path) === 'jpg' || extensionOf(path) === 'jpeg';
}

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
	/** Packages this account owns, offered as update targets. Empty if the catalog can't be reached. */
	private mine: Package[] = [];
	/** Package to replace, or '' to publish a new one. */
	private targetId = '';
	/** The tag vocabulary, as the server defines it. Empty if the catalog can't be reached. */
	private vocabulary: string[] = [];
	private tags: string[] = [];

	constructor(plugin: MarketplacePlugin, folder: TFolder, files: TFile[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.folder = folder;
		this.files = files;
		this.values = {
			title: folder.name,
			description: '',
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
		const { withExif, codeProblems } = await this.inspectFiles();
		const bytes = this.files.reduce((sum, file) => sum + file.stat.size, 0);
		this.mine = await this.fetchOwnPackages();

		// Same reasoning as the package list above: no tags is a worse form
		// than no publish.
		try {
			this.vocabulary = await fetchTags(this.plugin.settings);
		} catch (error) {
			console.error('Failed to fetch the tag list', error);
		}

		this.bodyEl.empty();

		// File count and size up front: running "Publish" on the vault root
		// would send everything, and without this the author wouldn't notice.
		//
		// No verdict on the limit here. This is the uncompressed sum against a
		// compressed ceiling, and notes pack about ten to one, so it called a
		// folder doomed that would have published comfortably. publishApi
		// checks the finished archive a moment later and is simply right.
		this.bodyEl.createDiv({
			cls: 'marketplace-detail-desc',
			text: `To be sent: ${this.files.length} files, ${formatBytes(bytes)}.`,
		});

		// A hard block, not a warning: inspectArchive() rejects the whole
		// archive for a name like this, so "publish anyway" would just move
		// the failure to every downloader instead of preventing it.
		if (nameProblems.length > 0) {
			this.renderNameProblems(nameProblems);
			return;
		}

		// Also a hard block, and for the same reason: the server answers 422
		// for any of these, so "publish anyway" would only move the failure to
		// the upload. Named here so the author can fix it in one pass.
		if (codeProblems.length > 0) {
			this.renderCodeProblems(codeProblems);
			return;
		}

		if (links.length === 0 && withExif.length === 0) {
			this.renderForm();
			return;
		}

		if (withExif.length > 0) this.renderExifWarning(withExif);
		if (links.length > 0) this.renderLinks(links);

		// Nothing left here blocks publishing: broken links and camera metadata
		// are the author's call to make.
		renderConfirmRow(
			this.bodyEl,
			'Continue',
			() => this.renderForm(),
			() => this.close(),
		);
	}

	/**
	 * The account's own packages, to offer as update targets.
	 *
	 * A failure here is not fatal: publishing as a new package still works,
	 * and forcing the author back to the file menu because the catalog
	 * blinked would be worse than an empty dropdown.
	 */
	private async fetchOwnPackages(): Promise<Package[]> {
		const { userId } = this.plugin.settings;
		if (!userId) return [];

		try {
			// author_id and limit go to the server. Filtering one page client-side
			// showed only packages that happened to be in the newest twenty, so an
			// author with older ones could not offer them as update targets at all
			// — and was quietly pushed into publishing duplicates instead.
			return await fetchPackages(this.plugin.settings, { authorId: userId, limit: MAX_IDS_PER_QUERY });
		} catch (error) {
			console.error('Failed to fetch your packages', error);
			return [];
		}
	}

	/**
	 * Photos carrying EXIF, named.
	 *
	 * The only risk in this whole flow that runs the other way: it does not
	 * endanger whoever downloads the package, it exposes the author. A photo
	 * off a phone carries GPS coordinates and a camera serial, and publishing
	 * puts both in a public catalog permanently.
	 *
	 * Named rather than stripped — removing metadata would change the author's
	 * files without being asked.
	 */
	private async inspectFiles(): Promise<{ withExif: string[]; codeProblems: string[] }> {
		const withExif: string[] = [];
		const codeProblems: string[] = [];

		// One pass, and the reads issued together rather than awaited one at a
		// time: this runs before the review screen paints, and a folder of a
		// couple of thousand notes made that wait visible.
		const wanted = this.files.filter((file) => isScannable(file.path) || isPhoto(file.path));
		const contents = await Promise.all(wanted.map((file) => this.app.vault.readBinary(file)));

		wanted.forEach((file, index) => {
			const data = new Uint8Array(contents[index] as ArrayBuffer);

			if (isPhoto(file.path)) {
				if (hasExif(data)) withExif.push(file.name);
				return;
			}

			try {
				codeProblems.push(...problemsIn(file.path, new TextDecoder().decode(data)));
			} catch (error) {
				// scanFile refuses a file it cannot read at all — a canvas that
				// is not JSON, or one past the node cap. The server answers 422
				// for the same file, so this belongs on the list. Left uncaught
				// it rejected out of `void this.review()` and the modal sat on
				// "Checking contents..." forever.
				codeProblems.push(`${file.path} — ${error instanceof Error ? error.message : String(error)}`);
			}
		});

		return { withExif, codeProblems };
	}

	private renderExifWarning(withExif: string[]): void {
		const row = this.bodyEl.createDiv({ cls: 'marketplace-finding marketplace-finding-warning' });
		row.createDiv({ cls: 'marketplace-finding-label', text: 'These photos carry camera metadata' });
		row.createDiv({ cls: 'marketplace-finding-path', text: withExif.slice(0, MAX_LISTED).join(', ') });
		row.createDiv({
			cls: 'marketplace-finding-path',
			text: 'That can include the location the photo was taken and the camera serial number. Publishing makes it public.',
		});
	}

	private renderCodeProblems(problems: string[]) {
		this.bodyEl.createEl('h4', { text: `Content that runs by itself (${problems.length})` });
		this.bodyEl.createDiv({
			cls: 'marketplace-detail-desc',
			text: 'Packages may only contain notes that do nothing on their own. Remove or fence off these fragments, then publish again.',
		});
		const list = this.bodyEl.createDiv({ cls: 'marketplace-findings' });
		for (const problem of problems.slice(0, MAX_LISTED)) {
			const row = list.createDiv({ cls: 'marketplace-finding marketplace-finding-danger' });
			row.createDiv({ cls: 'marketplace-finding-path', text: problem });
		}
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

		if (this.mine.length > 0) {
			new Setting(this.bodyEl)
				.setName('Publish as')
				.setDesc('You can publish new package or update already existing one.')
				.addDropdown((dropdown) => {
					dropdown.addOption('', 'New package');
					for (const pkg of this.mine) dropdown.addOption(pkg.id, `${pkg.title} (v${pkg.version})`);
					dropdown.setValue(this.targetId).onChange((value) => {
						this.targetId = value;
						// Prefill from the package being replaced: the update
						// sends every field, so an untouched form must carry
						// the existing description and tags, not blanks.
						const target = this.mine.find((pkg) => pkg.id === value);
						this.values = target
							? { title: target.title, description: target.description }
							: { title: this.folder.name, description: '' };
						this.tags = target ? keepKnownTags(target.tags, this.vocabulary) : [];

						// renderForm() empties the body itself.
						this.renderForm();
					});
				});
		}

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

		this.renderTagPicker();

		new Setting(this.bodyEl).addButton((button) =>
			button
				.setButtonText(this.targetId ? 'Publish update' : 'Publish')
				.setCta()
				.onClick(() => void this.publish(button)),
		);
	}

	/** Tags are picked from a fixed list, not typed: free text was a spam surface. */
	private renderTagPicker() {
		if (this.vocabulary.length === 0) return;

		const setting = new Setting(this.bodyEl).setName('Tags').setDesc(`Pick up to ${MAX_TAGS}`);
		setting.settingEl.addClass('marketplace-wide-field');

		const row = setting.controlEl.createDiv({ cls: 'marketplace-tags' });
		for (const tag of this.vocabulary) {
			const chip = row.createSpan({ cls: 'marketplace-tag', text: `#${tag}` });
			chip.toggleClass('is-active', this.tags.includes(tag));

			chip.addEventListener('click', () => {
				const at = this.tags.indexOf(tag);
				if (at >= 0) this.tags.splice(at, 1);
				else if (this.tags.length >= MAX_TAGS) {
					new Notice(`Up to ${MAX_TAGS} tags`);
					return;
				} else this.tags.push(tag);

				chip.toggleClass('is-active', at < 0);
			});
		}
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
					tags: this.tags,
				},
				this.plugin.settings,
				this.targetId || undefined,
			);

			new Notice(this.targetId ? 'Update published.' : 'Published.', 10_000);
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
			button.setButtonText(this.targetId ? 'Publish update' : 'Publish');
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
