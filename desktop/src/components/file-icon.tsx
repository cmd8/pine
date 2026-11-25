import { DatabaseIcon, FileArchiveIcon, FileBracesIcon, FileCodeIcon, FileCogIcon, FileDiffIcon, FileIcon as PlainFileIcon, FileImageIcon, FileKeyIcon, FileLockIcon, FileMusicIcon, FileSpreadsheetIcon, FileTerminalIcon, FileTextIcon, FileTypeIcon, FileVideoCameraIcon, FolderIcon, FolderOpenIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The terminal's colors of the theme (src/theme-colors.ts), so that a file's tint follows the theme as the code's does.
const RED = "text-(--term-1)";
const GREEN = "text-(--term-2)";
const YELLOW = "text-(--term-3)";
const BLUE = "text-(--term-4)";
const MAGENTA = "text-(--term-5)";
const CYAN = "text-(--term-6)";
const PLAIN = "text-faint";

type Look = [LucideIcon, string];

/** By the extension: a kind of file and a language's color, as an editor's icon theme draws them (VS Code's Seti). */
const BY_EXT: Record<string, Look> = {};
const add = (exts: string, look: Look) => exts.split(" ").forEach((x) => (BY_EXT[x] = look));
add("ts tsx mts cts", [FileCodeIcon, BLUE]);
add("js jsx mjs cjs", [FileCodeIcon, YELLOW]);
add("json jsonc json5", [FileBracesIcon, YELLOW]);
add("html htm xml vue svelte astro", [FileCodeIcon, RED]);
add("css scss sass less", [FileCodeIcon, CYAN]);
add("py pyi", [FileCodeIcon, BLUE]);
add("go", [FileCodeIcon, CYAN]);
add("rs swift kt kts java scala rb", [FileCodeIcon, RED]);
add("c h cc cpp cxx hpp m mm lua dart", [FileCodeIcon, BLUE]);
add("cs fs", [FileCodeIcon, GREEN]);
add("php ex exs erl hs elm clj", [FileCodeIcon, MAGENTA]);
add("zig nim", [FileCodeIcon, YELLOW]);
add("sh bash zsh fish ps1 psm1 bat cmd", [FileTerminalIcon, GREEN]);
add("yaml yml toml ini conf cfg env properties plist", [FileCogIcon, MAGENTA]);
add("md mdx markdown", [FileTextIcon, BLUE]);
add("txt text rst log", [FileTextIcon, PLAIN]);
add("pdf", [FileTextIcon, RED]);
add("csv tsv xls xlsx ods numbers", [FileSpreadsheetIcon, GREEN]);
add("sql sqlite sqlite3 db", [DatabaseIcon, YELLOW]);
add("png jpg jpeg gif webp bmp ico icns heic heif avif tif tiff", [FileImageIcon, MAGENTA]);
add("svg", [FileImageIcon, YELLOW]);
add("mp4 mov webm mkv avi m4v", [FileVideoCameraIcon, MAGENTA]);
add("mp3 wav m4a aac ogg oga opus flac aif aiff", [FileMusicIcon, MAGENTA]);
add("zip gz tgz tar bz2 xz 7z rar zst", [FileArchiveIcon, PLAIN]);
add("ttf otf woff woff2", [FileTypeIcon, PLAIN]);
add("pem key crt cer p12 pfx pub", [FileKeyIcon, YELLOW]);
add("diff patch", [FileDiffIcon, GREEN]);
add("lock", [FileLockIcon, PLAIN]);

/** By the whole name, before the extension: files that say what they are by their name alone. */
const BY_NAME: Record<string, Look> = {
	"package-lock.json": [FileLockIcon, PLAIN],
	"pnpm-lock.yaml": [FileLockIcon, PLAIN],
	dockerfile: [FileCogIcon, BLUE],
	makefile: [FileTerminalIcon, GREEN],
	".gitignore": [FileCogIcon, PLAIN],
	".gitattributes": [FileCogIcon, PLAIN],
	".editorconfig": [FileCogIcon, PLAIN],
	".npmrc": [FileCogIcon, PLAIN],
	".env": [FileCogIcon, MAGENTA],
	license: [FileTextIcon, YELLOW],
};

/** The icon and the color of a file by its name, or of a folder, open or closed. */
export function fileLook(name: string, dir = false, open = false): Look {
	if (dir) return [open ? FolderOpenIcon : FolderIcon, PLAIN];
	const lower = name.toLowerCase();
	if (BY_NAME[lower]) return BY_NAME[lower];
	if (lower.startsWith(".env.")) return BY_NAME[".env"];
	if (lower.startsWith("license.") || lower.startsWith("licence")) return BY_NAME.license;
	const dot = lower.lastIndexOf(".");
	return (dot > 0 && BY_EXT[lower.slice(dot + 1)]) || [PlainFileIcon, PLAIN];
}

/** A file's icon in a list or the tree: what kind of file it is, in its language's color. */
export function FileIcon({ name, dir, open, className }: { name: string; dir?: boolean; open?: boolean; className?: string }) {
	const [Icon, color] = fileLook(name, dir, open);
	return <Icon data-slot="file-icon" aria-hidden className={cn("size-4 shrink-0", color, className)} />;
}
