export const NUMBERED_LINE_CLASS =
  "relative block min-h-[1lh] pl-10 before:pointer-events-none before:absolute before:left-0 before:w-7 before:text-right before:text-muted-foreground/60 before:select-none before:content-[attr(data-line)]";

/** Gutters are CSS content, so selecting or searching source never includes line numbers. */
export function PlainCodeLines({ code }: { code: string }) {
  if (code.length > 65_536) return <>{code}</>;
  const endings = code.match(/\r?\n/gu) ?? [];
  return code.split(/\r?\n/u).map((line, index) => (
    // Positions refer to original source lines, including wrapped continuations.
    // oxlint-disable-next-line react/no-array-index-key
    <span key={index} data-line={index + 1} className={NUMBERED_LINE_CLASS}>
      {line}
      {endings[index] ?? ""}
    </span>
  ));
}
