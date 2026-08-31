import { App, TFile, TFolder } from 'obsidian';
import JSZip from 'jszip';
import { apiRequest } from './api';
import { MAX_PUBLISH_BYTES } from '../constants';
import { formatBytes } from '../installs';
import type { MarketplaceSettings } from '../settings';

export interface PublishMetadata {
	title: string;
	description: string;
	tags: string[];
}

/**
 * Packs the files into an archive and uploads it to the marketplace server.
 *
 * `files` was already validated by openPublishModal(), so this publishes
 * exactly the set of files that passed link validation.
 *
 * With `packageId` the server replaces that package instead of creating a
 * new one, keeping its id and bumping its version. Ownership is checked
 * server-side from the token; passing an id you don't own is a 403.
 */
export async function publishFolder(
	app: App,
	folder: TFolder,
	files: TFile[],
	metadata: PublishMetadata,
	settings: MarketplaceSettings,
	packageId?: string,
): Promise<void> {
	// the vault root's path is "/", so there's no prefix to strip in that case
	const prefix = folder.isRoot() ? '' : folder.path + '/';
	// these exact paths go into the ZIP, so the web preview won't lie
	const structure = files.map((file) => file.path.slice(prefix.length));

	const archive = await packFolder(app, files, prefix);

	// The only point where the real compressed size is known — the review
	// screen only has the uncompressed sum, which says little about how the
	// archive will end up. Without this the server's 413 arrives after the
	// whole upload.
	if (archive.byteLength > MAX_PUBLISH_BYTES) {
		throw new Error(
			`The package is ${formatBytes(archive.byteLength)}, the limit is ${formatBytes(MAX_PUBLISH_BYTES)}`,
		);
	}

	await upload(archive, `${folder.name}.zip`, metadata, structure, settings, packageId);
}

async function packFolder(
	app: App,
	files: TFile[],
	prefix: string,
): Promise<ArrayBuffer> {
	const zip = new JSZip();

	for (const file of files) {
		zip.file(file.path.slice(prefix.length), await app.vault.readBinary(file));
	}

	return zip.generateAsync({ type: 'arraybuffer' });
}

async function upload(
	archive: ArrayBuffer,
	filename: string,
	metadata: PublishMetadata,
	structure: string[],
	settings: MarketplaceSettings,
	packageId?: string,
): Promise<void> {
	const boundary = randomBoundary();
	const body = buildMultipartBody(
		boundary,
		{
			title: metadata.title,
			description: metadata.description,
			tags: metadata.tags.join(','),
			structure: JSON.stringify(structure),
			// An empty id means "new package", so the field is always safe to send.
			id: packageId ?? '',
			// no "author" field — the server derives it from the token
		},
		filename,
		archive,
	);

	// The token goes in a header, never a form field: field values land in
	// the multipart body unquoted and unescaped, so a secret has no
	// business being there.
	await apiRequest(settings, {
		path: '/publish',
		method: 'POST',
		contentType: `multipart/form-data; boundary=${boundary}`,
		body,
		auth: true,
	});
}

/**
 * The multipart boundary must be unguessable.
 *
 * It used to come from Date.now(), and field values go into the body raw —
 * so a package description containing a line like `--<boundary>` could
 * close a part early and inject extra fields. A random boundary fixes this
 * at the source without restricting the description's content.
 */
function randomBoundary(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `----ObsidianBoundary${hex}`;
}

/** requestUrl() doesn't accept FormData, so the multipart body is built by hand. */
function buildMultipartBody(
	boundary: string,
	fields: Record<string, string>,
	filename: string,
	archive: ArrayBuffer,
): ArrayBuffer {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];

	for (const [name, value] of Object.entries(fields)) {
		// Field values go into the body raw, so a value containing the
		// boundary could close its part early and append fields of its own.
		// A random boundary makes that astronomically unlikely; this makes it
		// impossible, for every field at once instead of per caller.
		if (value.includes(boundary)) {
			throw new Error(`Cannot send the "${name}" field: it collides with the request boundary`);
		}

		parts.push(
			encoder.encode(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${name}"\r\n\r\n` +
					`${value}\r\n`,
			),
		);
	}

	// a quote or newline in the folder name would break the header
	const safeFilename = filename.replace(/[\r\n"]/g, '');
	parts.push(
		encoder.encode(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
				`Content-Type: application/zip\r\n\r\n`,
		),
	);
	parts.push(new Uint8Array(archive));
	parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

	const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.length;
	}

	return body.buffer;
}
