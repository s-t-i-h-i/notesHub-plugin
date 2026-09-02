import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const bumpType = process.argv[2];
if (!bumpType) {
	console.error('Error: Please specify release bump type: patch | minor | major (e.g. npm run release:patch)');
	process.exit(1);
}

function run(cmd) {
	console.log(`\n> ${cmd}`);
	execSync(cmd, { stdio: 'inherit' });
}

try {
	// 1. Run lint & build check before bumping
	console.log('--- Step 1/5: Running lint and build check ---');
	run('npm run lint');
	run('npm run build');

	// 2. Bump version in all necessary files
	console.log('\n--- Step 2/5: Bumping version ---');
	run(`node version-bump.mjs ${bumpType}`);

	const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
	const version = pkg.version;

	// 3. Stage changes and commit
	console.log(`\n--- Step 3/5: Creating git commit for version ${version} ---`);
	run('git add -A');
	run(`git commit -m "Release ${version}"`);

	// 4. Create git tag
	console.log(`\n--- Step 4/5: Creating git tag ${version} ---`);
	run(`git tag ${version}`);

	// 5. Push commit and tag to GitHub
	console.log(`\n--- Step 5/5: Pushing commit and tag to origin ---`);
	run('git push');
	run(`git push origin ${version}`);

	console.log(`\n======================================================`);
	console.log(`🎉 Successfully released version ${version}!`);
	console.log(`🚀 GitHub Action is now building and publishing the release.`);
	console.log(`======================================================\n`);
} catch (error) {
	console.error('\n❌ Release process failed:', error.message);
	process.exit(1);
}
