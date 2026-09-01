# Obsidian Notes Hub

Publish a folder from your vault as a package — notes, a guide, a template collection — and download packages shared by others. No servers to run, no accounts on a third-party platform, just a folder and a click.

## Why

Notes Hub is meant to be the first public, community-built collection of notes for Obsidian. If you spent time organizing a course, structuring your notes, or building an useful guide — that work might save someone else a lot of time too. Notes Hub is a place to share it. It removes the friction of sharing and downloading interlinked notes between Obsidian vaults.

**The platform is free to use.**

## Features

- **Publish a folder as a package.** Right-click any folder and select *Publish* to package it and upload it.
- **Update packages.** Downloaded packages can be updated in place without losing your local notes. Authors can publish updates to their existing packages.
- **Broken link detection.** Before publishing, the plugin checks for links pointing outside the selected folder or to notes that don't exist, so you don't accidentally ship broken references.
- **Content review before download.** Downloaded packages are scanned for active content (embedded scripts, dataviewjs blocks, Templater syntax, and similar) and flagged before installation. You decide whether to proceed.
- **Vault isolation.** Downloaded packages are extracted into their own folder. They don't spill tags, queries, or files into the rest of your vault.
- **No email, no password.** Sign in with GitHub — only required if you want to publish your content.
- **Browse and search.** A built-in modal lists available packages with title, author, description, and tags. downloading does not require registration!

## Installation

Notes Hub is not yet in the Obsidian Community Plugins directory. Until it is, install manually:

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from the [Releases page](#).
2. Create a folder named `notes-hub` inside `<your-vault>/.obsidian/plugins/`.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Notes Hub** in *Settings → Community plugins*.

Alternatively, install through [BRAT](https://github.com/TfTHacker/obsidian42-brat) by pointing it at this repository.

## Getting started

### Sign in

Open *Settings → Notes Hub* and select **Connect GitHub**. This opens your browser to sign in with GitHub, then shows a personal access token to paste back into the settings tab. It's stored locally in your vault — if you ever lose it, just sign in with GitHub again for a new one.

### Publish a package

1. Right-click a folder in the file explorer.
2. Select **Publish**.
3. Fill in a title, description, and tags.
4. Review any warnings about broken links or active content.
5. Confirm. The folder is uploaded!

Only Markdown files, canvases, and images inside the folder are included. Hidden folders and unsupported file types are skipped automatically.

### Download a package

1. Run the **Open Notes Hub** command.
2. Browse or search the list of published packages.
3. Select one and click **Download**.

The package is extracted into a new, isolated folder in your vault, named after the package. Your existing notes, tags, and settings are left untouched.

### Update a downloaded package

1. Run the **Open Notes Hub** command.
2. Packages with newer versions will display an **Update available** badge.
3. Select one and click **Update (vX → vY)**.
4. Review the changes (new, replaced, or unchanged files). If you modified any package files locally, they will be moved to the trash before being replaced.
5. Click **Update** to confirm.

### Update a published package

1. Right-click a folder in the file explorer and select **Publish**.
2. From the **Publish as** dropdown, select the package you want to update (it will pre-fill the form with its current title, description, and tags).
3. Review warnings and click **Publish update**. The package keeps its ID and its version is bumped.

## Settings

| Setting | Description |
|---|---|
| Username | Your public author name, shown on published packages. |
| Token | Your personal access token, issued when you sign in with GitHub. Can be revoked from the same tab. |
| Download folder | Where downloaded packages are placed in your vault. |

## Security and privacy

- Packages are scanned server-side before publishing. File extensions outside a fixed whitelist (Markdown, canvas, common image formats) are rejected on upload and on install, in both directions.
- Path traversal and archive-based attacks (oversized or maliciously compressed ZIPs) are rejected before any file is written to disk.
- The active-content scan on install is a heuristic warning, not a guarantee — always review what you're installing, especially from authors you don't recognize.
- The plugin sends your title, description, tags, and the packaged files to the Notes Hub API when you publish. It does not read or transmit anything outside the folder you explicitly select.
- No email address is required or collected. Deleting your account removes your token and all packages you've published.

## Known limitations

- This is an MVP early release. More features and improvements are on the way.

## Contributing

Issues and pull requests are welcome. If you're planning a larger change, open an issue first to discuss it.

## License

MIT — see [LICENSE](LICENSE).