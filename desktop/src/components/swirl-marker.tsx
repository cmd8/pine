import type { ComponentProps, CSSProperties } from "react";
import { Marker } from "@/components/ui/marker";
import { cn } from "@/lib/utils";

// One wavelength of a rule, 24 by 12 pixels, 6 from crest to trough, the mask the border's colour shows through.
// The swirl's distance (`--swirl-from`, 48px) is two of them, so the wave comes to rest where it would lie unmoved.
const WAVE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 12'%3E%3Cpath d='M0 6Q6 0 12 6T24 6' fill='none' stroke='black' stroke-width='1.25'/%3E%3C/svg%3E";

/**
 * A separator `Marker` whose two rules are waves that swirl in toward its label when it appears, and then lie
 * still. They move once and not for as long as they are shown: what moves all the time makes the system draw the
 * window at the screen's rate (see pulse.tsx), and a divider is on screen in nearly every conversation.
 */
export function SwirlMarker({ className, style, ...props }: ComponentProps<typeof Marker>) {
	return (
		<Marker
			variant="separator"
			style={{ "--swirl": `url("${WAVE}")`, ...style } as CSSProperties}
			className={cn(
				"before:h-3 before:animate-swirl before:[--swirl-from:-48px] before:[mask:var(--swirl)_0_50%/24px_12px_repeat-x] after:h-3 after:animate-swirl after:[--swirl-from:48px] after:[mask:var(--swirl)_0_50%/24px_12px_repeat-x] motion-reduce:before:animate-none motion-reduce:after:animate-none",
				className,
			)}
			{...props}
		/>
	);
}
