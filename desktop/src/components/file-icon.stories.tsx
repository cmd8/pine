import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileIcon as Icon } from "./file-icon.tsx";

// A file's icon in the side panel's lists and tree: its kind, in grey, colored only for what git says of it.
const meta = { title: "Components/FileIcon", component: Icon, args: { name: "agents.ts" } } satisfies Meta<typeof Icon>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FileIcon: Story = {};

const NAMES = ["src", "agents.ts", "App.tsx", "main.js", "package.json", "package-lock.json", "index.html", "index.css", "README.md", "notes.txt", "build.py", "lib.rs", "main.go", "App.swift", "deploy.sh", "Makefile", "Dockerfile", "config.yaml", ".gitignore", ".env.local", "data.csv", "store.sqlite", "logo.svg", "photo.png", "clip.mp4", "sound.wav", "dist.zip", "Inter.woff2", "server.pem", "fix.patch", "LICENSE", "a.out"];

/** Changed and new, as git says (the Changes view's colors). */
export const InGit: Story = {
	render: () => (
		<div className="flex flex-col text-sm">
			<span className="flex h-6 items-center gap-2"><Icon name="agents.ts" tone="text-warn" />agents.ts (changed)</span>
			<span className="flex h-6 items-center gap-2"><Icon name="notes.md" tone="text-add" />notes.md (new)</span>
			<span className="flex h-6 items-center gap-2"><Icon name="src" dir tone="text-warn" />src (holds changes)</span>
			<span className="flex h-6 items-center gap-2"><Icon name="README.md" />README.md</span>
		</div>
	),
};

/** Every kind beside its name, as the tree lists them. */
export const Kinds: Story = {
	render: () => (
		<div className="flex flex-col text-sm">
			{NAMES.map((name, i) => (
				<span key={name} className="flex h-6 items-center gap-2">
					<Icon name={name} dir={i === 0} />
					{name}
				</span>
			))}
		</div>
	),
};
