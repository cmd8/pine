# Scoop

[Scoop](https://scoop.sh) is a package manager for Windows that installs programs into the user's
own folder (`~\scoop\apps`), without an installer and without administrator rights. Programs come
from buckets, which are GitHub repositories of JSON manifests. GUI apps belong in the
[Extras](https://github.com/ScoopInstaller/Extras) bucket. Once `pine.json` is merged there, anyone
can install the Pine app with:

```powershell
scoop bucket add extras
scoop install extras/pine
```

`pine.json` here is the manifest to submit to Extras. Nothing in pine or its workflows reads it.

## The rules that matter for Pine

From Extras' [package request template](https://github.com/ScoopInstaller/Extras/blob/master/.github/ISSUE_TEMPLATE/package-request.yml)
and Scoop's [contributing guide](https://github.com/ScoopInstaller/.github/blob/main/.github/CONTRIBUTING.md):

- Main takes command-line tools only, so a GUI app like Pine goes to Extras.
- Extras asks that an app be "reasonably well-known and widely used": for a GitHub project, at
  least 100 stars and/or 50 forks. Pine meets the stars condition. Its interface and docs must be in
  English, and the manifest must follow the latest stable release.
- An issue (a package request) comes first: maintainers are reluctant to take a pull request that
  has none.
- The pull request carries one manifest and is titled `<name>: Add version <version>`.
- `license` is an SPDX identifier (`MIT`).
- After the manifest is merged, the Excavator bot updates it (about every 4 hours). Pull requests
  that only bump a version are not accepted.

## How the manifest maps to a release

| Field | What it does |
|---|---|
| `architecture.64bit.url`, `architecture.arm64.url` | `Pine-<version>-<arch>-setup.exe` of the release, with `#/dl.7z` appended, so that Scoop opens the NSIS installer as a 7-Zip archive instead of running it. |
| `hash` | The SHA-256 of each installer. Checked by downloading both installers of 0.62.0. |
| `pre_install` | The installer holds the app as one archive, `$PLUGINSDIR\app-64.7z` (x64) or `$PLUGINSDIR\app-arm64.7z` (arm64). This expands it into the app's folder. Both names were checked by listing the 0.62.0 installers with 7-Zip. |
| `post_install` | Removes what is left of the installer: `$PLUGINSDIR` and `$R0` (which holds the NSIS uninstaller, `Uninstall Pine.exe`, not needed under Scoop). |
| `env_add_path: resources\bin` | Puts `pine.cmd` on the PATH, as the installer does, so that `pine` works in a terminal. It lies at `resources\bin\pine.cmd` in the app (checked in both archives). |
| `shortcuts` | A Start menu entry named Pine for `Pine.exe`, at the top of the app's folder (checked in both archives). |
| `checkver.github` | The release's version, read from the latest GitHub release. |
| `autoupdate` | The two installer addresses with `$version`; Excavator downloads them and computes the hashes. |

An install from Scoop differs from one by the installer: there is no entry under "Installed apps"
(Scoop removes it with `scoop uninstall pine`), and the `pine:` address is not registered, so a
pairing link of the web client does not open the app. The app's data is in the user's home
(`~\.pine`, and in WSL), not in the app's folder, so nothing needs `persist`.

## A new release

Nothing to do. Excavator sees the new GitHub release through `checkver`, fills in the new
addresses and hashes through `autoupdate`, and commits the change to Extras by itself. The copy in
this folder does not have to follow; the manifest in Extras is the one that counts.

The Pine app on Windows never updates itself: it only tells the user that a newer release is out
and links to its page (`desktop/electron/updates.ts`; `desktop/electron/updater.ts` makes no
updater outside a Mac). So nothing replaces files under Scoop's feet, and `scoop update pine` is how
a Scoop install gets a new version, as the manifest's note says.

## What was checked, and what was not

- The manifest was validated against Scoop's JSON schema (`schema.json` of ScoopInstaller/Scoop)
  with ajv.
- Both installers of 0.62.0 were downloaded, their SHA-256 matched the manifest, and 7-Zip listed
  `$PLUGINSDIR/app-64.7z` and `$PLUGINSDIR/app-arm64.7z` in them, and `Pine.exe` and
  `resources/bin/pine.cmd` in each of those archives.
- A real `scoop install` was not run: it needs Windows. Extras' `/verify` runs it on Windows for
  the pull request (below); trying it once by hand first is worth it, since an install outside
  `%LOCALAPPDATA%\Programs\Pine` must still reach pine in WSL.

## The owner's one-time steps

1. Optional, on a Windows computer with Scoop: try the manifest from this folder.

   ```powershell
   scoop install .\packaging\scoop\pine.json
   pine version
   scoop uninstall pine
   ```

2. Open a package request issue in [ScoopInstaller/Extras](https://github.com/ScoopInstaller/Extras/issues/new/choose),
   with the template's fields: the name `pine`, the homepage, the license (MIT), a short
   description, and the stars and forks of pmndre/pine.
3. Fork ScoopInstaller/Extras, copy `pine.json` to `bucket/pine.json` in the fork (update it to the
   latest release first if a newer one is out: the version, both addresses and both hashes), and
   open a pull request titled `pine: Add version 0.62.0` that names the issue (`Closes #<issue>`).
4. Comment `/verify` on the pull request to run Scoop's check, and fix what it reports.
5. After the merge, nothing more: Excavator keeps the manifest up to date with every release.
