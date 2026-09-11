/**
 * NavLabel — a nav destination's label, with the "new" mark raised above it where it carries one.
 *
 * Every surface that renders a nav item renders through this, so the mark's size and colour have one
 * answer rather than three that drift. The word is part of the link's accessible name.
 *
 * Static. It used to blink in the same 1.2s step as the bar's beta chip; a mark that is missing half
 * the time is harder to read than one that is simply there, and two blinking things in one bar is a
 * bar that will not sit still.
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
      <span className="text-[9px] font-bold uppercase leading-none tracking-wider text-brand">
        new
      </span>
    </span>
  );
}
