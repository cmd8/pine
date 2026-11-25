import { DatabaseIcon, FileArchiveIcon, FileBracesIcon, FileCodeIcon, FileCogIcon, FileDiffIcon, FileIcon as PlainFileIcon, FileImageIcon, FileKeyIcon, FileLockIcon, FileMusicIcon, FileSpreadsheetIcon, FileTerminalIcon, FileTextIcon, FileTypeIcon, FileVideoCameraIcon, FolderIcon, FolderOpenIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** By the extension: the kind of file, as an editor's icon theme tells them apart. */
const BY_EXT: Record<string, LucideIcon> = {};
const add = (exts: string, icon: LucideIcon) => exts.split(" ").forEach((x) => (BY_EXT[x] = icon));
add("ts tsx mts cts js jsx mjs cjs html htm xml vue svelte astro css scss sass less py pyi go rs swift kt kts java scala rb c h cc cpp cxx hpp m mm lua dart cs fs php ex exs erl hs elm clj zig nim", FileCodeIcon);
add("json jsonc json5", FileBracesIcon);
add("sh bash zsh fish ps1 psm1 bat cmd", FileTerminalIcon);
add("yaml yml toml ini conf cfg env properties plist", FileCogIcon);
add("md mdx markdown txt text rst log pdf", FileTextIcon);
add("csv tsv xls xlsx ods numbers", FileSpreadsheetIcon);
add("sql sqlite sqlite3 db", DatabaseIcon);
add("png jpg jpeg gif webp bmp ico icns heic heif avif tif tiff svg", FileImageIcon);
add("mp4 mov webm mkv avi m4v", FileVideoCameraIcon);
add("mp3 wav m4a aac ogg oga opus flac aif aiff", FileMusicIcon);
add("zip gz tgz tar bz2 xz 7z rar zst", FileArchiveIcon);
add("ttf otf woff woff2", FileTypeIcon);
add("pem key crt cer p12 pfx pub", FileKeyIcon);
add("diff patch", FileDiffIcon);
add("lock", FileLockIcon);

/** By the whole name, before the extension: files that say what they are by their name alone. */
const BY_NAME: Record<string, LucideIcon> = {
	"package-lock.json": FileLockIcon,
	"pnpm-lock.yaml": FileLockIcon,
	dockerfile: FileCogIcon,
	makefile: FileTerminalIcon,
	".gitignore": FileCogIcon,
	".gitattributes": FileCogIcon,
	".editorconfig": FileCogIcon,
	".npmrc": FileCogIcon,
	".env": FileCogIcon,
	license: FileTextIcon,
};

/** The icon of a file by its name, or of a folder, open or closed. */
export function fileIconOf(name: string, dir = false, open = false): LucideIcon {
	if (dir) return open ? FolderOpenIcon : FolderIcon;
	const lower = name.toLowerCase();
	if (BY_NAME[lower]) return BY_NAME[lower];
	if (lower.startsWith(".env.")) return BY_NAME[".env"];
	if (lower.startsWith("license.") || lower.startsWith("licence")) return BY_NAME.license;
	const dot = lower.lastIndexOf(".");
	return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || PlainFileIcon;
}

/**
 * A file's icon in a list or the tree: what kind of file it is, in grey. `tone` colors it for what
 * git says of it (changed, new), as an editor's tree marks those; nothing else gives it a color.
 */
export function FileIcon({ name, dir, open, tone, className }: { name: string; dir?: boolean; open?: boolean; tone?: string; className?: string }) {
	const Icon = fileIconOf(name, dir, open);
	return <Icon data-slot="file-icon" aria-hidden className={cn("size-4 shrink-0", tone ?? "text-faint", className)} />;
}
