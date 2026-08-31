import { Plugin, TFolder } from 'obsidian';
import {
	DEFAULT_SETTINGS,
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
		// A blind copy would keep it around forever.
		this.settings = { ...DEFAULT_SETTINGS };
		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MarketplaceSettings)[]) {
			const value = stored[key];
			if (typeof value === 'string') this.settings[key] = value;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
