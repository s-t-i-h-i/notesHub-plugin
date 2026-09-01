// Minimal Obsidian stand-in: enough to render a settings tab headlessly.
export const normalizePath = (p) => p;

class El {
	constructor(tag = 'div') { this.tag = tag; this.type = ''; this.children = []; this.isConnected = true; this.classes = new Set(); this.listeners = {}; }
	// childElementCount drives the append-only card painting, so it has to be real.
	get childElementCount() { return this.children.length; }
	empty() { for (const c of this.children) c.isConnected = false; this.children.length = 0; }
	createEl(tag, opts = {}) {
		const e = new El(tag);
		if (opts.text !== undefined) e.text = opts.text;
		if (opts.cls) for (const c of String(opts.cls).split(' ')) e.classes.add(c);
		e.parent = this;
		this.children.push(e);
		return e;
	}
	createDiv(opts) { return this.createEl('div', opts); }
	createSpan(opts) { return this.createEl('span', opts); }
	remove() {
		this.isConnected = false;
		const siblings = this.parent?.children;
		if (siblings) siblings.splice(siblings.indexOf(this), 1);
	}
	addClass(c) { this.classes.add(c); }
	removeClass(c) { this.classes.delete(c); }
	hasClass(c) { return this.classes.has(c); }
	addEventListener(name, cb) { (this.listeners[name] ??= []).push(cb); }
	click() { for (const cb of this.listeners.click ?? []) cb(); }
	setText(t) { this.text = t; }
	/** Flattened text of this element and everything under it — what a reader would see. */
	get allText() { return [this.text ?? '', ...this.children.map((c) => c.allText)].join(' ').trim(); }
	find(cls) { return this.classes.has(cls) ? this : this.children.map((c) => c.find(cls)).find(Boolean) ?? null; }
	findAll(cls) { return [...(this.classes.has(cls) ? [this] : []), ...this.children.flatMap((c) => c.findAll(cls))]; }
}

class TextComponent {
	constructor() { this.inputEl = new El('input'); this.value = ''; }
	setPlaceholder() { return this; }
	setValue(v) { this.value = v; return this; }
	onChange(cb) { this.onChangeCb = cb; return this; }
}

export class ButtonComponent {
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
export class Modal {
	constructor(app) { this.app = app; this.contentEl = new El(); this.modalEl = new El(); }
	open() {} close() {}
}

export const setIcon = (el, icon) => { el.icon = icon; };

/**
 * The infinite-scroll trigger, driven by hand.
 *
 * The real one fires from layout, which a headless run has none of, so tests
 * call scrollToBottom() to say "the sentinel came into view".
 */
class FakeIntersectionObserver {
	constructor(cb) { this.cb = cb; FakeIntersectionObserver.live.add(this); }
	observe(el) { this.target = el; }
	disconnect() { FakeIntersectionObserver.live.delete(this); }
}
FakeIntersectionObserver.live = new Set();
globalThis.IntersectionObserver = FakeIntersectionObserver;

/** Fires every armed observer, as a scroll into the sentinel would. */
export async function scrollToBottom() {
	for (const observer of [...FakeIntersectionObserver.live]) {
		observer.cb([{ isIntersecting: true, target: observer.target }]);
	}
	// Let the page request settle before the caller asserts on it.
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Number of observers currently armed. Zero once the list is exhausted. */
export const armedObservers = () => FakeIntersectionObserver.live.size;
export class App {}
export class TFile {}
export class TFolder {}
/**
 * Delegates to a handler a test can install on globalThis.
 *
 * It receives the whole options object, headers included — a stub that drops
 * them would let auth tests pass without ever sending a token.
 */
export const requestUrl = async (opts) =>
	globalThis.__requestUrl
		? globalThis.__requestUrl(opts)
		: { status: 200, json: {}, text: '{}', arrayBuffer: new ArrayBuffer(0) };
export const Platform = { isDesktop: true, isMobile: false };
