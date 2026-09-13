import Link from "next/link";
import type {ComponentProps} from "react";

/**
 * Button — the app's one button, in the five registers the product actually uses.
 *
 * There were 48 distinct button class strings in the app before this existed, which is 48 chances
 * for two controls that mean the same thing to look different. The registers are a hierarchy, not a
 * palette, so pick by what the control *does*:
 *
 *  - `primary` — solid brand yellow. **One per page**: the thing the page exists to let you do
 *    (Create Campaign, Confirm, Fund). A second one on the same screen means neither is primary.
 *  - `brand-outline` — the add/grow register (Add KPI, Add tier, Promote a campaign). Yellow enough
 *    to be found at a glance without a second solid block competing with the primary.
 *  - `secondary` — neutral outline, for stepping back: Reset, Cancel, Try again, Back.
 *  - `quiet` — text only until hovered. Tertiary actions and menu rows, where a border would draw a
 *    box around something that is not worth a box.
 *  - `danger-quiet` — quiet, turning critical on hover. Every destructive control (Remove, Delete,
 *    Disconnect), so the dangerous thing is never the loudest thing in a block.
 *
 * Yellow is reserved: the brand mark, `primary`, `brand-outline`, links, the active nav item and the
 * focus ring. It is not a labelling colour — see `ui/Card`, `ui/DataTable` and `ui/StatTile`.
 *
 * `Button` renders a `<button>` and `ButtonLink` renders a Next `Link`; they share one class builder
 * so a control that navigates and a control that acts cannot drift apart visually. Use the one that
 * matches the semantics — a link that looks like a button is still a link, and must be one.
 *
 * The focus ring comes from the `:focus-visible` rule in `globals.css` and is deliberately not
 * restated here; no variant may remove it.
 */

export type ButtonVariant = "primary" | "secondary" | "brand-outline" | "quiet" | "danger-quiet";

/** `sm` for controls that ride inside a dense row; `md` for everything else. */
export type ButtonSize = "sm" | "md";

type ButtonStyleProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Fill the container — a stacked form action, or a row in a menu. */
  full?: boolean;
  /**
   * Where the label sits when the button is wider than its content, which only happens under `full`.
   * `start` is for menu rows, whose labels have to line up with each other rather than with the
   * button's centre.
   */
  align?: "center" | "start";
  className?: string;
};

/*
  The look, taken from the create page's button constants so the two agree. Colour and weight belong
  to the variant, geometry to the size, which is why `primary` does not carry the `px-5` the create
  page's constant happened to use: padding is a function of the size, not of how loud the button is.
*/
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-brand font-semibold text-plane hover:opacity-90",
  secondary: "border border-hairline-strong font-medium text-ink hover:bg-surface-hover",
  "brand-outline": "border border-brand bg-brand/5 font-semibold text-brand hover:bg-brand/15",
  quiet: "font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink",
  "danger-quiet": "font-medium text-ink-secondary hover:bg-surface-hover hover:text-critical",
};

/*
  `md` is 44px tall on a phone and 36px from `sm` up. The phone floor is the smallest target a thumb
  hits reliably; carrying it onto the desktop header would stand the bar up by 8px for no gain, so it
  relaxes at the first breakpoint.

  Its padding goes the other way — tighter on a phone, roomier from `sm`. Height is what makes a
  control hittable; width is what a 320px row runs out of, and 8px of padding on each of the header's
  two buttons is several characters of the wallet address.
*/
const SIZE: Record<ButtonSize, string> = {
  sm: "min-h-8 px-2.5 text-xs",
  md: "min-h-11 px-3 text-sm sm:min-h-9 sm:px-4",
};

/*
  `transition` rather than `transition-colors`: `primary` fades its opacity on hover and the outline
  variants cross-fade their background, and one shared property list keeps a variant from having to
  restate the transition to add a hover it happens to need.
*/
const BASE =
  "inline-flex items-center gap-1.5 rounded-md transition disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The class string for a button in a given register. Exported for the handful of places that have to
 * put button styling on an element neither component renders.
 *
 * Everything the props decide is expressed here rather than left to `className`, because Tailwind
 * resolves two utilities for the same property by their order in the stylesheet, not by their order
 * in the string — so an override passed from a caller may or may not win. `className` is for
 * properties the component does not set (a width cap, an `aria-current` treatment), not for
 * contradicting one it does.
 *
 * @param props Variant, size, whether it fills its container, label alignment, and extra classes.
 * @returns The full class string, extras last.
 */
export function buttonClass({
  variant = "primary",
  size = "md",
  full = false,
  align = "center",
  className = "",
}: ButtonStyleProps = {}): string {
  return [
    BASE,
    align === "start" ? "justify-start text-left" : "justify-center",
    VARIANT[variant],
    SIZE[size],
    full ? "w-full" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A button that does something.
 *
 * `type` defaults to `"button"` rather than the HTML default of `"submit"`: most of these sit inside
 * a form somewhere, and a tertiary control that silently submits it is the kind of bug that only
 * shows up in someone's transaction history.
 */
export function Button({
  variant,
  size,
  full,
  align,
  className,
  type = "button",
  ...props
}: ButtonStyleProps & ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={buttonClass({variant, size, full, align, className})}
      {...props}
    />
  );
}

/** A link that looks like a button. Same look, and still a link: it navigates, so it is an `<a>`. */
export function ButtonLink({
  variant,
  size,
  full,
  align,
  className,
  ...props
}: ButtonStyleProps & ComponentProps<typeof Link>) {
  return <Link className={buttonClass({variant, size, full, align, className})} {...props} />;
}
