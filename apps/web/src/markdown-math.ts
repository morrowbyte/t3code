import type { Root } from "mdast";
import type { Plugin } from "unified";
import remarkMath from "remark-math";

export function mathSourceIsClosed(source: string, display: boolean): boolean {
  const fence = source.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
  if (fence) {
    return new RegExp(`\\n[ \\t>]*${fence[0]}{${fence.length},}[ \\t]*$`).test(source);
  }
  const delimiter = source.match(/^ {0,3}(\$+)/)?.[1];
  if (!delimiter) return false;
  return display
    ? new RegExp(`\\n[ \\t>]*\\${delimiter[0]}{${delimiter.length},}[ \\t]*$`).test(source)
    : source.length > delimiter.length * 2 && source.endsWith(delimiter);
}

// Dollar spans in prose also describe prices and shell variables. Keep those
// literal before they become HAST code nodes, without changing source offsets.
export const remarkChatMath: Plugin<[], Root> = function () {
  remarkMath.call(this);
  return (tree, file) => {
    const source = String(file);
    const visit = (parent: Root | Root["children"][number]) => {
      if (!("children" in parent)) return;
      parent.children = parent.children.flatMap((node) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (node.type === "inlineMath" && start !== undefined && end !== undefined) {
          const raw = source.slice(start, end);
          const single = raw.startsWith("$") && !raw.startsWith("$$");
          const body = raw.slice(1, -1);
          if (
            single &&
            (/^\s|\s$/.test(body) ||
              /\d/.test(source[end] ?? "") ||
              /^\$[A-Z_][A-Z\d_]*[/\\]/.test(raw))
          ) {
            return [{ type: "text" as const, value: raw, position: node.position }];
          }
        }
        if (node.type === "text" && start !== undefined && end === source.length) {
          const raw = source.slice(start, end);
          const match = /(?<![\\$])\$([^$\n]+)$/.exec(raw);
          // A price or shell variable alone is not an unfinished equation.
          if (match && /\\[a-zA-Z]+|[_^=]/.test(match[1]!) && node.position) {
            const offset = start + match.index;
            const prefix = node.value.slice(0, node.value.lastIndexOf("$"));
            const position = {
              start: {
                ...node.position.end,
                column: node.position.end.column - match[0].length,
                offset,
              },
              end: node.position.end,
            };
            return [
              ...(prefix
                ? [
                    {
                      ...node,
                      value: prefix,
                      position: { start: node.position.start, end: position.start },
                    },
                  ]
                : []),
              {
                type: "inlineMath" as const,
                value: match[1]!,
                position,
                data: {
                  hName: "code",
                  hProperties: { className: ["language-math", "math-inline"] },
                  hChildren: [{ type: "text" as const, value: match[1]! }],
                },
              },
            ];
          }
        }
        if ("children" in node) visit(node);
        return [node];
      }) as typeof parent.children;
    };
    visit(tree);
  };
};
