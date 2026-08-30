import { apiRequest } from './api';
import type { MarketplaceSettings } from '../settings';

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
	/** Relative file paths in the archive. Empty in list results — fetchPackage() fills this in. */
	structure: string[];
}

export async function downloadPackageArchive(
	settings: MarketplaceSettings,
	id: string,
): Promise<ArrayBuffer> {
	const response = await apiRequest(settings, {
		path: `/download/${encodeURIComponent(id)}`,
	});

	// Not using response.json here — it's a getter that calls JSON.parse,
	// and the archive starts with "PK", so that would throw.
	if (!response.arrayBuffer || response.arrayBuffer.byteLength === 0) {
		throw new Error('The downloaded file is empty');
	}

	return response.arrayBuffer;
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

/** Fetches the package list from the marketplace server. */
export async function fetchPackages(settings: MarketplaceSettings): Promise<Package[]> {
	const response = await apiRequest(settings, { path: '/packages' });

	const data: unknown = response.json;
	if (!Array.isArray(data)) {
		throw new Error('The server returned something other than a package list');
	}

	return data.map(toPackage);
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
		structure: toStructure(row.structure),
	};
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
