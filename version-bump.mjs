import { readFileSync, writeFileSync, existsSync } from 'fs';

function bumpSemver(version, type) {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
	if (!match) {
		throw new Error(`Invalid current version format: "${version}"`);
	}

	let major = parseInt(match[1], 10);
	let minor = parseInt(match[2], 10);
	let patch = parseInt(match[3], 10);

	switch (type.toLowerCase()) {
		case 'major':
			major += 1;
			minor = 0;
			patch = 0;
			break;
		case 'minor':
			minor += 1;
			patch = 0;
			break;
		case 'patch':
			patch += 1;
			break;
		default:
			if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(type)) {
				return type;
			}
			throw new Error(
				`Invalid bump type or semver string: "${type}". Expected "major", "minor", "patch" or a semver version (e.g. "1.0.0").`
			);
	}

	return `${major}.${minor}.${patch}`;
}

// 1. Read package.json
const pkgPath = 'package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

// 2. Determine target version
const arg = process.argv[2];
let targetVersion;

if (arg) {
	targetVersion = bumpSemver(currentVersion, arg);
} else if (process.env.npm_package_version) {
	targetVersion = process.env.npm_package_version;
} else {
	console.error('Error: Please specify bump type (major | minor | patch) or run via npm version.');
	process.exit(1);
}

// 3. Update package.json
pkg.version = targetVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

// 4. Update manifest.json
const manifestPath = 'manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');

// 5. Update versions.json
const versionsPath = 'versions.json';
const versions = existsSync(versionsPath) ? JSON.parse(readFileSync(versionsPath, 'utf8')) : {};
versions[targetVersion] = minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, '\t') + '\n');

// 6. Update package-lock.json if present
const lockPath = 'package-lock.json';
let updatedLock = false;
if (existsSync(lockPath)) {
	const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
	lock.version = targetVersion;
	if (lock.packages && lock.packages['']) {
		lock.packages[''].version = targetVersion;
	}
	writeFileSync(lockPath, JSON.stringify(lock, null, '\t') + '\n');
	updatedLock = true;
}

const modifiedFiles = ['package.json', manifestPath, versionsPath];
if (updatedLock) modifiedFiles.push(lockPath);

console.log(
	`Successfully bumped version: ${currentVersion} -> ${targetVersion} in ${modifiedFiles.join(', ')}`
);
