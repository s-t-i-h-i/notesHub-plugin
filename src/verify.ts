/**
 * Checks that a file is what its name claims.
 *
 * Until now the extension was the only thing anyone looked at, on both sides:
 * `image.png` was an image because it ended in ".png". Nothing ever opened it.
 * That makes the extension a place to hide — an SVG or an HTML document named
 * ".png" is read as an image by the checks and as a document by whatever ends
 * up rendering it.
 *
 * Shared verbatim between the worker and the plugin.
 */

export class VerifyError extends Error {}

/** Extensions a package may contain, used when packing and when unpacking alike. */
export const ALLOWED_EXTENSIONS = ['md', 'canvas', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];

/** Leading bytes that identify each binary format we accept. */
const SIGNATURES: Record<string, number[][]> = {
	png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
	// Every JPEG variant starts SOI + a marker; the fourth byte varies by encoder.
	jpg: [[0xff, 0xd8, 0xff]],
	jpeg: [[0xff, 0xd8, 0xff]],
	gif: [
		[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
		[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
	],
	// WEBP is a RIFF container: "RIFF" then four length bytes then "WEBP".
	webp: [[0x52, 0x49, 0x46, 0x46]],
};

/**
 * The extension, lowercased, or '' when there is none.
 *
 * A dot inside a folder name doesn't make an extension, so the last dot only
 * counts when it comes after the last slash.
 */
export function extensionOf(path: string): string {
	const dot = path.lastIndexOf('.');
	const slash = path.lastIndexOf('/');

	return dot === -1 || dot < slash ? '' : path.slice(dot + 1).toLowerCase();
}

/**
 * Refuses a file whose contents contradict its extension.
 *
 * Text formats also have to decode as UTF-8, because every later step — the
 * manifest, the catalog preview, the editor — treats them as text. Bytes that
 * are not text would be described by guesswork.
 */
export function assertContentMatchesExtension(name: string, data: Uint8Array): void {
	const extension = extensionOf(name);

	if (!ALLOWED_EXTENSIONS.includes(extension)) {
		throw new VerifyError(`Disallowed file type in archive: ${name}${extension ? ` (.${extension})` : ' (no extension)'}`);
	}

	const signatures = SIGNATURES[extension];
	if (signatures) {
		if (!signatures.some((signature) => startsWith(data, signature))) {
			throw new VerifyError(`${name} is not a valid .${extension} file`);
		}
		// RIFF alone is also AVI and WAV, so the container's own type matters.
		if (extension === 'webp' && !startsWith(data.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
			throw new VerifyError(`${name} is a RIFF container but not WEBP`);
		}
		return;
	}

	const text = decodeText(name, data);

	// A canvas is JSON and its nodes get read one by one. One that doesn't
	// parse can't be described, so it can't be published either.
	if (extension === 'canvas') {
		try {
			JSON.parse(text);
		} catch {
			throw new VerifyError(`${name} is not valid JSON`);
		}
	}

	// SVG is only shape-checked: it has to open as an XML or SVG document.
	//
	// ponytail: no XML well-formedness check — that needs a parser the Workers
	// runtime doesn't have, and browsers are lenient anyway, so a strict pass
	// here would not make our reading and theirs agree. The tag scanner in the
	// policy layer is what actually describes the file. Upgrade path: a real
	// XML parser, if SVG ever turns out to be worth one.
	if (extension === 'svg') {
		// decodeText() already dropped a BOM: TextDecoder strips it unless ignoreBOM is set.
		const start = text.trimStart();
		if (!start.startsWith('<?xml') && !start.startsWith('<svg') && !start.startsWith('<!--') && !start.startsWith('<!DOCTYPE')) {
			throw new VerifyError(`${name} does not open as an SVG document`);
		}
	}
}

/** Decodes strictly: invalid UTF-8 means the file is not the text it claims to be. */
export function decodeText(name: string, data: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
	} catch {
		throw new VerifyError(`${name} is not valid UTF-8 text`);
	}
}

/**
 * Whether a JPEG carries an EXIF block.
 *
 * This is the one risk that runs the other way: it does not endanger whoever
 * downloads the package, it exposes whoever published it. A photo straight off
 * a phone carries GPS coordinates and a camera serial number, and publishing
 * puts both in a public catalog for good.
 *
 * Reported, never stripped: removing it would change the author's bytes without
 * being asked.
 */
export function hasExif(data: Uint8Array): boolean {
	// SOI, then a chain of marker segments. APP1 (0xffe1) holding "Exif\0\0"
	// is the one that carries the metadata.
	if (!startsWith(data, [0xff, 0xd8])) return false;

	let index = 2;
	// Only the first few segments matter; EXIF is written at the front.
	while (index + 4 < data.length && index < 64 * 1024) {
		if (data[index] !== 0xff) return false;

		const marker = data[index + 1] ?? 0;
		// SOS: image data starts here and there is nothing left to read.
		if (marker === 0xda) return false;

		const length = ((data[index + 2] ?? 0) << 8) | (data[index + 3] ?? 0);
		if (length < 2) return false;

		if (marker === 0xe1 && startsWith(data.subarray(index + 4), [0x45, 0x78, 0x69, 0x66])) return true;

		index += 2 + length;
	}

	return false;
}

function startsWith(data: Uint8Array, signature: number[]): boolean {
	if (data.length < signature.length) return false;

	return signature.every((byte, index) => data[index] === byte);
}
