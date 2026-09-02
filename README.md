# Obsidian Notes Hub

Publish a folder from your vault as a package — notes, a guide, a template collection — and download packages shared by others. No servers to run, no accounts on a third-party platform, just a folder and a click.

## Why

Notes Hub is a community-built collection of notes for Obsidian. If you spent time organizing a course, structuring your notes, or building a useful guide — that work might save someone else a lot of time too. Notes Hub is a place to share it. It removes the friction of sharing and downloading interlinked notes between Obsidian vaults.

**The platform is free to use.**

## Features

- **Publish a folder as a package.** Right-click any folder and select **Publish** to package and upload it.
- **Update packages cleanly.** Authors can publish new versions of existing packages. Downloaded packages can be updated in place while preserving untouched files and safely moving modified files to trash.
- **Pre-publish checks.** Checks for broken links, unresolved targets, and camera EXIF metadata (GPS/serial numbers in JPGs) before uploading.
- **Safe block execution (Disarmed by default).** Executable scripts (such as `dataviewjs`, Templater, and other dynamic blocks) arrive safely disabled so foreign code never runs without your consent. Inspect the code in reading view and enable it with one click.
- **Vault isolation & conflict detection.** Downloaded packages are extracted into their own folder. The plugin warns you before install if note names overlap with existing notes in your vault.
- **Browse, filter, and manage.** Modal with **Browse**, **My packages**, and **Downloaded** (offline) tabs, tag filtering, sorting, and folder structure previews.
- **No email, no password.** Sign in with GitHub — only required if you want to publish packages. Downloading and browsing require no account.

## Installation

Notes Hub is not yet in the Obsidian Community Plugins directory. Until it is, install manually:

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from the Releases page.
2. Create a folder named `notes-hub` inside `<your-vault>/.obsidian/plugins/`.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Notes Hub** in **Settings → Community plugins**.

Alternatively, install through [BRAT](https://github.com/TfTHacker/obsidian42-brat) by pointing it at this repository.

## Getting started

### Sign in (for publishing)

1. Open **Settings → Notes Hub**.
2. Under **Account for publishing notes**, click **Connect GitHub** to authenticate in your browser.
3. Copy the generated token (`omp_...`), paste it into the token field, and click **Log in**.

### Publish a package

1. Right-click any folder in the file explorer and select **Publish**.
2. Review the pre-publish screen (file count, size, and warnings for broken links or photo EXIF metadata).
3. Fill in the **Title**, **Description**, and **Tags** (comma-separated).
4. Click **Publish**.

Only Markdown files, canvases, and supported images inside the folder are included. Hidden folders and unsupported file types are skipped automatically.

### Browse and download a package

1. Run the **Open marketplace** command from the command palette.
2. Explore packages in **Browse**, filter by tag, or change sort order.
3. Click any package card to view details, description, and the folder structure.
4. Click **Download**, review the security manifest and shadowed note warnings, and click **Install**.

The package is extracted into your configured download folder (defaults to `marketplace-downloads/<package-title>`).

### Running executable blocks safely

When a package contains executable code blocks (like `dataviewjs` or Templater):
- Blocks are installed in a disabled (`-off`) state with the code clearly visible in reading view.
- Click **Enable this block** on any panel after reviewing its code to activate it.
- Use the commands **Enable all blocks in this note** or **Disable all blocks in this note** to toggle all blocks in the active file.

### Update a downloaded package

1. Open the marketplace (**Open marketplace** command) and go to **Browse** or the **Downloaded** tab.
2. Packages with newer versions display an **Update available** badge.
3. Open the package and click **Update (vX → vY)**.
4. Review the write plan (new, replaced, unchanged files, or your own local edits moved to trash) and any newly requested capabilities.
5. Click **Update** to confirm.

### Update a published package

1. Right-click the folder in the file explorer and select **Publish**.
2. In the **Publish as** dropdown, select your existing package.
3. Review warnings, update details if desired, and click **Publish update**.

## Commands

| Command | Description |
|---|---|
| `Open marketplace` | Open the Notes Hub marketplace to browse, download, and manage packages. |
| `Enable all blocks in this note` | Turn on all disarmed executable blocks in the current note. |
| `Disable all blocks in this note` | Turn off all executable blocks in the current note for safe review. |

## Settings

| Setting | Description |
|---|---|
| **Download folder** | Folder in your vault where downloaded packages are placed (default: `marketplace-downloads`). |
| **Sign in / Account** | Connect with GitHub and paste your token to publish packages. Displays current username and active device count. |
| **Log out** | Signs out of the plugin on the current device only. |
| **Revoke device (Advanced)** | Revokes this device's token on the server if leaked. |
| **Close account (Advanced)** | Permanently deletes your account, devices, and all published packages. |

## Security and privacy

- **Safe execution by default:** Dynamic scripts and blocks arrive disarmed so untrusted code never executes automatically on install.
- **Server and client validation:** Files outside allowed extensions (Markdown, Canvas, common images) and malformed archive paths are rejected on both upload and download.
- **Privacy protection:** Pre-publish scan checks for camera EXIF metadata in JPG photos (GPS locations, camera serials) and broken vault links before publishing.
- **Vault safety:** Overwriting files during updates backs up locally modified files to the trash. Note name collisions across the vault are flagged before installation.
- **Zero tracking & minimal data:** No email or password stored. The plugin only transmits metadata and contents of folders you explicitly publish.

## Contributing

Issues and pull requests are welcome. If you're planning a larger change, open an issue first to discuss it.

## License

MIT — see [LICENSE](LICENSE).