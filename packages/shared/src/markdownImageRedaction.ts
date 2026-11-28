import rehypeRaw from "rehype-raw";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { parseMarkdownWithMath } from "./markdownMath.ts";

const htmlParser = unified()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .freeze();

/** Replace image embeds and remove their reference destinations from authored Markdown. */
export function omitMarkdownImages(text: string): string {
  if (!text.includes("![") && !/<(?:img|picture|source)\b/i.test(text)) return text;
  const tree = parseMarkdownWithMath(text);
  const ranges: Array<{ start: number; end: number; replacement: string }> = [];
  const imageReferences = new Set<string>();
  type Node = (typeof tree.children)[number];
  const addRange = (node: Pick<Node, "position">, replacement: string) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push({ start, end, replacement });
  };
  const definitions: Array<Extract<Node, { type: "definition" }>> = [];
  const visit = (node: Node) => {
    if (node.type === "image" || node.type === "imageReference") {
      addRange(node, "[Image omitted]");
      if (node.type === "imageReference") imageReferences.add(node.identifier);
    } else if (node.type === "definition") {
      definitions.push(node);
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  tree.children.forEach(visit);
  for (const definition of definitions) {
    if (imageReferences.has(definition.identifier)) addRange(definition, "");
  }
  if (/<(?:img|picture|source)\b/i.test(text)) {
    const visitHtml = (node: import("hast").Nodes) => {
      if (
        node.type === "element" &&
        node.tagName === "picture" &&
        node.position?.end.offset !== undefined
      ) {
        addRange(node, "[Image omitted]");
        return;
      }
      if (node.type === "element" && (node.tagName === "img" || node.tagName === "source")) {
        addRange(node, node.tagName === "img" ? "[Image omitted]" : "");
      }
      if ("children" in node) node.children.forEach(visitHtml);
    };
    visitHtml(htmlParser.runSync(tree));
  }
  let cursor = 0;
  let result = "";
  for (const { start, end, replacement } of ranges.sort(
    (a, b) => a.start - b.start || b.end - a.end,
  )) {
    if (start < cursor) continue;
    result += text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return result + text.slice(cursor);
}
