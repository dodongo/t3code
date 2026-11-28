import { parseMarkdownWithMath } from "./markdownMath.ts";

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
  const htmlTags: Array<{ name: string; closing: boolean; start: number; end: number }> = [];
  const tagPattern =
    /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][\w:-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'"<>])*>/gi;
  const definitions: Array<Extract<Node, { type: "definition" }>> = [];
  const visit = (node: Node) => {
    if (node.type === "image" || node.type === "imageReference") {
      addRange(node, "[Image omitted]");
      if (node.type === "imageReference") imageReferences.add(node.identifier);
    } else if (node.type === "definition") {
      definitions.push(node);
    } else if (node.type === "html" && node.position?.start.offset !== undefined) {
      const start = node.position.start.offset;
      const authored = text.slice(start, node.position.end.offset);
      for (const tag of authored.matchAll(tagPattern)) {
        if (tag[2] === undefined) continue;
        htmlTags.push({
          name: tag[2].toLowerCase(),
          closing: tag[1] === "/",
          start: start + tag.index,
          end: start + tag.index + tag[0].length,
        });
      }
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  tree.children.forEach(visit);
  for (const definition of definitions) {
    if (imageReferences.has(definition.identifier)) addRange(definition, "");
  }
  const pictures: Array<(typeof htmlTags)[number]> = [];
  const rawTextTags = new Set(["script", "style", "textarea", "title"]);
  let videoDepth = 0;
  let rawTextTag: string | undefined;
  for (const tag of htmlTags) {
    const { name, closing, start, end } = tag;
    if (rawTextTag !== undefined) {
      if (closing && name === rawTextTag) rawTextTag = undefined;
    } else if (!closing && rawTextTags.has(name)) {
      rawTextTag = name;
    } else if (name === "video" || name === "audio") {
      videoDepth = Math.max(0, videoDepth + (closing ? -1 : 1));
    } else if (name === "picture") {
      if (closing) {
        const opening = pictures.pop();
        if (opening !== undefined)
          ranges.push({ start: opening.start, end, replacement: "[Image omitted]" });
      } else {
        pictures.push(tag);
        ranges.push({ start, end, replacement: "[Image omitted]" });
      }
    } else if (
      !closing &&
      (name === "img" || (name === "source" && pictures.length > 0 && videoDepth === 0))
    ) {
      ranges.push({
        start,
        end,
        replacement: name === "img" && pictures.length === 0 ? "[Image omitted]" : "",
      });
    }
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
