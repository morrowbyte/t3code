export function firstDelegationParagraph(task: string): string {
  return task.trim().split(/\r?\n[\t ]*\r?\n/u, 1)[0] ?? "";
}
