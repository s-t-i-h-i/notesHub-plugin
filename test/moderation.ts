import assert from 'node:assert/strict';
import { fetchPackage, fetchPackages, reportPackage } from '../src/api/packagesApi';
import { publishFolder } from '../src/api/publishApi';
import { DEFAULT_SETTINGS } from '../src/settings';

const settings = { ...DEFAULT_SETTINGS, token: `omp_${'a'.repeat(64)}`, userId: 'owner' };
let last: any;
let status = 200;
let body: unknown = [];
(globalThis as any).__requestUrl = (request: any) => {
	last = request;
	return { status, json: body, text: JSON.stringify(body) };
};

await fetchPackages(settings);
assert.equal(last.headers.Authorization, undefined, 'public browsing does not send a token');
await fetchPackages(settings, { authorId: 'owner' });
assert.equal(last.headers.Authorization, `Bearer ${settings.token}`, 'owner list authenticates');
await fetchPackages(DEFAULT_SETTINGS, { authorId: 'owner' });
assert.equal(last.headers.Authorization, undefined, 'anonymous author filtering stays usable');

for (const moderation_state of ['pending', 'rejected', 'approved']) {
	body = { id: 'pkg', moderation_state, moderation_reason: 'reason', structure: '["note.md"]' };
	const pkg = await fetchPackage(settings, 'pkg');
	assert.equal(last.headers.Authorization, `Bearer ${settings.token}`, 'private details authenticate');
	assert.equal(pkg.moderationState, moderation_state);
	assert.equal(pkg.moderationReason, 'reason');
	assert.deepEqual(pkg.structure, ['note.md']);
}
body = { id: 'legacy' };
assert.equal((await fetchPackage(DEFAULT_SETTINGS, 'legacy')).moderationState, 'approved');
assert.equal(last.headers.Authorization, undefined);

body = { ok: true };
await reportPackage(settings, 'pkg');
assert.equal(last.method, 'POST');
assert.equal(last.headers.Authorization, `Bearer ${settings.token}`);
assert.deepEqual(JSON.parse(last.body), {});

const folder = { path: 'course', name: 'course', isRoot: () => false } as any;
const metadata = { title: 'Course', description: '', tags: [] };
for (const [responseStatus, responseBody, expected] of [
	[202, { id: 'p', moderation_state: 'pending' }, 'pending'],
	[202, {}, 'pending'],
	[201, { id: 'p' }, 'approved'],
	[200, { id: 'p', moderation_state: 'pending' }, 'pending'],
] as const) {
	status = responseStatus; body = responseBody;
	const result = await publishFolder({} as any, folder, [], metadata, settings);
	assert.equal(result.moderationState, expected);
	assert.match(new TextDecoder().decode(last.body), /Content-Type: application\/gzip/);
}
console.log('ALL OK: moderation states, owner authentication, reports, publish responses and archive MIME');
