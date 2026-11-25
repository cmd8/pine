import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MarkerContent } from "@/components/ui/marker";
import { SwirlMarker as Swirl } from "./swirl-marker.tsx";

// A divider whose rules swirl in toward its label when it appears, then lie still: the checkpoint before the last message.
const meta = { title: "Components/SwirlMarker", component: Swirl, parameters: { layout: "padded" } } satisfies Meta<typeof Swirl>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SwirlMarker: Story = {
	args: {},
	render: (args) => (
		<Swirl {...args}>
			<MarkerContent className="inline-flex items-center gap-2">
				before your last message
				<Button size="xs" variant="outline">Take back</Button>
			</MarkerContent>
		</Swirl>
	),
};

function Again() {
	const [n, setN] = useState(0);
	return (
		<div className="flex flex-col items-start gap-4">
			<Swirl key={n}>
				<MarkerContent>before your last message</MarkerContent>
			</Swirl>
			<Button size="sm" variant="outline" onClick={() => setN(n + 1)}>Again</Button>
		</div>
	);
}

/** Drawn anew, as when a message is sent and the divider moves to it. */
export const Appearing: Story = { args: {}, render: () => <Again /> };
