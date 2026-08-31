import { ButtonComponent, Modal, Notice, Setting, TFolder } from 'obsidian';
import MarketplacePlugin from './main';
import type { InstallRecord } from './settings';
import {
	Package,
	deletePackage,
	downloadPackageArchive,
	fetchPackage,
	fetchPackages,
} from './api/packagesApi';
import {
	applyUpdate,
	inspectArchive,
	installPlan,
	formatBytes,
	planUpdate,
	resolveInstall,
	type PackagePlan,
	type UpdatePlan,
} from './installs';
import { UnauthorizedError } from './api/api';
import { armButton } from './ui';
import { renderFindings, renderConfirmRow } from './review';

type SortKey = 'newest' | 'oldest' | 'title';

const SORT_LABELS: Record<SortKey, string> = {
	newest: 'Newest',
	oldest: 'Oldest',
	title: 'Title A-Z',
};

const ALL_TAGS = '';

/** Opens the package library. The server address is baked in at build time, nothing to check here. */
export function openMarketplaceModal(plugin: MarketplacePlugin): void {
	new MarketplaceModal(plugin).open();
}

class MarketplaceModal extends Modal {
	private plugin: MarketplacePlugin;
	private bodyEl!: HTMLElement;

	private packages: Package[] = [];
	private tagFilter: string = ALL_TAGS;
	private sortBy: SortKey = 'newest';

	constructor(plugin: MarketplacePlugin) {
		super(plugin.app);
		// super() consumes and discards the plugin argument, but settings are needed later for downloads.
		this.plugin = plugin;
	}

	onOpen() {
		this.modalEl.addClass('marketplace-modal');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Package library' });
		// A separate container for the content: only this gets re-rendered, the heading stays.
		this.bodyEl = contentEl.createDiv();

		void this.load();
	}

	onClose() {
		this.contentEl.empty();
	}

	private async load() {
		this.renderMessage('Loading...');

		try {
			this.packages = await fetchPackages(this.plugin.settings);
			this.renderList();
		} catch (error) {
			console.error(error);
			const reason = error instanceof Error ? error.message : String(error);
			this.renderError(`Failed to fetch packages: ${reason}`);
		}
	}

	/** A simple centered message, used for loading and empty states. */
	private renderMessage(text: string) {
		this.bodyEl.empty();
		this.bodyEl.createDiv({ text });
	}

	/** An error message with a retry button — the network can be flaky. */
	private renderError(text: string) {
		this.renderMessage(text);
		new ButtonComponent(this.bodyEl)
			.setButtonText('Try again')
			.setCta()
			.onClick(() => void this.load());
	}

	// --- list view ---

	private renderList() {
		this.bodyEl.empty();

		if (this.packages.length === 0) {
			this.renderMessage('The library is empty.');
			return;
		}

		this.renderToolbar();

		const visible = this.visiblePackages();
		if (visible.length === 0) {
			this.bodyEl.createDiv({ text: `No packages with tag #${this.tagFilter}.` });
			return;
		}

		const grid = this.bodyEl.createDiv({ cls: 'marketplace-grid' });
		for (const pkg of visible) {
			this.renderCard(grid, pkg);
		}
	}

	private renderToolbar() {
		// All tags from the catalog, deduplicated — the filter should only
		// offer tags that actually exist.
		const tags = [...new Set(this.packages.flatMap((pkg) => pkg.tags))].sort((a, b) =>
			a.localeCompare(b, 'en'),
		);

		new Setting(this.bodyEl)
			.setName('Tags and order')
			.addDropdown((dropdown) => {
				dropdown.addOption(ALL_TAGS, 'All tags');
				for (const tag of tags) {
					dropdown.addOption(tag, `#${tag}`);
				}
				dropdown.setValue(this.tagFilter).onChange((value) => {
					this.tagFilter = value;
					this.renderList();
				});
			})
			.addDropdown((dropdown) => {
				for (const [key, label] of Object.entries(SORT_LABELS)) {
					dropdown.addOption(key, label);
				}
				dropdown.setValue(this.sortBy).onChange((value) => {
					this.sortBy = value as SortKey;
					this.renderList();
				});
			});
	}

	/**
	 * Filtering and sorting happen client-side — the full list is already in
	 * memory, so asking the server to do the same work would be pointless.
	 */
	private visiblePackages(): Package[] {
		const filtered = this.tagFilter
			? this.packages.filter((pkg) => pkg.tags.includes(this.tagFilter))
			: [...this.packages];

		return filtered.sort((a, b) => {
			if (this.sortBy === 'title') return a.title.localeCompare(b.title, 'en');
			// created_at is ISO-8601, so a plain string comparison is chronological
			if (this.sortBy === 'oldest') return a.createdAt.localeCompare(b.createdAt);
			return b.createdAt.localeCompare(a.createdAt);
		});
	}

	/** One package card. Clicking it opens the detail view. */
	private renderCard(grid: HTMLElement, pkg: Package) {
		const meta = [pkg.author, ...pkg.tags.map((tag) => `#${tag}`)]
			.filter((part) => part.length > 0)
			.join(' · ');

		const card = grid.createDiv({ cls: 'marketplace-card mod-clickable' });
		card.createDiv({ cls: 'marketplace-card-title', text: pkg.title });
		// On the card, not just in the detail view: otherwise an update could
		// only be found by opening every package in turn.
		if (this.isOutdated(pkg)) {
			card.createDiv({ cls: 'marketplace-badge', text: 'Update available' });
		}
		if (meta) card.createDiv({ cls: 'marketplace-card-meta', text: meta });
		if (pkg.description) {
			card.createDiv({ cls: 'marketplace-card-desc', text: pkg.description });
		}

		card.addEventListener('click', () => void this.showDetail(pkg));
	}

	// --- detail view ---

	private async showDetail(listed: Package) {
		this.renderMessage('Loading details...');

		let pkg = listed;
		try {
			// The list doesn't carry the folder structure, so fetch the full record.
			pkg = await fetchPackage(this.plugin.settings, listed.id);
		} catch (error) {
			console.error(error);
			// Missing structure isn't a reason to hide the rest of the detail view.
			new Notice('Failed to fetch the package structure');
		}

		this.bodyEl.empty();

		new ButtonComponent(this.bodyEl)
			.setButtonText('Back to list')
			.onClick(() => this.renderList());

		const detail = this.bodyEl.createDiv({ cls: 'marketplace-detail' });
		detail.createEl('h3', { text: pkg.title });

		const meta = [
			pkg.author,
			formatDate(pkg.createdAt),
			pkg.updatedAt ? `updated ${formatDate(pkg.updatedAt)}` : '',
		]
			.filter(Boolean)
			.join(' · ');
		if (meta) detail.createDiv({ cls: 'marketplace-card-meta', text: meta });

		if (pkg.tags.length > 0) {
			const tagRow = detail.createDiv({ cls: 'marketplace-tags' });
			for (const tag of pkg.tags) {
				const chip = tagRow.createSpan({ cls: 'marketplace-tag', text: `#${tag}` });
				// Clicking a tag returns to the list, pre-filtered to it.
				chip.addEventListener('click', () => {
					this.tagFilter = tag;
					this.renderList();
				});
			}
		}

		detail.createEl('h4', { text: 'Description' });
		detail.createDiv({
			cls: 'marketplace-detail-desc',
			text: pkg.description || 'The author did not add a description.',
		});

		detail.createEl('h4', { text: 'Contents' });
		this.renderStructure(detail, pkg.structure);

		const installed = this.resolveInstalled(pkg.id);
		if (installed) {
			detail.createDiv({
				cls: 'marketplace-detail-desc',
				text: `Installed at: ${installed.folder.path} (v${installed.record.version})`,
			});
		}

		const actions = detail.createDiv({ cls: 'marketplace-card-actions' });
		const download = new ButtonComponent(actions)
			.setButtonText(
				installed && installed.record.version < pkg.version
					? `Update (v${installed.record.version} → v${pkg.version})`
					: 'Download',
			)
			.setCta();
		download.onClick(() => void this.download(pkg, download));

		// A UI hint, not a security check — ownership is verified server-side.
		if (pkg.authorId && pkg.authorId === this.plugin.settings.userId) {
			armButton(new ButtonComponent(actions), 'Delete', 'Are you sure?', () => {
				void this.remove(pkg);
			});
		}
	}

	private renderStructure(parent: HTMLElement, paths: string[]) {
		if (paths.length === 0) {
			parent.createDiv({
				cls: 'marketplace-tree-empty',
				text: 'This package was published before we started saving folder structure.',
			});
			return;
		}

		const tree = parent.createDiv({ cls: 'marketplace-tree' });
		renderNode(tree, buildTree(paths), 0);
		parent.createDiv({
			cls: 'marketplace-tree-count',
			text: `Files: ${paths.length}`,
		});
	}

	// --- actions ---

	private async download(pkg: Package, button: ButtonComponent) {
		// Disable immediately: the download takes time, and three clicks
		// would create three copies.
		button.setDisabled(true);
		button.setButtonText('Downloading...');

		try {
			const archive = await downloadPackageArchive(this.plugin.settings, pkg.id);
			// Validation and writing are separate steps because a
			// confirmation prompt can sit between them. No file exists in
			// the vault until this point.
			const plan = await inspectArchive(archive);

			// An installed copy is updated in place; everything else is a
			// fresh install into a new folder, exactly as before.
			const installed = this.resolveInstalled(pkg.id);
			if (installed !== null) {
				const update = await planUpdate(
					this.app,
					plan,
					installed.folder.path,
					installed.record.installedAt,
				);
				this.confirmUpdate(pkg, plan, update, button);
				return;
			}

			if (plan.findings.length > 0) {
				this.confirmInstall(pkg, plan, button);
				return;
			}

			await this.write(pkg, plan, button);
		} catch (error) {
			this.failDownload(error, button);
		}
	}

	/**
	 * Asks for confirmation before someone else's active content lands in
	 * the vault.
	 *
	 * A package is notes that are about to be opened, and a ```dataviewjs
	 * block or Templater command runs with the app's full permissions. The
	 * user needs to see this before the write happens, not after.
	 */
	private confirmInstall(pkg: Package, plan: PackagePlan, button: ButtonComponent) {
		this.bodyEl.empty();
		this.bodyEl.createEl('h3', { text: `Review contents: ${pkg.title}` });
		this.bodyEl.createDiv({
			cls: 'marketplace-detail-desc',
			text:
				`This package has ${plan.files.length} files (${formatBytes(plan.totalBytes)}) and contains content ` +
				'that may execute or connect to the network when a note is opened. ' +
				'Only install from an author you trust.',
		});

		renderFindings(this.bodyEl, plan.findings);

		renderConfirmRow(
			this.bodyEl,
			'I understand, download anyway',
			() => void this.write(pkg, plan, button),
			() => void this.showDetail(pkg),
		);
	}

	/**
	 * Asks before writing over an installed package.
	 *
	 * Unlike the install prompt, this one is unconditional: even a clean
	 * archive overwrites files the user may have edited, so the question is
	 * about the write plan, not only about active content.
	 */
	private confirmUpdate(pkg: Package, plan: PackagePlan, update: UpdatePlan, button: ButtonComponent) {
		const modified = update.writes.filter((write) => write.status === 'modified');
		const count = (status: string) => update.writes.filter((write) => write.status === status).length;

		this.bodyEl.empty();
		this.bodyEl.createEl('h3', { text: `Update: ${pkg.title}` });
		this.bodyEl.createDiv({
			cls: 'marketplace-detail-desc',
			text:
				`Writing into ${update.root}: ${count('new')} new, ${count('changed')} replaced, ` +
				`${modified.length} of your own edits, ${count('identical')} unchanged. ` +
				'Files that are not part of the package are left alone.',
		});

		if (modified.length > 0) {
			this.bodyEl.createEl('h4', { text: `Edited since you installed (${modified.length})` });
			const list = this.bodyEl.createDiv({ cls: 'marketplace-findings' });
			for (const write of modified) {
				const row = list.createDiv({ cls: 'marketplace-finding marketplace-finding-warning' });
				row.createDiv({ cls: 'marketplace-finding-label', text: 'Moved to trash, then replaced' });
				row.createDiv({ cls: 'marketplace-finding-path', text: write.file.path });
			}
		}

		renderFindings(this.bodyEl, plan.findings);

		renderConfirmRow(
			this.bodyEl,
			'Update',
			() => void this.writeUpdate(pkg, update, button),
			() => void this.showDetail(pkg),
		);
	}

	private async writeUpdate(pkg: Package, update: UpdatePlan, button: ButtonComponent) {
		try {
			await applyUpdate(this.app, update);
			this.rememberInstall(pkg, update.root);
			await this.plugin.saveSettings();

			new Notice(`Updated: ${update.root}`);
			void this.showDetail(pkg);
		} catch (error) {
			// The record is deliberately left at the old version: the update
			// stays on offer, and repeating it skips whatever already landed.
			this.failDownload(error, button);
		}
	}

	/** Writes to the vault — the only place files actually get created. */
	private async write(pkg: Package, plan: PackagePlan, button: ButtonComponent) {
		try {
			const folder = await installPlan(
				this.app,
				plan,
				this.plugin.settings.downloadFolder,
				pkg.title,
			);

			this.rememberInstall(pkg, folder);
			// Saved BEFORE the redraw: showDetail() reads the record to pick
			// the button label and the "Installed at" line.
			await this.plugin.saveSettings();

			new Notice(`Downloaded to: ${folder}`);
			void this.showDetail(pkg);
		} catch (error) {
			this.failDownload(error, button);
		}
	}

	// --- install records ---

	/**
	 * Records where a package landed. The timestamp is taken here, AFTER the
	 * writes: createBinary() sets mtime to now, so one captured earlier would
	 * make the next update read every file we just wrote as a user edit.
	 */
	private rememberInstall(pkg: Package, path: string) {
		this.plugin.settings.installs[pkg.id] = {
			path,
			version: pkg.version,
			installedAt: Date.now(),
		};
	}

	/**
	 * The folder an installed package lives in, or null if the record no
	 * longer holds — the user may have deleted or renamed it. A stale record
	 * is dropped rather than repaired: without it the package simply installs
	 * fresh, which is the pre-update behaviour and always safe.
	 */
	private resolveInstalled(id: string): { folder: TFolder; record: InstallRecord } | null {
		const record = this.plugin.settings.installs[id];
		if (!record) return null;

		const folder = resolveInstall(this.app, record.path);
		if (folder === null) {
			delete this.plugin.settings.installs[id];
			void this.plugin.saveSettings();
			return null;
		}

		return { folder, record };
	}

	private isOutdated(pkg: Package): boolean {
		const record = this.plugin.settings.installs[pkg.id];
		return record !== undefined && record.version < pkg.version;
	}

	private failDownload(error: unknown, button: ButtonComponent) {
		// The console gets the full stack trace, the user gets one readable sentence.
		console.error(error);
		new Notice('Download error: ' + (error instanceof Error ? error.message : String(error)));

		// A failed download shouldn't remove the ability to retry.
		button.setDisabled(false);
		button.setButtonText('Download');
	}

	private async remove(pkg: Package) {
		try {
			await deletePackage(this.plugin.settings, pkg.id);
			new Notice(`Deleted: ${pkg.title}`);
			// Reload instead of patching the list in place — the view
			// should reflect server state, not our guess at it.
			void this.load();
		} catch (error) {
			console.error(error);
			new Notice(
				error instanceof UnauthorizedError
					? 'The server rejected the token. Check the plugin settings.'
					: 'Delete error: ' + (error instanceof Error ? error.message : String(error)),
			);
		}
	}
}

// --- file tree ---

interface TreeNode {
	name: string;
	children: Map<string, TreeNode>;
	isFile: boolean;
}

/** Turns a flat list of ZIP paths into a nested tree for display. */
function buildTree(paths: string[]): TreeNode {
	const root: TreeNode = { name: '', children: new Map(), isFile: false };

	for (const path of paths) {
		const parts = path.split('/').filter((part) => part.length > 0);
		let node = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i] as string;
			const isLast = i === parts.length - 1;

			let child = node.children.get(part);
			if (!child) {
				child = { name: part, children: new Map(), isFile: isLast };
				node.children.set(part, child);
			}
			node = child;
		}
	}

	return root;
}

function renderNode(parent: HTMLElement, node: TreeNode, depth: number) {
	// Folders before files, then alphabetical — same order as Obsidian's file explorer.
	const children = [...node.children.values()].sort((a, b) => {
		if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
		return a.name.localeCompare(b.name, 'en');
	});

	for (const child of children) {
		const row = parent.createDiv({ cls: 'marketplace-tree-row' });
		row.style.paddingLeft = `${depth * 16}px`;
		row.createSpan({
			cls: 'marketplace-tree-icon',
			text: child.isFile ? '📄' : '📁',
		});
		row.createSpan({ text: child.name });

		if (!child.isFile) renderNode(parent, child, depth + 1);
	}
}

/** ISO-8601 to a locale-formatted date. Empty stays empty. */
function formatDate(iso: string): string {
	if (!iso) return '';
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US');
}
