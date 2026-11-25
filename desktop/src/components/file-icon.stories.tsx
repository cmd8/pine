import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileIcon as Icon } from "./file-icon.tsx";

// A file's icon in the side panel's lists and tree: its kind, in its language's color from the theme's terminal colors.
const meta = { title: "Components/FileIcon", component: Icon, args: { name: "agents.ts" } } satisfies Meta<typeof Icon>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FileIcon: Story = {};

const NAMES = ["src", "agents.ts", "App.tsx", "main.js", "package.json", "package-lock.json", "index.html", "index.css", "README.md", "notes.txt", "build.py", "lib.rs", "main.go", "App.swift", "deploy.sh", "Makefile", "Dockerfile", "config.yaml", ".gitignore", ".env.local", "data.csv", "store.sqlite", "logo.svg", "photo.png", "clip.mp4", "sound.wav", "dist.zip", "Inter.woff2", "server.pem", "fix.patch", "LICENSE", "a.out"];

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
