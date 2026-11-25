import type { Meta, StoryObj } from "@storybook/react-vite";
import { GlobeIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SideSheet } from "./side-sheet.tsx";

// A pane of the window: a card in a group of the layout where the window has room, a sheet over the tab in front where it has none.
const meta = {
	title: "Components/SideSheet",
	component: SideSheet,
	args: {
		slot: "story-panel",
		title: "Browser",
		sheet: false,
		barClassName: "pl-3 text-sm font-medium",
		onClose: () => {},
		bar: (
			<>
				<GlobeIcon className="size-3.5 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate">Browser</span>
				<Button variant="ghost" size="icon-xs" aria-label="Close the browser"><XIcon /></Button>
			</>
		),
		children: <p className="p-3 text-sm text-muted-foreground">What the panel shows.</p>,
	},
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SideSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** In a group of the layout, in a window with room: the group says where it lies and how large it is. */
export const Card: Story = {
	render: (args) => (
		<div className="flex h-96 w-120 p-1.5">
			<SideSheet {...args} />
		</div>
	),
};

/** Over the conversation, in a window without room for a column. */
export const Sheet: Story = { args: { sheet: true } };
