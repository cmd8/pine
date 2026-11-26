# winget

[winget](https://learn.microsoft.com/en-us/windows/package-manager/) is the package manager that
comes with Windows 10 and 11. Its catalog is one GitHub repository,
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs): a package is a folder of YAML
manifests there, and every change to it is a pull request. Once the package is merged, anyone can
install the Pine app with:

```powershell
winget install pmndre.Pine
```

This folder holds the manifests of Pine's first submission, laid out as they go into winget-pkgs:
`manifests/p/pmndre/Pine/<version>/`. Nothing here is read by pine or by its workflows; it is a
copy for the owner to submit and for anyone to check.

## The rules that matter for Pine

From the [policies](https://learn.microsoft.com/en-us/windows/package-manager/package/windows-package-manager-policies),
the [repository docs](https://learn.microsoft.com/en-us/windows/package-manager/package/repository)
and winget-pkgs' own [Policies](https://github.com/microsoft/winget-pkgs/blob/master/doc/Policies.md),
[Validation](https://github.com/microsoft/winget-pkgs/blob/master/doc/Validation.md) and
[Authoring](https://github.com/microsoft/winget-pkgs/blob/master/doc/Authoring.md) pages:

- No notability threshold: the rules are about accurate metadata and an installer that behaves.
  Microsoft may still refuse a submission for any reason.
- One package version per pull request, as a multi-file manifest (version, installer and default
  locale files); a singleton manifest is not accepted.
- Signing is not required. What gates a submission is the validation pipeline: several antivirus
  engines and a Defender scan after a real install (`Binary-Validation-Error`,
  `Validation-Defender-Error`), the reputation of the download address, an unattended install that
  works without administrator rights (`Validation-Unattended-Failed`), and a clean uninstall
  (`Validation-Uninstall-Error`). Pine's installers are not signed yet: the environment `release`
  has no SignPath secrets, so they are uploaded unsigned (`desktop/signpath/README.md`). A
  signature would help with false positives once it is set up. Pine's pattern (helpers, a C#
  helper compiled at run time, shells, app control) could still trip a heuristic: that is the one
  real risk.
- The installer address must be the publisher's own release location, unique for each version.
  GitHub release assets are that.
- A new package always gets a human review after the pipeline. A pull request labeled
  `Needs-Author-Feedback` that nobody answers is closed after 10 days.
- `ManifestVersion` is the schema the repository accepts today: 1.28.0, which current komac emits.
  Use what the tool of the day writes for later versions.

## How the files map to a release

| Manifest field | Comes from |
|---|---|
| `PackageIdentifier: pmndre.Pine` | Publisher `pmndre`, package `Pine`. No package named Pine was in winget-pkgs when this was written. |
| `PackageVersion` | The release's version, the tag without its `v`. |
| `InstallerUrl` (x64, arm64) | `https://github.com/pmndre/pine/releases/download/v<version>/Pine-<version>-<arch>-setup.exe`, the two installers `app-windows-sign` attaches to a release. |
| `InstallerSha256` | The SHA-256 of each installer (GitHub shows it as the asset's digest). Checked against the asset digests of 0.62.0 after its rebuild of 2026-11-26. |
| `InstallerType: nullsoft`, `Scope: user` | electron-builder's NSIS installer, for the user alone (`perMachine: false` in `desktop/scripts/pack.mjs`). There is no machine-wide installer, so there is no machine entry. |
| `InstallerSwitches.Custom: /currentuser` | The installer is an assisted one (`oneClick: false`), which asks for the scope unless it is told. |
| `InstallerSwitches.Upgrade: --updated` | Tells electron-builder's installer that it is an upgrade, so it does not treat it as a fresh install. |
| `ProductCode`, `AppsAndFeaturesEntries` | `45297c1c-a211-5de0-a95f-24656b0c071b`: electron-builder's uninstall key, the UUID v5 of the appId `dev.pine.desktop`. It ties the installed app to the package and avoids an upgrade loop. It stays the same for every release while the appId does. |
| `Protocols: pine` | The `pine:` address the app registers (`protocols` in `desktop/scripts/pack.mjs`). |
| `ReleaseDate`, `ReleaseNotesUrl` | The release's date and its page. |

## A new release

winget does not look for releases by itself. Each version is a new folder in winget-pkgs, made by a
pull request. Once the first version is merged, a later one is one command with
[komac](https://github.com/russellbanks/Komac):

```powershell
komac update pmndre.Pine --version 0.63.0 --urls https://github.com/pmndre/pine/releases/download/v0.63.0/Pine-0.63.0-x64-setup.exe https://github.com/pmndre/pine/releases/download/v0.63.0/Pine-0.63.0-arm64-setup.exe --submit --token <classic PAT>
```

or by a workflow (below). Community bots often bump a package on their own once it exists, but
nothing promises that. The folder in this repository does not have to follow each release: the
manifests in winget-pkgs are the ones that count.

The Pine app on Windows never updates itself: it only tells the user that a newer release is out
and links to its page (`desktop/electron/updates.ts`; `desktop/electron/updater.ts` makes no
updater outside a Mac). So no updater of the app's competes with winget, and `winget upgrade` is
how a winget install gets a new version.

## What was checked, and what was not

- The three files were validated against winget's JSON schemas for 1.28.0
  (`manifest.version`, `manifest.installer`, `manifest.defaultLocale`) with ajv.
- Both installers of 0.62.0 were downloaded, their SHA-256 matched the manifest, and 7-Zip listed
  them as electron-builder NSIS installers.
- `winget validate` and a real `winget install --manifest` were not run: they need Windows, and
  this was prepared on a Mac. Run both once on a Windows computer before submitting (below).

## The owner's one-time steps

1. On a Windows computer, check the manifests:

   ```powershell
   winget validate --manifest packaging\winget\manifests\p\pmndre\Pine\0.62.0
   winget settings --enable LocalManifestFiles
   winget install --manifest packaging\winget\manifests\p\pmndre\Pine\0.62.0
   winget uninstall pmndre.Pine
   ```

2. Install a submission tool: komac (`winget install russellbanks.Komac`) or Microsoft's
   wingetcreate (`winget install Microsoft.WingetCreate`). Either needs a GitHub token; a classic
   personal access token with the `public_repo` scope is enough.
3. Submit the first version. With komac, from this folder's files:

   ```powershell
   komac submit packaging\winget\manifests\p\pmndre\Pine\0.62.0 --token <classic PAT>
   ```

   komac forks winget-pkgs under the token's account and opens the pull request. By hand instead:
   fork microsoft/winget-pkgs, copy `manifests/p/pmndre/Pine/0.62.0/` into the same path of the
   fork, and open a pull request titled `New package: pmndre.Pine version 0.62.0`. If a newer Pine
   is out by then, submit that version instead: `komac new pmndre.Pine` asks for the installer
   addresses and writes the files again (keep the values of the table above).
4. Watch the pull request: answer a moderator's question within 10 days, and if the antivirus scan
   flags the installer, ask for a manual review in the pull request.
5. Optional, after the first version is merged: let the Release workflow submit every release with
   [vedantmgoyal9/winget-releaser](https://github.com/vedantmgoyal9/winget-releaser). It needs:
   - a fork of microsoft/winget-pkgs under the account that owns the token (`fork-user` names it
     when that is not `pmndre`);
   - a **classic** personal access token with the `public_repo` and `workflow` scopes (fine-grained
     tokens are not supported), stored as a secret, for example `WINGET_TOKEN` in the environment
     `release`;
   - a job in `.github/workflows/release.yml` after `app-windows-sign`, which passes and says
     nothing was submitted when the secret is missing, as the signing jobs do without theirs.
     Its step, with the action pinned by commit like the others:

     ```yaml
     - uses: vedantmgoyal9/winget-releaser@<commit> # v2
       with:
         identifier: pmndre.Pine
         version: <the release's version>
         release-tag: v<the release's version>
         installers-regex: '-setup\.exe$'
         token: ${{ secrets.WINGET_TOKEN }}
     ```

     Such a job is not in the workflow yet: it can only be tried once the package exists in
     winget-pkgs. Whoever adds it lists the secret in the Releases section of `AGENTS.md`.
