import { INLINE_PARSE_PREFIX, isSameLineOverIndentedCode } from "./markdownListIndentation.ts";
import { parseMarkdownWithMath } from "./markdownMath.ts";

/** Replace image embeds and remove their reference destinations from authored Markdown. */
export function omitMarkdownImages(text: string): string {
  if (!text.includes("![") && !/<(?:img|picture|source)\b/i.test(text)) return text;
  let cursor = 0;
  let result = "";
  for (const { start, end, replacement } of imageRanges(text)) {
    if (start < cursor) continue;
    result += text.slice(cursor, start) + replacement;
    cursor = end;
  }
  return result + text.slice(cursor);
}

function imageRanges(text: string) {
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
  const mapOffsets = (value: string, start: number, end: number) => {
    const authoredLines = text.slice(start, end).split(/(\r\n|\r|\n)/);
    const normalizedLines = value.split(/(\r\n|\r|\n)/);
    if (authoredLines.length !== normalizedLines.length) return;
    const lineOffsets: Array<{ normalized: number; authored: number }> = [];
    let authoredOffset = start;
    let normalizedOffset = 0;
    for (let i = 0; i < authoredLines.length; i += 2) {
      const authored = authoredLines[i]!;
      const normalized = normalizedLines[i]!;
      const content = normalized.replace(/^[ \t]+/, "");
      const contentStart = authored.length - content.length;
      if (!authored.endsWith(content) || !/^[> \t]*$/.test(authored.slice(0, contentStart))) return;
      lineOffsets.push({
        normalized: normalizedOffset + normalized.length - content.length,
        authored: authoredOffset + contentStart,
      });
      authoredOffset += authored.length + (authoredLines[i + 1]?.length ?? 0);
      normalizedOffset += normalized.length + (normalizedLines[i + 1]?.length ?? 0);
    }
    let lineIndex = 0;
    return (offset: number) => {
      while (
        lineIndex + 1 < lineOffsets.length &&
        lineOffsets[lineIndex + 1]!.normalized <= offset
      ) {
        lineIndex++;
      }
      const line = lineOffsets[lineIndex]!;
      return line.authored + offset - line.normalized;
    };
  };
  const visit = (node: Node, parent?: Node) => {
    if (node.type === "image" || node.type === "imageReference") {
      addRange(node, "[Image omitted]");
      if (node.type === "imageReference") imageReferences.add(node.identifier);
    } else if (node.type === "definition") {
      definitions.push(node);
    } else if (
      node.type === "code" &&
      isSameLineOverIndentedCode(node, parent, text) &&
      parent?.type === "listItem" &&
      parent.children[0] === node
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const toAuthored = mapOffsets(node.value, start, end);
      if (!toAuthored) return;
      const trimmed = node.value.trim();
      const offset = node.value.length - node.value.trimStart().length - INLINE_PARSE_PREFIX.length;
      let lastOffset = -1;
      for (const range of imageRanges(INLINE_PARSE_PREFIX + trimmed)) {
        if (range.start < INLINE_PARSE_PREFIX.length || range.start < lastOffset) continue;
        ranges.push({
          ...range,
          start: toAuthored(range.start + offset),
          end: toAuthored(range.end + offset),
        });
        lastOffset = range.end;
      }
    } else if (node.type === "html") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const toAuthored = mapOffsets(node.value, start, end);
      if (!toAuthored) return;
      for (const tag of node.value.matchAll(tagPattern)) {
        if (tag[2] === undefined) continue;
        htmlTags.push({
          name: tag[2].toLowerCase(),
          closing: tag[1] === "/",
          start: toAuthored(tag.index),
          end: toAuthored(tag.index + tag[0].length),
        });
      }
    } else if ("children" in node) {
      node.children.forEach((child) => visit(child, node));
    }
  };
  tree.children.forEach((child) => visit(child));
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
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}
