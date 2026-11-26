#!/bin/sh
# Makes the AppImages that pack.mjs wrote updatable by the standard AppImage tools (AppImageUpdate,
# Gear Lever, appimageupdatetool), in place:
#   sh desktop/scripts/appimage-update.sh desktop/release/Pine-<version>-<arch>.AppImage ...
#
# electron-builder writes no update information of the AppImage kind (it appends a blockmap for
# electron-updater, which the app does not use on Linux), packs no AppStream metainfo, and builds on
# the old runtime that needs the system's libfuse2. So each AppImage is taken apart and built again
# with appimagetool:
#   - usr/share/metainfo/dev.pine.desktop.metainfo.xml is added (desktop/assets, with this release's
#     version and date), for the catalogs (AppImageHub, GNOME Software, KDE Discover), and the desktop
#     file it names is copied to usr/share/applications, where AppStream looks for it;
#   - the update information is embedded: gh-releases-zsync|pmndre|pine|latest|Pine-*-<arch>.AppImage.zsync,
#     and Pine-<version>-<arch>.AppImage.zsync is written beside the AppImage, for the release;
#   - the runtime is the static one, which needs no libfuse2.
# The file keeps its name, which the app's own update check looks for (desktop/electron/updates.ts).
#
# appimagetool and the runtime are fetched from tagged releases, for this computer's processor, and
# used only when they are the files whose checksums are written below. (Their "continuous" releases
# are replaced with every build, so a checksum of one would stop matching.) An AppImage is taken apart
# by running it, so it has to be for this computer's processor too: a release packs on each.
set -eu

APPIMAGETOOL_VERSION=1.9.1
RUNTIME_VERSION=20251108
case "$(uname -m)" in
	x86_64)
		tool_arch=x86_64
		tool_sum=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
		runtime_sum=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
		;;
	aarch64 | arm64)
		tool_arch=aarch64
		tool_sum=f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158
		runtime_sum=00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444
		;;
	*)
		echo "appimage-update.sh runs on x86_64 or aarch64 Linux, not on $(uname -m)." >&2
		exit 2
		;;
esac
if [ "$#" -eq 0 ]; then
	echo "Name the AppImages: sh desktop/scripts/appimage-update.sh desktop/release/Pine-<version>-<arch>.AppImage" >&2
	exit 2
fi

# appimagetool needs `file`; the rest is for this script.
for program in curl sha256sum dd file; do
	if ! command -v "$program" >/dev/null 2>&1; then
		echo "appimage-update.sh needs $program: install it (on Ubuntu: sudo apt-get install -y curl coreutils file)." >&2
		exit 2
	fi
done

here="$(cd "$(dirname "$0")" && pwd)"
metainfo="$here/../assets/dev.pine.desktop.metainfo.xml"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

# fetch <url> <sha256> <file>: the file, only when it is the one the checksum names.
fetch() {
	curl -fsSL --retry 3 -o "$3" "$1"
	if ! printf '%s  %s\n' "$2" "$3" | sha256sum -c - >/dev/null 2>&1; then
		echo "$1 is not the file whose checksum appimage-update.sh records ($2): look at the release, and write the new checksum only if it is the one you meant." >&2
		exit 1
	fi
}
tool="$work/appimagetool"
runtime="$work/runtime"
fetch "https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-$tool_arch.AppImage" "$tool_sum" "$work/appimagetool.download"
fetch "https://github.com/AppImage/type2-runtime/releases/download/$RUNTIME_VERSION/runtime-$tool_arch" "$runtime_sum" "$runtime"

# runnable <AppImage> <copy>: a copy of the AppImage that also runs under an emulator. An AppImage marks
# itself with "AI" and its type in bytes 8 to 10 of its ELF header, and the handlers that run another
# processor's programs (Docker Desktop's, qemu's) match those bytes and refuse it ("Exec format error").
# The runtime does not read them back.
runnable() {
	cp "$1" "$2"
	printf '\000\000\000' | dd of="$2" bs=1 seek=8 count=3 conv=notrunc 2>/dev/null
	chmod +x "$2"
}
runnable "$work/appimagetool.download" "$tool"

for image in "$@"; do
	name="$(basename "$image")"
	case "$name" in
		Pine-*-x86_64.AppImage) arch=x86_64 ;;
		Pine-*-arm64.AppImage) arch=arm64 ;;
		*)
			echo "$name is not named as pack.mjs names an AppImage (Pine-<version>-x86_64.AppImage or Pine-<version>-arm64.AppImage)." >&2
			exit 2
			;;
	esac
	if { [ "$arch" = x86_64 ] && [ "$tool_arch" != x86_64 ]; } || { [ "$arch" = arm64 ] && [ "$tool_arch" != aarch64 ]; }; then
		echo "$name is for another processor than this computer's ($(uname -m)): repack it on a computer of its kind." >&2
		exit 2
	fi
	version="${name#Pine-}"
	version="${version%-"$arch".AppImage}"
	info="gh-releases-zsync|pmndre|pine|latest|Pine-*-$arch.AppImage.zsync"
	image="$(cd "$(dirname "$image")" && pwd)/$name"

	rm -rf "$work/x"
	mkdir "$work/x"
	runnable "$image" "$work/input.AppImage"
	(cd "$work/x" && "$work/input.AppImage" --appimage-extract >/dev/null)
	rm -f "$work/input.AppImage"
	appdir="$work/x/squashfs-root"
	if [ ! -f "$appdir/pine-desktop.desktop" ]; then
		echo "$name has no pine-desktop.desktop, which the metainfo's <launchable> names: did the packer's executableName change?" >&2
		exit 1
	fi

	# The desktop file where AppStream looks for the one <launchable> names, beside the AppDir's own.
	mkdir -p "$appdir/usr/share/applications" "$appdir/usr/share/metainfo"
	cp "$appdir/pine-desktop.desktop" "$appdir/usr/share/applications/pine-desktop.desktop"
	sed -e "s|<release version=\"[^\"]*\" date=\"[^\"]*\">|<release version=\"$version\" date=\"$(date -u +%Y-%m-%d)\">|" \
		-e "s|releases/tag/v[^<]*<|releases/tag/v$version<|" \
		"$metainfo" >"$appdir/usr/share/metainfo/dev.pine.desktop.metainfo.xml"
	if ! grep -q "<release version=\"$version\"" "$appdir/usr/share/metainfo/dev.pine.desktop.metainfo.xml"; then
		echo "$metainfo has no <release> line that could take the version $version: its form changed, and this script has to follow." >&2
		exit 1
	fi

	# appimagetool is an AppImage itself: extracted and run, so that it needs no FUSE either.
	(cd "$work" && ARCH="$tool_arch" APPIMAGE_EXTRACT_AND_RUN=1 "$tool" --runtime-file "$runtime" -u "$info" "$appdir" "$work/$name")
	if [ ! -s "$work/$name.zsync" ]; then
		echo "appimagetool wrote no $name.zsync." >&2
		exit 1
	fi
	mv -f "$work/$name" "$image"
	mv -f "$work/$name.zsync" "$image.zsync"
	chmod +x "$image"

	runnable "$image" "$work/output.AppImage"
	said="$("$work/output.AppImage" --appimage-updateinformation)"
	rm -f "$work/output.AppImage"
	if [ "$said" != "$info" ]; then
		echo "$name says its update information is \"$said\", not \"$info\"." >&2
		exit 1
	fi
	echo "$name: update information $info, and $name.zsync beside it"
done
