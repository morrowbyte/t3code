/** Only closed prose paragraphs are useful before an answer finishes streaming. */
export function voiceAnswerParagraphs(text: string) {
  const paragraphs: Array<{ offset: number; text: string }> = [];
  let start = 0;
  let fenced = false;
  for (const match of text.matchAll(/^[^\n]*\n/gm)) {
    const line = match[0];
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || line.trim()) continue;
    const end = match.index + line.length;
    const paragraph = text.slice(start, end).trim();
    if (paragraph && !/```|~~~/.test(paragraph))
      paragraphs.push({ offset: start, text: paragraph });
    start = end;
  }
  return paragraphs;
}
