import { apiRequest } from './api';
import type { MarketplaceSettings } from '../settings';
import type { Capability, Manifest } from '../policy/types';

/** A package in the shape the UI expects — fields always exist and have the right type. */
export interface Package {
	id: string;
	title: string;
	description: string;
	author: string;
	/** Owner according to the server. Empty for packages published before accounts existed. */
	authorId: string;
	tags: string[];
	filename: string;
	createdAt: string;
	/** Bumped by the server on every update. The only signal that an installed copy is out of date. */
	version: number;
	/** Empty when the package has never been updated — the UI falls back to createdAt. */
	updatedAt: string;
	/** Relative file paths in the archive. Empty in list results — fetchPackage() fills this in. */
	structure: string[];
	/**
	 * What the package does, worked out by the server from the archive itself.
	 * Carried by the listing so the reader sees it BEFORE downloading.
	 */
	capabilities: Capability[];
	/**
	 * The evidence behind those capabilities. Only fetchPackage() fills this in —
	 * a catalog page has no business shipping every finding of twenty packages.
	 */
	manifest: Manifest | null;
	/** SHA-256 of the archive, hex. Empty when the server did not send one. */
	sha256: string;
	/**
	 * Which analyser version described this package. 0 means it was never
	 * described — which is not the same as "nothing to report", and the UI has
	 * to say so rather than imply a clean result.
	 */
	policyVersion: number;
	/** The server has since marked this package as malicious. */
	revoked: boolean;
}

export async function downloadPackageArchive(
	settings: MarketplaceSettings,
	id: string,
	expected: string,
): Promise<ArrayBuffer> {
	const response = await apiRequest(settings, {
		path: `/download/${encodeURIComponent(id)}`,
	});

	// Not using response.json here — it's a getter that calls JSON.parse, and
	// the archive is gzip, so that would throw.
	if (!response.arrayBuffer || response.arrayBuffer.byteLength === 0) {
		throw new Error('The downloaded file is empty');
	}

	// Without this the manifest is a promise with nothing behind it: the
	// catalog would describe one archive while these bytes were another.
	// Skipped only when the server sent no digest at all, which an up-to-date
	// worker never does.
	if (expected) {
		const actual = await sha256Hex(response.arrayBuffer);
		if (actual !== expected.toLowerCase()) {
			throw new Error('The downloaded archive does not match what the catalog describes. Nothing was installed.');
		}
	}

	return response.arrayBuffer;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', bytes);

	return Array.from(new Uint8Array(hash))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Fetches full package details, including folder structure.
 * The list endpoint skips this on purpose — with a hundred packages it'd
 * be a lot of wasted transfer.
 */
export async function fetchPackage(
	settings: MarketplaceSettings,
	id: string,
): Promise<Package> {
	const response = await apiRequest(settings, {
		path: `/packages/${encodeURIComponent(id)}`,
	});

	return toPackage(response.json);
}

/**
 * How many ids one /packages lookup answers.
 *
 * The server truncates the list to this and never says it did, so asking for
 * more silently loses the tail — which reads downstream as "no longer
 * published". Callers with more ids than this have to ask more than once.
 */
export const MAX_IDS_PER_QUERY = 100;

/** How the catalog is sorted. The server owns the ordering, so these names are its vocabulary. */
export type SortKey = 'newest' | 'oldest' | 'title';

/**
 * One page of the catalog.
 *
 * Filtering and sorting are the server's job now: with paging, a client-side
 * tag filter over page 1 can return nothing while page 4 is full of matches.
 */
export interface ListQuery {
	limit?: number;
	offset?: number;
	sort?: SortKey;
	tag?: string;
	authorId?: string;
	/** Asks for exactly these packages, unpaged. Used to look up installed ones. */
	ids?: string[];
}

/**
 * Fetches one page of the package list.
 *
 * The response is a plain array, so a short page is the end-of-list signal —
 * there is no total to read and no cursor to carry.
 */
export async function fetchPackages(
	settings: MarketplaceSettings,
	query: ListQuery = {},
): Promise<Package[]> {
	const response = await apiRequest(settings, {
		path: '/packages',
		query: {
			...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
			...(query.offset !== undefined ? { offset: String(query.offset) } : {}),
			...(query.sort ? { sort: query.sort } : {}),
			...(query.tag ? { tag: query.tag } : {}),
			...(query.authorId ? { author_id: query.authorId } : {}),
			...(query.ids ? { ids: query.ids.join(',') } : {}),
		},
	});

	const data: unknown = response.json;
	if (!Array.isArray(data)) {
		throw new Error('The server returned something other than a package list');
	}

	return data.map(toPackage);
}

/**
 * The tag vocabulary — a fixed list the server owns, not whatever the catalog
 * happens to contain. Feeds both the browse filter and the publish picker, so
 * the plugin never offers a tag the server would drop.
 */
export async function fetchTags(settings: MarketplaceSettings): Promise<string[]> {
	const response = await apiRequest(settings, { path: '/tags' });

	const data: unknown = response.json;
	if (!Array.isArray(data)) {
		throw new Error('The server returned something other than a tag list');
	}

	return data.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

/** Deletes one of your own packages. Ownership is verified server-side anyway. */
export async function deletePackage(
	settings: MarketplaceSettings,
	id: string,
): Promise<void> {
	await apiRequest(settings, {
		path: `/packages/${encodeURIComponent(id)}`,
		method: 'DELETE',
		auth: true,
	});
}

/** Converts a raw database row into a safe Package object. */
function toPackage(raw: unknown): Package {
	const row = (raw ?? {}) as Record<string, unknown>;
	return {
		id: asText(row.id),
		title: asText(row.title) || '(untitled)',
		description: asText(row.description),
		author: asText(row.author),
		// legacy packages have author_id = null, and asText() turns that into an empty string
		authorId: asText(row.author_id),
		tags: toTags(row.tags),
		filename: asText(row.filename),
		createdAt: asText(row.created_at),
		// Not asText: this one is compared, not displayed. Defaulting to 1
		// matters — an older worker sends no version at all, and
		// `undefined < 3` is false, so updates would never offer themselves.
		version: Number(row.version) || 1,
		updatedAt: asText(row.updated_at),
		structure: toStructure(row.structure),
		capabilities: toCapabilities(row.capabilities),
		manifest: toManifest(row.manifest),
		sha256: asText(row.sha256),
		// 0 for a row the server never described. The UI must not read that as
		// "nothing to report".
		policyVersion: Number(row.policy_version) || 0,
		revoked: Number(row.revoked) === 1,
	};
}

/** `capabilities` arrives as a JSON array of strings. */
function toCapabilities(value: unknown): Capability[] {
	const parsed = parseJson(value);

	return Array.isArray(parsed) ? (parsed.filter((entry) => typeof entry === 'string') as Capability[]) : [];
}

/**
 * The full manifest, or null when there isn't one.
 *
 * null and "an empty manifest" have to stay distinguishable: one means nobody
 * looked, the other means someone looked and found nothing.
 */
function toManifest(value: unknown): Manifest | null {
	const parsed = parseJson(value);
	if (parsed === null || typeof parsed !== 'object') return null;

	const record = parsed as Partial<Manifest>;
	if (!Array.isArray(record.findings)) return null;

	return { version: Number(record.version) || 0, findings: record.findings };
}

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string' || !value) return null;

	try {
		return JSON.parse(value);
	} catch {
		// Malformed JSON means no description to show — not a reason to fail
		// the whole listing.
		return null;
	}
}

/** `structure` arrives as a JSON array of paths, serialized as text. */
function toStructure(value: unknown): string[] {
	if (typeof value !== 'string' || !value) return [];

	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === 'string');
	} catch {
		// malformed JSON just means no tree to show — not a reason to fail the whole list
		return [];
	}
}

/** Converts SQLite numbers to text; everything else (null, undefined) becomes an empty string. */
function asText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	return '';
}

/** `tags` arrives as "ts,notes" — split into an array and drop empty entries. */
function toTags(value: unknown): string[] {
	const list = Array.isArray(value) ? value.map(asText) : asText(value).split(',');
	return list.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}
