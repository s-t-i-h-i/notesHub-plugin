import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { TextComponent } from 'obsidian';
import MarketplacePlugin from './main';
import { assertSafeApiUrl, TOKEN_RE, UnauthorizedError } from './api/api';
import { API_BASE_URL } from './constants';
import { closeAccount, fetchMe, revokeToken } from './api/accountApi';
import { armButton } from './ui';

export interface MarketplaceSettings {
	/** Access token. The publish author comes from this, never from a form field. */
	token: string;
	/** Username from the server, for display only — /me is the source of truth. */
	username: string;
	/** Compared against a package's author_id to show "Delete" only on your own packages. */
	userId: string;
	downloadFolder: string;
}

export const DEFAULT_SETTINGS: MarketplaceSettings = {
	token: '',
	username: '',
	userId: '',
	downloadFolder: 'marketplace-downloads'
};

export class MarketplaceSettingTab extends PluginSettingTab {
	plugin: MarketplacePlugin;

	constructor(app: App, plugin: MarketplacePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Account for publishing notes').setHeading();
		if (this.plugin.settings.token) {
			this.renderLoggedIn(containerEl);
		} else {
			this.renderLoggedOut(containerEl);
		}

		new Setting(containerEl).setName('Downloads').setHeading();
		new Setting(containerEl)
			.setName('Download folder')
			.setDesc('Folder where packages downloaded from the marketplace end up.')
			.addText((text) =>
				text.setValue(this.plugin.settings.downloadFolder).onChange(async (value) => {
					this.plugin.settings.downloadFolder = value;
					await this.plugin.saveSettings();
				}),
			);
	}

	// --- logged out ---

	private renderLoggedOut(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Sign in with GitHub')
			.setDesc('Opens github.com in your browser. Copy the token you get there and paste it below.')
			.addButton((button) =>
				button
					.setButtonText('Connect GitHub')
					.setCta()
					// Built from the same checked address as every other request, so a
					// bad API address can't turn this button into a phishing link.
					.onClick(() => window.open(`${assertSafeApiUrl(API_BASE_URL)}/auth/github`)),
			);

		this.renderTokenField(containerEl);
	}

	// --- logged in ---

	private renderLoggedIn(containerEl: HTMLElement): void {
		const who = this.plugin.settings.username || '(unknown name)';

		new Setting(containerEl)
			.setName(`Logged in as: ${who}`)
			.setDesc('Checks that this device is still signed in, and how many others are.')
			.addButton((button) =>
				button.setButtonText('Refresh').onClick(async () => {
					try {
						const account = await fetchMe(this.plugin.settings);
						await this.rememberIdentity(account);
						new Notice(
							`Signed in as ${account.username}. Devices signed in: ` +
								`${account.devices} of ${account.deviceLimit}.`,
						);
						this.display();
					} catch (error) {
						new Notice(this.describe(error, 'Connection error'));
					}
				}),
			);

		// A reversible action, so it lives next to the regular settings, not
		// in the danger zone below.
		new Setting(containerEl)
			.setName('Log out on this device')
			.setDesc('Signs out of this vault only. Other devices keep working, and signing in with GitHub brings you straight back.')
			.addButton((button) =>
				button.setButtonText('Log out').onClick(async () => {
					await this.forgetIdentity();
					new Notice('Signed out on this device. Sign in with GitHub to come back.');
					this.display();
				}),
			);

		this.renderDangerZone(containerEl);
	}

	/** Account-wide actions, kept away from the everyday ones. */
	private renderDangerZone(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('Revoke this device on the server')
			.setDesc(
				'Ends this device\'s access on the server, not just here — use it if the token you pasted ' +
					'leaked. Other devices are unaffected, and signing in with GitHub gets you back in.',
			)
			.addButton((button) =>
				armButton(button, 'Revoke', 'Are you sure?', () => {
					void (async () => {
						try {
							await revokeToken(this.plugin.settings);
							new Notice('This device no longer has access.');
						} catch (error) {
							console.error(error);
							new Notice('The server could not be reached — signing out here only.');
						}
						// Clear the local token even if the server call
						// failed — otherwise the user thinks it's revoked
						// when it still works.
						await this.forgetIdentity();
						this.display();
					})();
				}),
			);

		new Setting(containerEl)
			.setName('Close account')
			.setDesc(
				'Deletes the account, every device signed in to it, and all published packages. This cannot ' +
					'be undone — signing in with GitHub afterwards starts a brand-new account.',
			)
			.addButton((button) =>
				armButton(button, 'Close account', 'Delete everything?', () => {
					void (async () => {
						try {
							const removed = await closeAccount(this.plugin.settings);
							await this.forgetIdentity();
							new Notice(`Account closed. Packages deleted: ${removed}.`);
							this.display();
						} catch (error) {
							new Notice(this.describe(error, 'Failed to close account'));
						}
					})();
				}),
			);
	}

	/**
	 * The token input field.
	 *
	 * `addText()`'s callback runs synchronously while the `Setting` chain is
	 * still being built, so it can't reference `const setting` yet — that
	 * throws "Cannot access before initialization". The component is stored
	 * in `input` instead, and extra buttons are added after the chain ends.
	 */
	private renderTokenField(containerEl: HTMLElement): void {
		let input: TextComponent | null = null;

		const setting = new Setting(containerEl)
			.setName('Paste your token')
			.setDesc(
				'The token from the GitHub page, or one you saved earlier. It starts with omp_ and is ' +
					'68 characters long.' +
					// The server address can't be changed anymore, but it's
					// still useful to see where the token is going — e.g. to
					// tell a dev build apart from production.
					` Account runs on: ${API_BASE_URL}`,
			)
			.addText((text) => {
				input = text;
				text.inputEl.type = 'password'; // mask it in the UI
				text
					.setPlaceholder('Paste token')
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						const token = value.trim();
						this.plugin.settings.token = token;

						// Pasting a different token clears the cached
						// identity — otherwise "Delete" would still show up
						// on the previous account's packages.
						if (!TOKEN_RE.test(token)) {
							this.plugin.settings.username = '';
							this.plugin.settings.userId = '';
						}
						await this.plugin.saveSettings();
					});
			});

		// Reveal exists to check a paste that went wrong — a truncated token
		// is otherwise indistinguishable from a correct one behind the dots.
		setting.addExtraButton((extra) =>
			extra
				.setIcon('eye')
				.setTooltip('Show or hide token')
				.onClick(() => {
					if (!input) return;
					const hidden = input.inputEl.type === 'password';
					input.inputEl.type = hidden ? 'text' : 'password';
					extra.setIcon(hidden ? 'eye-off' : 'eye');
				}),
		);

		setting.addButton((button) =>
			button
				.setButtonText('Log in')
				.setCta()
				.onClick(async () => {
					try {
						const account = await fetchMe(this.plugin.settings);
						await this.rememberIdentity(account);
						new Notice(`Signed in as ${account.username}`);
						this.display();
					} catch (error) {
						new Notice(this.describe(error, 'Failed to log in'));
					}
				}),
		);
	}

	// --- helpers ---

	/** The server is the source of truth for identity; the local copy just tracks it. */
	private async rememberIdentity(account: { username: string; userId: string }): Promise<void> {
		this.plugin.settings.username = account.username;
		this.plugin.settings.userId = account.userId;
		await this.plugin.saveSettings();
	}

	private async forgetIdentity(): Promise<void> {
		this.plugin.settings.token = '';
		this.plugin.settings.username = '';
		this.plugin.settings.userId = '';
		await this.plugin.saveSettings();
	}

	private describe(error: unknown, prefix: string): string {
		if (error instanceof UnauthorizedError) {
			return 'The server rejected the token. Paste it again, or sign in with GitHub for a new one.';
		}
		return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
	}
}
