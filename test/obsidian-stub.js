// Minimal Obsidian stand-in: enough to render a settings tab headlessly.
export const normalizePath = (p) => p;

class El {
	constructor(tag = 'div') { this.tag = tag; this.type = ''; this.children = []; this.isConnected = true; this.classes = new Set(); }
	empty() { this.children.length = 0; }
	createEl(tag) { const e = new El(tag); this.children.push(e); return e; }
	createDiv() { return this.createEl('div'); }
	addClass(c) { this.classes.add(c); }
	removeClass(c) { this.classes.delete(c); }
	setText(t) { this.text = t; }
}

class TextComponent {
	constructor() { this.inputEl = new El('input'); this.value = ''; }
	setPlaceholder() { return this; }
	setValue(v) { this.value = v; return this; }
	onChange(cb) { this.onChangeCb = cb; return this; }
}

class ButtonComponent {
	constructor() { this.buttonEl = new El('button'); this.text = ''; }
	setButtonText(t) { this.text = t; return this; }
	setCta() { this.cta = true; return this; }
	setWarning() { this.warning = true; return this; }
	setIcon(i) { this.icon = i; return this; }
	setTooltip(t) { this.tooltip = t; return this; }
	onClick(cb) { this.onClickCb = cb; return this; }
}

export class Setting {
	constructor(containerEl) {
		this.name = ''; this.desc = ''; this.heading = false;
		this.buttons = []; this.texts = []; this.extras = [];
		if (containerEl && containerEl.settings) containerEl.settings.push(this);
	}
	setName(n) { this.name = n; return this; }
	setDesc(d) { this.desc = d; return this; }
	setHeading() { this.heading = true; return this; }
	addText(cb) { const t = new TextComponent(); this.texts.push(t); cb(t); return this; }
	addButton(cb) { const b = new ButtonComponent(); this.buttons.push(b); cb(b); return this; }
	addExtraButton(cb) { const b = new ButtonComponent(); this.extras.push(b); cb(b); return this; }
	addDropdown(cb) { const d = { addOption: () => d, setValue: () => d, onChange: () => d }; cb(d); return this; }
	addToggle(cb) { const t = { setValue: () => t, onChange: () => t }; cb(t); return this; }
}

export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app; this.plugin = plugin;
		this.containerEl = new El(); this.containerEl.settings = [];
		this.containerEl.empty = () => { this.containerEl.settings.length = 0; };
	}
}

export class Notice { constructor(msg) { Notice.all.push(String(msg)); } }
Notice.all = [];

export class Plugin { constructor() {} addCommand() {} registerEvent() {} addSettingTab() {} }
export class Modal { constructor() {} open() {} close() {} }
export class App {}
export class TFile {}
export class TFolder {}
export const requestUrl = async () => ({ status: 200, json: {}, text: '{}', arrayBuffer: new ArrayBuffer(0) });
export const Platform = { isDesktop: true, isMobile: false };
