/**
 * data.json is hand-editable, and install records point at folders we later
 * write into. Adding cached label fields widened that boundary, so the guard
 * that already stood there has to be shown still standing:
 *
 *  - a record from before the Downloaded tab has no title, and losing it would
 *    lose the install path, which is what update-in-place depends on;
 *  - installedAt: NaN is the dangerous shape (`mtime > NaN` is false, so every
 *    file reads as untouched and the branch rescuing user edits never fires).
 */
import MarketplacePlugin from '../src/main';

let failures = 0;
function check(label: string, cond: boolean, extra = '') {
	if (cond) { console.log(`  ok   ${label}`); }
	else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

/** Runs the real loadSettings() over a hand-written data.json. */
async function load(installs: unknown) {
	const plugin: any = new (MarketplacePlugin as any)();
	plugin.loadData = async () => ({ token: '', installs });
	await plugin.loadSettings();
	return plugin.settings.installs as Record<string, any>;
}

const good = { path: 'a/b', version: 2, installedAt: 1700000000000 };

console.log('\n--- legacy records survive the new fields ---');
{
	const installs = await load({ legacy: { ...good } });
	check('record without title/author is kept', installs.legacy !== undefined);
	check('path preserved', installs.legacy?.path === 'a/b');
	check('version preserved', installs.legacy?.version === 2);
	check('title defaults to empty string', installs.legacy?.title === '');
	check('author defaults to empty string', installs.legacy?.author === '');
}

console.log('\n--- a bad label must not cost the install path ---');
{
	const installs = await load({ x: { ...good, title: 42, author: { evil: true } } });
	check('record kept despite junk label', installs.x !== undefined);
	check('junk title becomes empty', installs.x?.title === '');
	check('junk author becomes empty', installs.x?.author === '');
	check('path still there', installs.x?.path === 'a/b');
}

console.log('\n--- the existing guards still reject ---');
{
	const installs = await load({
		nanTime: { ...good, installedAt: NaN, title: 'x' },
		nanVersion: { ...good, version: NaN, title: 'x' },
		noPath: { version: 1, installedAt: 1, title: 'x' },
		emptyPath: { ...good, path: '', title: 'x' },
		nulled: null,
	});
	check('installedAt NaN dropped', installs.nanTime === undefined);
	check('version NaN dropped', installs.nanVersion === undefined);
	check('missing path dropped', installs.noPath === undefined);
	check('empty path dropped', installs.emptyPath === undefined);
	check('null record dropped', installs.nulled === undefined);
}

console.log('\n--- non-object installs ---');
for (const [label, value] of [['array', []], ['string', 'nope'], ['null', null], ['missing', undefined]] as const) {
	const installs = await load(value);
	check(`${label} yields an empty map`, Object.keys(installs).length === 0);
}

console.log('\n--- a good record round-trips whole ---');
{
	const installs = await load({ ok: { ...good, title: 'My notes', author: 'octocat' } });
	check('title kept', installs.ok?.title === 'My notes');
	check('author kept', installs.ok?.author === 'octocat');
	check('installedAt kept', installs.ok?.installedAt === 1700000000000);
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
