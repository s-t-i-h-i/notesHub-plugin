/**
 * Reading and writing package archives (tar + gzip).
 *
 * Tar replaced ZIP for one reason: ZIP stores every entry name TWICE, in the
 * central directory and again in the local header, and nothing in the format
 * makes the two agree. The worker read one copy and the plugin's unpacker read
 * the other, so an archive could describe one set of files to the catalog and
 * unpack a different one into the vault. Tar stores each name once, so the two
 * sides cannot disagree — not because we check, but because there is nothing
 * to disagree about.
 *
 * Second reason: tar is sequential, so entries are read one at a time and
 * dropped. A Worker isolate has 128 MB, which is not enough to hold a whole
 * unpacked package.
 *
 * Only plain `ustar` is accepted. GNU and PAX extension records are refused
 * rather than parsed: they are a second way to spell a filename, which is the
 * exact class of ambiguity we left ZIP to escape.
 */

const BLOCK = 512;

/**
 * The platform's gzip stream, typed as the byte pair it actually is.
 *
 * lib.dom types both streams as generic BufferSource transforms, which does not
 * line up with pipeThrough on a Uint8Array stream. The cast is about the type
 * declaration, not about the runtime.
 */
function gzip(kind: 'Compression' | 'Decompression'): ReadableWritablePair<Uint8Array, Uint8Array> {
	const stream = kind === 'Compression' ? new CompressionStream('gzip') : new DecompressionStream('gzip');

	return stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

/** Offsets of the ustar header fields we read. */
const NAME = 0;
const SIZE = 124;
const CHECKSUM = 148;
const TYPEFLAG = 156;
const MAGIC = 257;
const PREFIX = 345;

/** Control characters and NUL — these truncate a path at the OS level. */
// eslint-disable-next-line no-control-regex -- these characters are the point of the check
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Text-direction override characters (U+202E and friends). A name containing
 * one displays with its ending reversed, hiding the real extension.
 */
const BIDI_CHARS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/;

/**
 * Reserved DOS device names. Windows refuses to create a file called any of
 * these even with an extension, so a package containing one cannot be unpacked
 * there at all.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export class TarError extends Error {}

export interface TarEntry {
	/** Path relative to the package root, e.g. "images/diagram.png". */
	name: string;
	data: Uint8Array;
}

export interface TarLimits {
	maxEntries: number;
	/** Ceiling on the unpacked total, enforced as it grows rather than afterwards. */
	maxTotalBytes: number;
	/**
	 * Ceiling on ONE entry.
	 *
	 * Not covered by maxTotalBytes: a single file just under that total passes
	 * the running check and is then allocated in one piece. Streaming only
	 * bounds memory if every individual bite is bounded too — without this a
	 * 199 MB entry inside a small archive takes the whole isolate down.
	 */
	maxEntryBytes: number;
	/** Max ratio of unpacked size to archive size — a small archive can still be a bomb. */
	maxRatio: number;
	maxPathLength: number;
	/** Max folder nesting. 300 levels is not a course structure. */
	maxDepth: number;
	/** Size of the compressed archive, for the ratio check. */
	archiveBytes: number;
}

/**
 * Reads a gzipped tar, yielding one entry at a time.
 *
 * A generator rather than an array: the caller analyses each file and lets it
 * go, so peak memory is one entry instead of the whole package. Every limit is
 * enforced while reading — a budget checked after the fact is not a budget.
 */
export async function* readTarGz(
	source: ReadableStream<Uint8Array>,
	limits: TarLimits,
): AsyncGenerator<TarEntry> {
	const bytes = new ByteStream(source.pipeThrough(gzip('Decompression')).getReader());
	const seen = new Set<string>();
	let count = 0;
	let total = 0;
	let endMarker = 0;

	for (;;) {
		const header = await bytes.exact(BLOCK);
		if (header === null) {
			throw new TarError('The archive ends without an end-of-archive marker');
		}

		if (isZeroBlock(header)) {
			// An archive ends with two zero blocks. One alone is not an
			// ending, and content after the pair would be a second archive
			// that only some readers would ever see.
			if (++endMarker === 2) return;
			continue;
		}
		if (endMarker > 0) {
			throw new TarError('Content after the end-of-archive marker');
		}

		assertChecksum(header);
		assertUstar(header);

		const size = readOctal(header, SIZE, 12);
		const type = header[TYPEFLAG] ?? 0;
		const name = joinName(readText(header, PREFIX, 155), readText(header, NAME, 100));

		// Directory entries carry no data and folders are rebuilt from file
		// paths anyway, so they are skipped rather than refused — `tar czf`
		// emits them and there is nothing wrong with that.
		if (type === 0x35 /* '5' */) {
			if (size !== 0) throw new TarError(`Directory entry with content: ${name}`);
			continue;
		}
		// 0 and '0' both mean a regular file. Everything else is a link, a
		// device, or an extension record, and none of those belong in a package.
		if (type !== 0 && type !== 0x30 /* '0' */) {
			throw new TarError(`Unsupported entry type in archive: ${describeType(type)}`);
		}

		if (++count > limits.maxEntries) {
			throw new TarError(`The archive has more than ${limits.maxEntries} files`);
		}

		assertSafeEntryName(name, limits.maxPathLength, limits.maxDepth);

		// macOS and Windows treat these as one file, so which of the two
		// survived would depend on the unpacker.
		const key = name.toLowerCase();
		if (seen.has(key)) throw new TarError(`Duplicate path in archive: ${name}`);
		seen.add(key);

		// All three checked BEFORE reading the data: the point is to refuse the
		// bytes, not to notice them once they are already in memory.
		if (size > limits.maxEntryBytes) {
			throw new TarError(
				`${name} is ${Math.round(size / 1024 / 1024)} MB, and no single file may exceed ${Math.round(limits.maxEntryBytes / 1024 / 1024)} MB`,
			);
		}

		total += size;
		if (total > limits.maxTotalBytes) {
			throw new TarError(`Unpacked content exceeds ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB`);
		}
		if (total > limits.maxRatio * limits.archiveBytes) {
			throw new TarError('Suspiciously high compression ratio (possible archive bomb)');
		}

		const padded = await bytes.exact(size + padding(size));
		if (padded === null) throw new TarError(`Truncated archive at ${name}`);

		// slice(), not subarray(): a view keeps the whole padded block as its
		// buffer, so any caller reaching for entry.data.buffer would write the
		// file with up to 511 trailing NUL bytes. Copying here costs one file
		// and closes that off for every consumer at once.
		yield { name, data: padded.slice(0, size) };
	}
}

/**
 * Builds a gzipped tar.
 *
 * Timestamps are fixed at zero so the same files always produce the same
 * bytes. The archive's sha256 is what ties the catalog's description to what
 * the downloader receives, and it should not change because a file was touched.
 */
export async function writeTarGz(entries: TarEntry[]): Promise<Uint8Array> {
	const blocks: Uint8Array[] = [];

	for (const entry of entries) {
		blocks.push(buildHeader(entry.name, entry.data.length));
		blocks.push(entry.data);
		const pad = padding(entry.data.length);
		if (pad > 0) blocks.push(new Uint8Array(pad));
	}
	blocks.push(new Uint8Array(BLOCK * 2));

	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const block of blocks) controller.enqueue(block);
			controller.close();
		},
	});

	return concat(source.pipeThrough(gzip('Compression')));
}

/**
 * Checks that an entry name is a plain relative path that will actually unpack.
 *
 * Refused rather than quietly repaired: unpackers normalize differently, so a
 * name "fixed" here and the same name fixed on the other side could drift
 * apart — which is the divergence this format was chosen to avoid.
 *
 * The second half of the rules — depth, leading dots, trailing dots and spaces,
 * reserved device names — used to live only in the plugin's install path. That
 * meant a package holding "con.md" or ".secret.md" published cleanly, appeared
 * in the catalog with a full description, and was then refused wholesale by
 * every single installer. A catalog entry nobody can install is worse than a
 * rejected upload, and the author was never told. "May send less than may be
 * written" is a bug even when one person writes both ends.
 */
export function assertSafeEntryName(name: string, maxLength: number, maxDepth: number): void {
	if (!name) throw new TarError('Empty path in archive');
	if (name.length > maxLength) {
		throw new TarError(`Path too long in archive: ${name.slice(0, 60)}...`);
	}
	// Some tools write the Windows separator, and "a\b.md" is then either one
	// filename or two path levels. We don't guess.
	if (name.includes('\\')) {
		throw new TarError(`Disallowed path in archive: ${name}`);
	}
	if (CONTROL_CHARS.test(name)) {
		throw new TarError(`Control characters in archive path: ${JSON.stringify(name.slice(0, 40))}`);
	}
	if (BIDI_CHARS.test(name)) {
		throw new TarError(`Text-direction override in path: ${JSON.stringify(name.slice(0, 40))}`);
	}
	const segments = name.split('/');
	if (segments.length > maxDepth) {
		throw new TarError(`Nesting too deep in archive (${segments.length} levels): ${name}`);
	}

	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') {
			throw new TarError(`Disallowed path in archive: ${name}`);
		}
		// A leading dot hides the file from Obsidian's file explorer, and a
		// package has no reason to carry content nobody can see.
		if (segment.startsWith('.')) {
			throw new TarError(`Hidden file or folder in archive: ${name}`);
		}
		// Windows silently strips a trailing dot or space, so "note .md" and
		// "note.md" become one file — a collision waiting to happen mid-write.
		if (/[. ]$/.test(segment)) {
			throw new TarError(`Name ending in a dot or space: ${name}`);
		}
		if (WINDOWS_RESERVED.test(segment)) {
			throw new TarError(`Reserved system name in archive: ${segment}`);
		}
	}
}

// --- header parsing ---

function assertUstar(header: Uint8Array): void {
	// "ustar\0" (POSIX) and "ustar " (GNU) both appear in the wild. The older
	// v7 format has no magic at all and no prefix field, so its names would
	// mean something different — one format only.
	const magic = 'ustar';
	for (let i = 0; i < magic.length; i++) {
		if (header[MAGIC + i] !== magic.charCodeAt(i)) {
			throw new TarError('Not a ustar archive');
		}
	}
}

/**
 * The header checksum, computed with the checksum field itself read as spaces.
 *
 * Historic writers disagreed on whether the bytes are signed, so both sums are
 * accepted — failing both means a corrupted or hand-built header.
 */
function assertChecksum(header: Uint8Array): void {
	let unsigned = 0;
	let signed = 0;

	for (let i = 0; i < BLOCK; i++) {
		const byte = i >= CHECKSUM && i < CHECKSUM + 8 ? 0x20 : (header[i] ?? 0);
		unsigned += byte;
		signed += byte > 127 ? byte - 256 : byte;
	}

	const declared = readOctal(header, CHECKSUM, 8);
	if (declared !== unsigned && declared !== signed) {
		throw new TarError('Corrupted tar header (checksum mismatch)');
	}
}

function readOctal(header: Uint8Array, offset: number, length: number): number {
	// The high bit marks GNU base-256, which only exists for values above
	// 8 GB. Nothing legitimate here needs it, and it is a second spelling for
	// a number we can already read one way.
	if (((header[offset] ?? 0) & 0x80) !== 0) {
		throw new TarError('Base-256 numeric field is not supported');
	}

	let text = '';
	for (let i = offset; i < offset + length; i++) {
		const byte = header[i] ?? 0;
		if (byte === 0 || byte === 0x20) break;
		text += String.fromCharCode(byte);
	}

	if (text === '') return 0;
	if (!/^[0-7]+$/.test(text)) throw new TarError('Malformed numeric field in tar header');

	return parseInt(text, 8);
}

function readText(header: Uint8Array, offset: number, length: number): string {
	let end = offset;
	while (end < offset + length && header[end] !== 0) end++;

	return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(header.subarray(offset, end));
}

function joinName(prefix: string, name: string): string {
	return prefix ? `${prefix}/${name}` : name;
}

function describeType(type: number): string {
	const names: Record<number, string> = {
		0x31: 'hard link',
		0x32: 'symbolic link',
		0x33: 'character device',
		0x34: 'block device',
		0x36: 'FIFO',
		0x37: 'contiguous file',
		0x4b: 'GNU long link name',
		0x4c: 'GNU long name',
		0x67: 'PAX global header',
		0x78: 'PAX extended header',
	};

	return names[type] ?? `type ${String.fromCharCode(type)}`;
}

// --- header writing ---

function buildHeader(name: string, size: number): Uint8Array {
	const header = new Uint8Array(BLOCK);
	const [prefix, base] = splitName(name);

	writeString(header, base, NAME, 100);
	writeString(header, prefix, PREFIX, 155);
	writeOctal(header, 0o644, 100, 8); // mode
	writeOctal(header, 0, 108, 8); // uid
	writeOctal(header, 0, 116, 8); // gid
	writeOctal(header, size, SIZE, 12);
	writeOctal(header, 0, 136, 12); // mtime — fixed, see writeTarGz
	header[TYPEFLAG] = 0x30; // '0', regular file
	writeString(header, 'ustar', MAGIC, 6);
	header[MAGIC + 6] = 0x30;
	header[MAGIC + 7] = 0x30; // version "00"

	// The checksum is computed with its own field full of spaces.
	header.fill(0x20, CHECKSUM, CHECKSUM + 8);
	let sum = 0;
	for (const byte of header) sum += byte;
	// Six octal digits, NUL, space — the layout every reader expects.
	writeString(header, sum.toString(8).padStart(6, '0'), CHECKSUM, 7);
	header[CHECKSUM + 7] = 0x20;

	return header;
}

/**
 * Splits a path into the 155-byte prefix and 100-byte name fields.
 *
 * A long name could also be written as a GNU or PAX extension record, but the
 * reader refuses those on purpose, so anything that doesn't fit is an error
 * here rather than a second way to spell the same path.
 */
function splitName(name: string): [string, string] {
	const encoder = new TextEncoder();
	if (encoder.encode(name).length <= 100) return ['', name];

	// Split on a separator far enough in that the tail fits the name field.
	for (let i = Math.max(0, name.length - 101); i < name.length; i++) {
		if (name[i] !== '/') continue;

		const prefix = name.slice(0, i);
		const base = name.slice(i + 1);
		if (encoder.encode(prefix).length <= 155 && encoder.encode(base).length <= 100) {
			return [prefix, base];
		}
	}

	throw new TarError(`Path too long for the archive format: ${name}`);
}

function writeString(header: Uint8Array, value: string, offset: number, length: number): void {
	const bytes = new TextEncoder().encode(value);
	if (bytes.length > length) throw new TarError(`Field too long in tar header: ${value}`);
	header.set(bytes, offset);
}

function writeOctal(header: Uint8Array, value: number, offset: number, length: number): void {
	writeString(header, value.toString(8).padStart(length - 1, '0'), offset, length - 1);
}

// --- stream plumbing ---

function padding(size: number): number {
	const remainder = size % BLOCK;
	return remainder === 0 ? 0 : BLOCK - remainder;
}

function isZeroBlock(block: Uint8Array): boolean {
	return block.every((byte) => byte === 0);
}

/** Pulls fixed-size runs out of a stream that arrives in arbitrary chunks. */
class ByteStream {
	private chunks: Uint8Array[] = [];
	private available = 0;
	private finished = false;

	constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

	/** Exactly `length` bytes, or null if the stream ended cleanly on a boundary. */
	async exact(length: number): Promise<Uint8Array | null> {
		while (this.available < length) {
			if (this.finished) {
				if (this.available === 0) return null;
				throw new TarError('Truncated archive');
			}

			// A file that isn't gzip at all fails here, inside the decompressor.
			// Without this it would surface as a raw TypeError and the caller
			// would answer 500 to what is really "this is not an archive".
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await this.reader.read();
			} catch {
				throw new TarError('The archive is not a valid gzip stream');
			}

			const { value, done } = chunk;
			if (done) {
				this.finished = true;
				continue;
			}
			if (value.length > 0) {
				this.chunks.push(value);
				this.available += value.length;
			}
		}

		const out = new Uint8Array(length);
		let written = 0;
		while (written < length) {
			const chunk = this.chunks[0];
			if (chunk === undefined) throw new TarError('Truncated archive');

			const take = Math.min(chunk.length, length - written);
			out.set(chunk.subarray(0, take), written);
			written += take;
			if (take === chunk.length) this.chunks.shift();
			else this.chunks[0] = chunk.subarray(take);
		}
		this.available -= length;

		return out;
	}
}

async function concat(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;

	const reader = stream.getReader();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}

	return out;
}
