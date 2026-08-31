import { Plugin, TFolder } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	InstallRecord,
	MarketplaceSettings,
	MarketplaceSettingTab,
} from './settings';
import { openPublishModal } from './publishModal';
import { openMarketplaceModal } from './marketplaceModal';

export default class MarketplacePlugin extends Plugin {
	settings!: MarketplaceSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'open-marketplace',
			name: 'Open marketplace',
			callback: () => openMarketplaceModal(this),
		});

		// Adds "Publish" to a folder's right-click menu.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFolder)) return;

				menu.addItem((item) =>
					item
						.setTitle('Publish')
						.setIcon('upload')
						.onClick(() => openPublishModal(this, file)),
				);
			}),
		);

		this.addSettingTab(new MarketplaceSettingTab(this.app, this));
	}

	async loadSettings() {
		const stored = ((await this.loadData()) ?? {}) as Record<string, unknown>;

		// Copy only known keys instead of Object.assign: the API address used
		// to be a setting, and an old data.json could still have that field.
		// A blind copy would keep it around forever. A new string setting
		// belongs in this list, or it will never load.
		this.settings = { ...DEFAULT_SETTINGS };
		for (const key of ['token', 'username', 'userId', 'downloadFolder'] as const) {
			const value = stored[key];
			if (typeof value === 'string') this.settings[key] = value;
		}

		// Listed separately rather than loosening the loop to "string or
		// object": that would also let a hand-edited data.json put an object
		// on `token`, and typeof [] is 'object' too.
		this.settings.installs = readInstalls(stored.installs);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/**
 * Validates the install records read from data.json.
 *
 * That file is hand-editable, and these records point at folders we later
 * write into, so this is a trust boundary rather than a formality. NaN is
 * the dangerous shape: `mtime > NaN` is false, so every file would look
 * untouched and the branch that rescues the user's edits would never fire.
 */
function readInstalls(value: unknown): Record<string, InstallRecord> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

	const installs: Record<string, InstallRecord> = {};
	for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
		const record = raw as Partial<InstallRecord> | null;
		if (typeof record?.path !== 'string' || !record.path) continue;
		if (!Number.isFinite(record.version) || !Number.isFinite(record.installedAt)) continue;

		installs[id] = {
			path: record.path,
			version: record.version as number,
			installedAt: record.installedAt as number,
			// Absent on records written before the Downloaded tab existed, and
			// defaulted rather than rejected: a missing label is a blank card,
			// not a reason to forget where a package is installed.
			title: typeof record.title === 'string' ? record.title : '',
			author: typeof record.author === 'string' ? record.author : '',
		};
	}

	return installs;
}
