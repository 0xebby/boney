/**
 * NavLabel — a nav destination's label, with the "new" mark raised above it where it carries one.
 *
 * Both consumers of `navItems` render through this, so the mark's size, colour and blink have one
 * answer rather than two that drift. The word is part of the link's accessible name, and it blinks in
 * the same 1.2s step as the bar's beta chip one step smaller, so the two read as siblings.
 *
 * @param label The destination's label.
 * @param isNew Whether to raise the "new" mark beside it.
 * @returns The label, wrapped only when a mark is rendered.
 */
export function NavLabel({label, isNew}: {label: string; isNew?: boolean}) {
  if (!isNew) return <>{label}</>;

  return (
    <span className="inline-flex items-start gap-0.5 whitespace-nowrap">
      {label}
      <span className="animate-blink text-[9px] font-bold uppercase leading-none tracking-wider text-brand">
        new
      </span>
    </span>
  );
}
