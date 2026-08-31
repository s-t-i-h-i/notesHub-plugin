import { MarketplaceSettingTab, DEFAULT_SETTINGS } from '../src/settings';
import { Notice } from 'obsidian';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) { console.log(`  ok   ${label}`); }
	else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

function render(token: string) {
	const plugin: any = { settings: { ...DEFAULT_SETTINGS, token, username: token ? 'octocat' : '' }, saveSettings: async () => {} };
	const tab: any = new MarketplaceSettingTab({} as any, plugin);
	tab.display();
	return tab.containerEl.settings as any[];
}

for (const [label, token] of [['WYLOGOWANY', ''], ['ZALOGOWANY', 'omp_' + 'a'.repeat(64)]] as const) {
	console.log(`\n--- ${label} ---`);
	let settings: any[] = [];
	let threw: unknown = null;
	try { settings = render(token); } catch (e) { threw = e; }

	check('display() nie rzuca', threw === null, threw ? `-> ${threw}` : '');
	if (threw) continue;

	const names = settings.map((s) => s.name).filter(Boolean);
	const descs = settings.map((s) => s.desc).join(' | ');
	console.log('  pozycje:', JSON.stringify(names));

	// zestaw przycisków musi pasować do stanu
	if (token) {
		for (const n of ['Log out on this device', 'Revoke this device on the server', 'Close account']) {
			check(`jest "${n}"`, names.includes(n));
		}
		check('NIE ma "Sign in with GitHub"', !names.includes('Sign in with GitHub'));
		// The token is not shown once you're in: hoarding it stopped being
		// necessary, and copying it to a second device is the wrong move —
		// "Token for another device" issues a separate one for that.
		check('NIE pokazuje tokenu zalogowanemu', !names.includes('Your token'));
		// Signing in on the second device is the whole flow now — no manual
		// token issuing to burden the user with.
		check('NIE ma recznego wydawania tokenow', !names.includes('Token for another device'));
		check('NIE ma pola do wklejania w widoku zalogowanym', !names.includes('Paste your token'));
	} else {
		check('jest "Sign in with GitHub"', names.includes('Sign in with GitHub'));
		check('jest "Paste your token"', names.includes('Paste your token'));
		check('NIE ma "Close account"', !names.includes('Close account'));
		check('NIE ma "Create account" (usunięte z /register)', !names.includes('Create a new account'));
	}

	// stare kłamstwa nie mogą wrócić
	check('brak "cannot get back into the account"', !descs.includes('cannot get back into the account'), descs.includes('cannot get back into the account') ? '<-- WRÓCIŁO' : '');
	check('brak "you will lose access to it"', !descs.includes('you will lose access to it'));
		// After the first paste the user never handles a token again, so the
		// copy must not talk as if they manage a pile of them.
		const tokenTalk = descs.match(/[^.|]*\btokens\b[^.|]*/i)?.[0]?.trim() ?? '';
		check('opisy nie mowia o zarzadzaniu tokenami', tokenTalk === '', tokenTalk && `-> "${tokenTalk}"`);

	// każdy przycisk ma etykietę i handler
	for (const s of settings) {
		for (const b of [...s.buttons, ...s.extras]) {
			check(`"${s.name}" -> przycisk ma handler`, typeof b.onClickCb === 'function');
		}
	}
}

console.log(`\nNotice wyemitowane przy renderze: ${Notice.all.length} (ma być 0)`);
if (Notice.all.length) failures++;
console.log(failures ? `\n${failures} BŁĘDÓW` : '\nWSZYSTKO OK');
process.exit(failures ? 1 : 0);
