import { ButtonComponent, Modal, Notice, Setting, TFolder, normalizePath, setIcon } from 'obsidian';
import type MarketplacePlugin from './main';
import type { InstallRecord } from './settings';
import {
	Package,
	deletePackage,
	downloadPackageArchive,
	fetchPackage,
	fetchPackages,
	fetchTags,
	type SortKey,
} from './api/packagesApi';
import {
	applyUpdate,
	inspectArchive,
	installPlan,
	findShadowedNotes,
	formatBytes,
	planUpdate,
	type PackagePlan,
	type UpdatePlan,
} from './installs';
import { UnauthorizedError } from './api/api';
import { armButton } from './ui';
import { renderManifest, renderConfirmRow } from './review';
import { readContext } from './context';
import { POLICY_VERSION, type Finding } from './policy/types';

const SORT_LABELS: Record<SortKey, string> = {
	newest: 'Newest',
	oldest: 'Oldest',
	title: 'Title A-Z',
};

type TabKey = 'browse' | 'mine' | 'downloaded';

const TAB_LABELS: Record<TabKey, string> = {
	browse: 'Browse',
	mine: 'My packages',
	downloaded: 'Downloaded',
};

const ALL_TAGS = '';

/** Catalog page size. Matches the server's default, so a short page means the end of the list. */
const PAGE_SIZE = 20;

/** Opens the package library. The server address is baked in at build time, nothing to check here. */
export function openMarketplaceModal(plugin: MarketplacePlugin): void {
	new MarketplaceModal(plugin).open();
}

export class MarketplaceModal extends Modal {
	private plugin: MarketplacePlugin;
	private bodyEl!: HTMLElement;

	/** Pages loaded so far, not the whole catalog. */
	private packages: Package[] = [];
	private tags: string[] = [];

	private tab: TabKey = 'browse';
	private tagFilter: string = ALL_TAGS;
	private sortBy: SortKey = 'newest';

	private offset = 0;
	private loading = false;
	private exhausted = false;

	/** Installed packages the server no longer lists — deleted, or the author was banned. */
	private orphans = new Set<string>();

	private observer: IntersectionObserver | null = null;

	constructor(plugin: MarketplacePlugin) {
		super(plugin.app);
		// super() consumes and discards the plugin argument, but settings are needed later for downloads.
		this.plugin = plugin;
	}

	onOpen() {
		this.modalEl.addClass('marketplace-modal');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Notes hub' });
		// A separate container for the content: only this gets re-rendered, the heading stays.
		this.bodyEl = contentEl.createDiv();

		void this.load();
	}

	onClose() {
		this.observer?.disconnect();
		this.observer = null;
		this.contentEl.empty();
	}

	private async load() {
		await this.loadTags();
		await this.reload();
	}

	/** Tag options are a nice-to-have — a failure here must not cost the user the list. */
	private async loadTags() {
		if (this.tags.length > 0) return;

		try {
			this.tags = await fetchTags(this.plugin.settings);
		} catch (error) {
			console.error(error);
		}
	}

	/** A tab or filter change is a new first page, not a re-sort of what is on screen. */
	private async reload() {
		this.renderMessage('Loading...');

		try {
			await this.loadPage(true);
			this.renderList();
		} catch (error) {
			console.error(error);
			const reason = error instanceof Error ? error.message : String(error);
			this.renderError(`Failed to fetch packages: ${reason}`);
		}
	}

	// --- paging ---

	/**
	 * Loads one page into `packages`. `reset` starts over from offset 0.
	 *
	 * Filtering and sorting are the server's job: over a paged list a
	 * client-side tag filter could empty page 1 while page 4 is full of
	 * matches.
	 */
	private async loadPage(reset: boolean): Promise<void> {
		if (this.loading) return;
		if (!reset && this.exhausted) return;

		this.loading = true;
		try {
			if (reset) {
				this.packages = [];
				this.offset = 0;
				this.exhausted = false;
				this.orphans.clear();
			}

			if (this.tab === 'downloaded') {
				this.loadInstalled();
				return;
			}

			// Nothing to ask for: an empty author_id is dropped from the query,
			// and the server would answer with the whole catalog instead.
			if (this.tab === 'mine' && !this.plugin.settings.userId) {
				this.exhausted = true;
				return;
			}

			const page = await fetchPackages(this.plugin.settings, {
				limit: PAGE_SIZE,
				offset: this.offset,
				sort: this.sortBy,
				tag: this.tagFilter,
				...(this.tab === 'mine' ? { authorId: this.plugin.settings.userId } : {}),
			});

			this.absorb(page);
			// A short page is the end of the list — there is no total to read.
			this.exhausted = page.length < PAGE_SIZE;
		} finally {
			this.loading = false;
		}
	}

	/**
	 * Appends a page, skipping ids already on screen.
	 *
	 * OFFSET paging shifts rows when someone publishes mid-scroll, so the same
	 * package can arrive twice. `offset` still advances by the full page
	 * length — counting only the new rows would re-request the same window
	 * forever.
	 */
	private absorb(page: Package[]) {
		const seen = new Set(this.packages.map((pkg) => pkg.id));
		for (const pkg of page) {
			if (!seen.has(pkg.id)) this.packages.push(pkg);
		}

		this.offset += page.length;
	}

	/**
	 * The Downloaded tab reads local state, not the catalog.
	 *
	 * `settings.installs` is what is actually installed — resolveInstalled()
	 * already treats it that way for updates. Asking the server for this list
	 * would blank the tab offline and hide packages whose files are still in
	 * the vault after the author deleted them.
	 */
	private loadInstalled() {
		this.packages = Object.entries(this.plugin.settings.installs).map(([id, record]) =>
			recordAsPackage(id, record),
		);
		// ponytail: one screen, no paging — install counts are in the tens.
		this.exhausted = true;
	}

	/**
	 * Fills in current versions for the Downloaded tab.
	 *
	 * A record only knows the version it installed, so without this the tab
	 * could never show an "Update available" badge. Failure is silent on
	 * purpose: the list is already on screen and already correct.
	 */
	private async enrichInstalled(grid: HTMLElement) {
		const ids = this.packages.map((pkg) => pkg.id);
		if (ids.length === 0) return;

		let current: Package[];
		try {
			current = await fetchPackages(this.plugin.settings, { ids });
		} catch (error) {
			console.error(error);
			return;
		}

		const byId = new Map(current.map((pkg) => [pkg.id, pkg]));
		// The server's copy carries the real version, description and tags.
		this.packages = this.packages.map((pkg) => byId.get(pkg.id) ?? pkg);
		this.orphans = new Set(ids.filter((id) => !byId.has(id)));

		// The user may have switched tabs while this was in flight.
		if (grid.isConnected) {
			grid.empty();
			this.paintCards(grid);
		}
	}

	// --- shared rendering ---

	/**
	 * Empties the body, taking the scroll observer with it.
	 *
	 * Every view stomps bodyEl, so the disconnect belongs here rather than
	 * repeated in each render method — one of them would eventually forget.
	 */
	private clearBody() {
		this.observer?.disconnect();
		this.observer = null;
		this.bodyEl.empty();
	}

	/** A simple message, used while loading. */
	private renderMessage(text: string) {
		this.clearBody();
		this.bodyEl.createDiv({ text });
	}

	/** An error panel with a retry button — the network can be flaky. */
	private renderError(text: string) {
		this.clearBody();
		const box = renderEmpty(this.bodyEl, 'alert-triangle', 'Something went wrong.', text);
		new ButtonComponent(box)
			.setButtonText('Try again')
			.setCta()
			.onClick(() => void this.load());
	}

	// --- list view ---

	private renderList() {
		this.clearBody();
		this.renderTabs();

		// Downloaded is a local list of tens of items sorted by nothing in
		// particular; a tag filter there would be a control the server can't
		// honour for it.
		if (this.tab !== 'downloaded') this.renderToolbar();

		if (this.packages.length === 0) {
			this.renderEmptyState();
			return;
		}

		this.renderGrid();
	}

	private renderTabs() {
		const row = this.bodyEl.createDiv({ cls: 'marketplace-tabs' });

		for (const [key, label] of Object.entries(TAB_LABELS)) {
			const tab = row.createDiv({ cls: 'marketplace-tab', text: label });
			if (key === this.tab) tab.addClass('is-active');

			tab.addEventListener('click', () => {
				if (this.tab === key) return;
				this.tab = key as TabKey;
				// Downloaded has no toolbar, so a tag left set there would be
				// a filter with no visible way to clear it.
				this.tagFilter = ALL_TAGS;
				void this.reload();
			});
		}
	}

	private renderToolbar() {
		new Setting(this.bodyEl)
			.setName('Tags and order')
			.addDropdown((dropdown) => {
				dropdown.addOption(ALL_TAGS, 'All tags');
				for (const tag of this.tags) {
					dropdown.addOption(tag, `#${tag}`);
				}
				dropdown.setValue(this.tagFilter).onChange((value) => {
					this.tagFilter = value;
					void this.reload();
				});
			})
			.addDropdown((dropdown) => {
				for (const [key, label] of Object.entries(SORT_LABELS)) {
					dropdown.addOption(key, label);
				}
				dropdown.setValue(this.sortBy).onChange((value) => {
					this.sortBy = value as SortKey;
					void this.reload();
				});
			});
	}

	/** Why the list is empty matters more than the fact that it is. */
	private renderEmptyState() {
		if (this.tagFilter) {
			renderEmpty(
				this.bodyEl,
				'search-x',
				`No packages tagged #${this.tagFilter}.`,
				'Pick "All tags" to see everything.',
			);
			return;
		}

		if (this.tab === 'mine') {
			if (this.plugin.settings.userId) {
				renderEmpty(
					this.bodyEl,
					'upload',
					"You haven't published anything yet.",
					'Right-click a folder in the file explorer and pick "Publish".',
				);
			} else {
				renderEmpty(
					this.bodyEl,
					'user-x',
					'Log in to see your packages.',
					'Connect your GitHub account in the plugin settings.',
				);
			}
			return;
		}

		if (this.tab === 'downloaded') {
			renderEmpty(
				this.bodyEl,
				'download',
				"You haven't downloaded anything yet.",
				'Packages you install from Browse show up here.',
			);
			return;
		}

		renderEmpty(this.bodyEl, 'library', 'The library is empty.');
	}

	private renderGrid() {
		const grid = this.bodyEl.createDiv({ cls: 'marketplace-grid' });
		this.paintCards(grid);

		if (this.tab === 'downloaded') {
			void this.enrichInstalled(grid);
			return;
		}

		if (this.exhausted) return;

		this.watch(grid, this.bodyEl.createDiv({ cls: 'marketplace-sentinel' }));
	}

	/** Appends only the cards not on screen yet, so a page load never disturbs scroll position. */
	private paintCards(grid: HTMLElement) {
		for (const pkg of this.packages.slice(grid.childElementCount)) {
			this.renderCard(grid, pkg);
		}
	}

	/** Arms the sentinel. Also the retry path, which is why it is separate from renderGrid(). */
	private watch(grid: HTMLElement, sentinel: HTMLElement) {
		sentinel.empty();
		sentinel.setText('Loading more...');

		// contentEl IS the modal's .modal-content — the element that actually
		// scrolls — so it is the observer root, not the viewport.
		this.observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) void this.loadMore(grid, sentinel);
			},
			{ root: this.contentEl, rootMargin: '200px' },
		);
		this.observer.observe(sentinel);
	}

	/**
	 * Pulls the next page.
	 *
	 * A failure here leaves the loaded pages alone and offers a retry in the
	 * sentinel: throwing away twenty cards the user is reading because page
	 * three timed out would be worse than the error itself.
	 */
	private async loadMore(grid: HTMLElement, sentinel: HTMLElement) {
		if (this.loading || this.exhausted) return;

		try {
			await this.loadPage(false);
		} catch (error) {
			console.error(error);
			this.observer?.disconnect();
			this.observer = null;

			sentinel.empty();
			sentinel.createSpan({
				text: error instanceof Error ? error.message : String(error),
			});
			new ButtonComponent(sentinel)
				.setButtonText('Try again')
				.onClick(() => this.watch(grid, sentinel));
			return;
		}

		this.paintCards(grid);

		if (this.exhausted) {
			this.observer?.disconnect();
			this.observer = null;
			sentinel.remove();
		}
	}

	/** One package card. Clicking it opens the detail view. */
	private renderCard(grid: HTMLElement, pkg: Package) {
		const meta = [pkg.author, ...pkg.tags.map((tag) => `#${tag}`)]
			.filter((part) => part.length > 0)
			.join(' · ');

		const card = grid.createDiv({ cls: 'marketplace-card mod-clickable' });
		card.createDiv({ cls: 'marketplace-card-title', text: pkg.title });
		// On the card, not just in the detail view: otherwise an update could
		// only be found by opening every package in turn. Read straight from
		// the record — the folder is resolved later, when it's a write target.
		const installed = this.plugin.settings.installs[pkg.id];
		if (installed && installed.version < pkg.version) {
			card.createDiv({ cls: 'marketplace-badge', text: 'Update available' });
		}
		// Still listed, because the files are still in the vault — the user
		// just can't get it again or update it.
		if (this.orphans.has(pkg.id)) {
			card.createDiv({ cls: 'marketplace-badge mod-muted', text: 'No longer published' });
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

		this.clearBody();

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
				// Browse, not the current tab: Downloaded has no tag filter.
				chip.addEventListener('click', () => {
					this.tab = 'browse';
					this.tagFilter = tag;
					void this.reload();
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

	/** A dead end with a reason, for the cases where continuing is not on offer. */
	private refuse(pkg: Package, reason: string) {
		this.clearBody();
		this.bodyEl.createEl('h3', { text: pkg.title });
		this.bodyEl.createDiv({ cls: 'marketplace-finding marketplace-finding-danger', text: reason });
		new Setting(this.bodyEl).addButton((button) => button.setButtonText('Back').setCta().onClick(() => void this.showDetail(pkg)));
	}

	private async download(pkg: Package, button: ButtonComponent) {
		// Disable immediately: the download takes time, and three clicks
		// would create three copies.
		button.setDisabled(true);
		button.setButtonText('Downloading...');

		try {
			// Withdrawn after the fact. The server answers 410 anyway; saying so
			// here means the reason reaches the reader instead of an HTTP code.
			if (pkg.revoked) {
				this.refuse(pkg, 'This package was withdrawn as malicious. If you have it installed, delete the folder.');
				return;
			}

			// The digest ties these bytes to the row the catalog described. Without
			// it the manifest shown a moment ago could belong to another archive.
			const archive = await downloadPackageArchive(this.plugin.settings, pkg.id, pkg.sha256);
			// Validation and writing are separate steps because a
			// confirmation prompt can sit between them. No file exists in
			// the vault until this point.
			const plan = await inspectArchive(archive);

			// An installed copy is updated in place; everything else is a
			// fresh install into a new folder, exactly as before.
			const installed = this.resolveInstalled(pkg.id);
			if (installed !== null) {
				// A package changing hands between versions is not an update,
				// and an update is not the moment to find that out silently.
				const owner = this.plugin.settings.installs[pkg.id]?.authorId ?? '';
				if (owner !== '' && pkg.authorId !== '' && owner !== pkg.authorId) {
					this.refuse(pkg, `This package now belongs to a different account (${pkg.author}). Updating it would install someone else's files.`);
					return;
				}

				const update = await planUpdate(
					this.app,
					archive,
					installed.folder.path,
					installed.record.installedAt,
				);
				this.confirmUpdate(pkg, archive, update, button);
				return;
			}

			this.confirmInstall(pkg, archive, plan, button);
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
	private confirmInstall(pkg: Package, archive: ArrayBuffer, plan: PackagePlan, button: ButtonComponent) {
		this.clearBody();
		this.bodyEl.createEl('h3', { text: `Install: ${pkg.title}` });
		this.bodyEl.createDiv({
			cls: 'marketplace-detail-desc',
			text: `${plan.paths.length} files, ${formatBytes(plan.totalBytes)}.`,
		});

		const shadowed = findShadowedNotes(this.app, plan.paths);
		if (shadowed.length > 0) {
			// Obsidian resolves [[Note]] by name across the whole vault, so
			// these would capture links in the reader's own notes.
			const row = this.bodyEl.createDiv({ cls: 'marketplace-finding marketplace-finding-warning' });
			row.createDiv({ cls: 'marketplace-finding-label', text: 'Some note names are already used in your vault' });
			row.createDiv({ cls: 'marketplace-finding-path', text: shadowed.slice(0, 10).join(', ') });
			row.createDiv({
				cls: 'marketplace-finding-path',
				text: 'Your existing [[links]] to those names may start pointing at this package instead.',
			});
		}

		const findings = describedBy(pkg);
		renderManifest(this.bodyEl, findings, readContext(this.app));

		// Not a warning to click past: it says what will actually happen. The
		// files arrive whole and readable, and nothing in them starts until
		// the reader switches it on.
		if (findings.some((found) => found.trigger === 'render')) {
			this.bodyEl.createDiv({
				cls: 'marketplace-detail-desc',
				text:
					'Anything that would run on its own is installed switched off. The code stays in the notes, ' +
					'and each block has a button to turn it on once you have read it.',
			});
		}

		if (pkg.policyVersion === 0) {
			// "Not described" must never look like "nothing to report".
			this.bodyEl.createDiv({
				cls: 'marketplace-detail-desc',
				text: 'The server has not described this package, so nothing above is a complete picture.',
			});
		} else if (pkg.policyVersion > POLICY_VERSION) {
			// Plugins update on their own schedule, so running behind the
			// server is normal — but then this plugin switches off fewer kinds
			// of block than the description above accounts for, and only it
			// knows that.
			this.bodyEl.createDiv({
				cls: 'marketplace-detail-desc',
				text:
					'This package was described by a newer version of the checker than your plugin has. ' +
					'Update the plugin before installing — some of the above may not be switched off correctly.',
			});
		}

		renderConfirmRow(
			this.bodyEl,
			'Install',
			() => void this.write(pkg, archive, plan, button),
			() => void this.showDetail(pkg),
			findings.length > 0,
		);
	}

	/**
	 * Asks before writing over an installed package.
	 *
	 * Unlike the install prompt, this one is unconditional: even a clean
	 * archive overwrites files the user may have edited, so the question is
	 * about the write plan, not only about active content.
	 */
	private confirmUpdate(pkg: Package, archive: ArrayBuffer, update: UpdatePlan, button: ButtonComponent) {
		const modified = update.writes.filter((write) => write.status === 'modified');
		const count = (status: string) => update.writes.filter((write) => write.status === status).length;

		this.clearBody();
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
				row.createDiv({ cls: 'marketplace-finding-path', text: write.path });
			}
		}

		this.renderNewCapabilities(pkg);
		renderManifest(this.bodyEl, describedBy(pkg), readContext(this.app));

		renderConfirmRow(
			this.bodyEl,
			'Update',
			() => void this.writeUpdate(pkg, archive, update, button),
			() => void this.showDetail(pkg),
		);
	}

	/**
	 * What this version asks for that the last one did not.
	 *
	 * A package can be harmless in version 1 and not in version 2. Showing the
	 * whole manifest again says nothing about that — the reader already agreed
	 * to it once. The difference is the only part that is new information.
	 */
	private renderNewCapabilities(pkg: Package) {
		const accepted = this.plugin.settings.installs[pkg.id]?.capabilities ?? [];
		const added = pkg.capabilities.filter((capability) => !accepted.includes(capability));
		if (added.length === 0) return;

		const row = this.bodyEl.createDiv({ cls: 'marketplace-finding marketplace-finding-danger' });
		row.createDiv({ cls: 'marketplace-finding-label', text: 'This version asks for more than the one you installed' });
		row.createDiv({ cls: 'marketplace-finding-path', text: added.join(', ') });
	}

	private async writeUpdate(pkg: Package, archive: ArrayBuffer, update: UpdatePlan, button: ButtonComponent) {
		try {
			await applyUpdate(this.app, archive, update);
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
	private async write(pkg: Package, archive: ArrayBuffer, plan: PackagePlan, button: ButtonComponent) {
		try {
			const folder = await installPlan(this.app, archive, pkg.title, this.plugin.settings.downloadFolder);

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
			// Cached so the Downloaded tab can draw this card without the network.
			title: pkg.title,
			author: pkg.author,
			capabilities: pkg.capabilities,
			authorId: pkg.authorId,
		};
	}

	/**
	 * The folder an installed package lives in, or null if the record no
	 * longer holds — the user may have deleted or renamed it. A stale record
	 * is dropped rather than repaired: without it the package simply installs
	 * fresh, which is the pre-update behaviour and always safe.
	 *
	 * Resolving through the vault index is also a security gate, not just a
	 * staleness check: the path comes from data.json, which is hand-editable,
	 * and it is a write target. The index only holds real in-vault paths, so
	 * a ".." never resolves — normalizePath() would not have stripped it.
	 */
	private resolveInstalled(id: string): { folder: TFolder; record: InstallRecord } | null {
		const record = this.plugin.settings.installs[id];
		if (!record) return null;

		const folder = this.app.vault.getAbstractFileByPath(normalizePath(record.path));
		if (!(folder instanceof TFolder)) {
			delete this.plugin.settings.installs[id];
			void this.plugin.saveSettings();
			return null;
		}

		return { folder, record };
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
			// Reload instead of patching the list in place — the view should
			// reflect server state, not our guess at it. Tags are cleared too:
			// that may have been the last package carrying one.
			this.tags = [];
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

/**
 * A synthetic Package for a local install record.
 *
 * Only the cached fields are real. `version` is the INSTALLED version, so no
 * update badge shows until enrichInstalled() swaps in the server's copy.
 */
function recordAsPackage(id: string, record: InstallRecord): Package {
	return {
		id,
		title: record.title || '(untitled)',
		description: '',
		author: record.author,
		authorId: '',
		tags: [],
		filename: '',
		createdAt: '',
		version: record.version,
		updatedAt: '',
		structure: [],
		capabilities: record.capabilities ?? [],
		manifest: null,
		sha256: '',
		policyVersion: 0,
		revoked: false,
	};
}

/**
 * The shared empty/error panel.
 *
 * Takes a parent instead of clearing the body: an empty tab still has to show
 * its tab strip, or there is no way to switch away from it.
 */
function renderEmpty(parent: HTMLElement, icon: string, title: string, hint = ''): HTMLElement {
	const box = parent.createDiv({ cls: 'marketplace-empty' });
	setIcon(box.createDiv({ cls: 'marketplace-empty-icon' }), icon);
	box.createDiv({ cls: 'marketplace-empty-title', text: title });
	if (hint) box.createDiv({ cls: 'marketplace-empty-hint', text: hint });
	return box;
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

/**
 * What the catalog says this package does.
 *
 * The server worked this out from the archive it received, and sha256 was
 * checked against these exact bytes before anything was unpacked — so
 * recomputing it here would run the same code over the same input for the same
 * answer. That second copy cost 118 kB of JavaScript parser in the plugin.
 */
function describedBy(pkg: Package): Finding[] {
	return pkg.manifest?.findings ?? [];
}
