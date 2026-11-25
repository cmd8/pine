import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** What in a sheet takes Escape for itself: the editor (its search), a field, the page in the browser. */
export const ESCAPE_KEEPERS = ".cm-editor, input, textarea, [contenteditable], [data-slot=browser] canvas";

/**
 * A pane of the window (the side panel, the view): a bar on top and a body under it. Where the window has room it is
 * a card in a group of the layout, which says where it lies and how large it is; where it has none (`sheet`) it is a
 * stock sheet over the tab in front, from the right, and putting the sheet away is `onClose`.
 */
export function SideSheet({ slot, title, sheet, bar, barClassName, onClose, children }: {
	/** The frame's `data-slot`. */
	slot: string;
	/** Its name, said to a screen reader when it is a sheet. */
	title: string;
	sheet: boolean;
	/** What the bar on top holds. */
	bar: ReactNode;
	barClassName?: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const frame = (
		<div data-slot={slot} className={cn("flex min-w-0 flex-1 flex-col overflow-hidden bg-background", !sheet && "rounded-xl border")}>
			{/* A sheet as wide as a phone-wide window reaches under the window's buttons at the top left on a Mac; a sheet
			    reaches under the system's window controls at the top right on Windows and Linux whatever its width. */}
			<div className={cn("flex h-10 flex-none items-center gap-1.5 border-b border-line-soft px-2", barClassName, sheet && (document.documentElement.dataset.platform === "darwin" ? "max-sm:pl-window-buttons" : "pr-window-controls"))}>{bar}</div>
			{children}
		</div>
	);
	if (sheet)
		return (
			<Sheet open onOpenChange={(open, details) => {
				if (open) return;
				// Base UI closes on any Escape, even one the editor's search, an address field or the page in the browser
				// took for itself: that Escape is theirs. Escape anywhere else in the sheet still closes it.
				if (details.reason === "escape-key" && details.event.target instanceof Element && details.event.target.closest(ESCAPE_KEEPERS)) return details.cancel();
				onClose();
			}}>
				{/* The sheet lies over the title bar's drag region; it takes its own clicks by the rule index.css has for
				    everything Base UI puts in a portal. */}
				<SheetContent side="right" showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
					<SheetTitle className="sr-only">{title}</SheetTitle>
					{frame}
				</SheetContent>
			</Sheet>
		);
	return frame;
}
