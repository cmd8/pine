# The Pine app on Linux: where it can be listed

Every release from `main` attaches the Linux app to its GitHub release (job `app-linux` in
`.github/workflows/release.yml`): an AppImage and a .deb for x64 and arm64, and
`SHA256SUMS-linux-x64` and `SHA256SUMS-linux-arm64`. The files here put those same files into two
places where Linux users look for software. Neither rebuilds anything.

The app on Linux never updates itself: it only says that a newer release is out
(`desktop/electron/updates.ts`). So a package manager that installed it is never fought over the
files it owns.

## AUR: `pine-desktop-bin`

`aur/pine-desktop-bin/` holds the `PKGBUILD` and its `.SRCINFO`.

- What it is: the Arch User Repository, recipes that users build with `makepkg` (or a helper such
  as `yay` or `paru`). A recipe that repackages a prebuilt file carries the `-bin` suffix; the name
  is that of the upstream package, `pine-desktop` (the .deb's name and the program's), which keeps
  `pine` free for a package of the command line.
- What it does: unpacks the release's .deb into the same places (`/opt/Pine`, `/usr/share`), links
  `/usr/bin/pine-desktop`, sets `chrome-sandbox` to 0755 (Arch has unprivileged user namespaces, so
  Chromium needs no setuid helper) and drops the AppArmor profile, which is Ubuntu's.
  `options=('!strip' '!debug')`: the Electron binaries are shipped as they are.
- Optional dependencies: `bubblewrap` (the sandbox of `safe` and `manual` mode), `python-gobject`
  and `python-xlib` (app control on X11, `mcp/computer-linux.py`), `whisper-cpp` with `libpulse` or
  `alsa-utils` (dictation, `src/tui/voice-linux.ts`; Arch's `whisper-cpp` installs `whisper-cli`).
- Rules: https://wiki.archlinux.org/title/AUR_submission_guidelines. Every push carries a
  `.SRCINFO` that matches the `PKGBUILD`, or the AUR refuses it.
- A new release: `pkgver` and the two checksums change, and `pkgrel` goes back to 1. The checksums
  are the .deb lines of `SHA256SUMS-linux-x64` and `SHA256SUMS-linux-arm64`. Then
  `makepkg --printsrcinfo > .SRCINFO`, commit, push.

How it was checked (v0.62.0): `makepkg` and `namcap` in an `archlinux:latest` linux/amd64
container. Under emulation pacman needs `DisableSandbox` under `[options]` in `/etc/pacman.conf`.
What namcap still says is what it says of any prebuilt Electron app in `/opt`: "ELF files outside
of a valid path", binaries that are unstripped or lack PIE or full RELRO, man pages of
`node_modules` outside `/usr/share/man`, interpreters (`node`, `sh`, `bash`, `python`) named by
scripts that pine does not run that way (pine runs on the Node it carries), the two Python
modules being optional, and some of `depends` "may not be needed": those are what Electron's own
.deb asks for (`libnotify`, `libxss`, `libxtst`, `xdg-utils`, `util-linux-libs`, `libsecret`),
which it loads at run time rather than links.

### The owner's steps, once

1. Make an account at https://aur.archlinux.org/register (it has a captcha), and an SSH key pair
   for it alone (`ssh-keygen -t ed25519 -f ~/.ssh/aur`). Put the public half under "My Account".
   Add to `~/.ssh/config`:

   ```
   Host aur.archlinux.org
     IdentityFile ~/.ssh/aur
     User aur
   ```

2. Fill in the `# Maintainer:` line of the `PKGBUILD` with that account's name and address.
3. Clone the empty package, copy both files, push. The first push creates the package.

   ```bash
   git clone ssh://aur@aur.archlinux.org/pine-desktop-bin.git
   cp packaging/aur/pine-desktop-bin/PKGBUILD packaging/aur/pine-desktop-bin/.SRCINFO pine-desktop-bin/
   cd pine-desktop-bin && git add PKGBUILD .SRCINFO && git commit -m "pine-desktop-bin 0.62.0" && git push
   ```

### Later: each release pushed by the release workflow

Not wired yet. A job after `app-linux` would download both `SHA256SUMS-linux-*` files of the
release, write `pkgver`, `pkgrel=1` and the two checksums into the `PKGBUILD`, and push it with
`KSXGitHub/github-actions-deploy-aur` (pinned by commit SHA like the other actions; it writes the
`.SRCINFO` itself, in an Arch container). It needs the AUR key's private half as a secret
`AUR_SSH_PRIVATE_KEY` in the environment `release`, and passes saying so when the secret is not
there. The AUR's guidelines warn that automation does not replace a maintainer: `depends` is
looked at again when Electron changes what it links.

## AppImageHub: `appimagehub/Pine`

`appimagehub/Pine` is the file that goes to `data/Pine` in https://github.com/AppImage/appimage.github.io:
one line, the repository's address. With that, AppImageHub takes the AppImage of the latest
release by itself whenever it builds its catalog: no pull request per release.

- Rules: their CI downloads the newest release's AppImage and starts it without a network, on the
  oldest Ubuntu LTS they support, under X11. The main window has to show within 30 seconds. The
  AppImage has to be a type-2 squashfs one, its desktop file has to pass `desktop-file-validate`,
  and it has to pass `appdir-lint.sh`. AppStream metainfo in `usr/share/metainfo` is recommended
  and validated when it is there.
- The risk for pine: its first start without a network (the daemon, the welcome) has to draw the
  window within those 30 seconds.

### The owner's step, once

A pull request to AppImage/appimage.github.io that adds `data/Pine` with the line in
`appimagehub/Pine`. GitHub's web editor makes the fork it needs ("Add file" on `data/`).

### Metainfo, not packed yet

The v0.62.0 x86_64 AppImage carries no `usr/share/metainfo` (checked by extracting it). A minimal
file is in `desktop/assets/dev.pine.desktop.metainfo.xml` (id `dev.pine.desktop`, the app's
`appId`; launchable `pine-desktop.desktop`), valid under `appstreamcli validate`. It has no
screenshot: the repository has no still image of the app at a public address (`docs/images/reel.webp`
is animated WebP, which catalogs do not take), and Flathub would require one.

electron-builder has no option that puts a file into `usr/share/metainfo` of the AppImage or the
.deb, so packing it changes the build: for the AppImage, extract it after `pack.mjs`, copy the file
into `usr/share/metainfo/`, and rebuild it with `appimagetool`; the .deb would need fpm's own
arguments. That is a follow-up, together with update information (below), which needs the same
repack, and with a `<release>` line written for each release.

### Later: AppImage updates by zsync

electron-builder's AppImage carries electron-updater's scheme, which standard tools do not read.
Repacked with `appimagetool -u "gh-releases-zsync|pmndre|pine|latest|Pine-*-x86_64.AppImage.zsync"`
(and the arm64 one), it would also write a `.zsync` beside each AppImage, and AppImageUpdate,
AppImageLauncher and Gear Lever could then bring it up to date in place, by deltas. The checksums
and the attestation would be made after the repack.

## What waits, and why

| Channel | Why not now |
|---|---|
| Flathub | The project is weeks old, and Flathub generally refuses apps that have existed only for a short time. Broad-scope development tools (terminals, IDEs) are accepted only when upstream submits them. Its generative-AI policy forbids AI-assisted manifests and AI-opened submissions, and pine's history is largely AI-co-authored. Every Flathub app is built from source without network (an offline npm build of the root, `desktop/` and the native modules), not repackaged. And `bwrap` cannot nest inside a Flatpak, so `safe` mode would need `flatpak-spawn` and a linter exception. |
| Snap Store | A useful snap needs classic confinement, which is a manual review; in 2026 young AI agents were refused it ("mature, well-known applications"). |
| A signed apt repository | It needs a GPG key kept as a release secret. The .debs are over GitHub Pages' 100 MB limit, so the pool cannot be on Pages. The idea: an index on the existing Cloudflare Worker, with `pool/` answered by 302s to the release assets, which apt follows. Untested. |
