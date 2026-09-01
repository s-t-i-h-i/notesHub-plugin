// One list for packing and unpacking, and the same one the worker enforces —
// it lives in verify.ts because that is the file shared with the backend.
// "may send less than may be written" is always a bug, even when one person
// writes both ends.
export { ALLOWED_EXTENSIONS } from './verify';

/**
 * The marketplace server address, injected by esbuild's `define` (see
 * esbuild.config.mjs). `npm run dev` bakes in localhost, `npm run build`
 * bakes in the production worker, and MARKETPLACE_API_URL overrides either.
 * It's deliberately not a setting: the token is sent to this address, so a
 * text field here would let anyone phish it by asking the user to point it
 * elsewhere.
 *
 * Declared here rather than in a separate .d.ts, so this is the only file
 * that can reference `__API_BASE_URL__` directly — anywhere else it fails
 * to compile.
 */
declare const __API_BASE_URL__: string;
export const API_BASE_URL = __API_BASE_URL__;

/**
 * Max size of an archive being published. Mirrors the worker's own limit —
 * checked here so an oversized package fails before the upload rather than
 * after it, which used to be the only way to find out.
 */
export const MAX_PUBLISH_BYTES = 50 * 1024 * 1024;

// --- archive limits when downloading ---

/** Max size of the archive itself. The server caps at 50 MB; this leaves headroom. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Max bytes allowed on disk after unpacking. Without this, a 204 KB archive could unpack to 200 MB. */
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/**
 * Max ratio of unpacked size to archive size.
 *
 * The byte cap alone isn't enough — a tiny archive can still be a zip bomb.
 * Real text compresses to about 10:1, so 100:1 leaves plenty of room.
 */
export const MAX_COMPRESSION_RATIO = 100;

/**
 * Max size of one file inside a package.
 *
 * Not covered by MAX_UNCOMPRESSED_BYTES: a single file just under that total
 * passes the running check and is then allocated in one piece. The worker
 * enforces the same number — "may send less than may be written" is always a bug.
 */
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

/** Max number of files, matching the limit the worker enforces. */
export const MAX_ENTRIES = 2000;

/**
 * Max path length inside a package.
 *
 * 255 is what a ustar name and prefix field hold together. Anything longer
 * exists in tar only as a GNU or PAX record, and those are refused — a second
 * way to spell one filename is the ambiguity we left ZIP to escape.
 */
export const MAX_ENTRY_PATH = 255;

/** Max folder nesting depth. 300 levels isn't a course structure, it's an attack. */
export const MAX_ENTRY_DEPTH = 32;

/** Max package folder name length. Filesystems cap path segments at 255 bytes. */
export const MAX_FOLDER_NAME = 80;
