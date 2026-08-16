import type { ReactNode } from "react";

/**
 * A small, dependency-free, streaming-safe Markdown renderer for Tutor
 * messages (Phase 13 §12-15). Deliberately not a general-purpose Markdown
 * library — it covers exactly the constructs Tutor responses actually use
 * (paragraphs, headings, lists, bold/italic, inline code, fenced code
 * blocks, blockquotes, links/citations) and nothing else.
 *
 * Security (Phase 13 §14): this renders directly to React elements, never
 * to an HTML string — there is no `dangerouslySetInnerHTML` anywhere in
 * this file, and there structurally cannot be an HTML-injection path,
 * since React only ever treats these return values as text nodes/elements
 * it constructs itself. Model output is always untrusted input; the only
 * extra check needed is on link hrefs (see `isSafeUrl`), since an `<a
 * href>` can otherwise carry a `javascript:` URL.
 *
 * Streaming safety (Phase 13 §13): every inline construct that never finds
 * its closing delimiter (an unterminated `**bold`, `` `code ``, or
 * `[link](`) falls back to rendering as plain text instead of throwing or
 * producing a malformed tree. That fallback is just "what a non-throwing
 * parser does when a token is incomplete" — the same code path handles
 * genuinely malformed model output and mid-stream partial output, so there
 * is no separate "is this still streaming" flag to thread through. Fenced
 * code blocks are the one deliberate exception: an unterminated ``` still
 * renders as a code block using everything after the opening fence, since
 * a growing code block reads naturally mid-stream, while showing literal
 * backtick characters does not.
 */

type InlineNode =
  | { type: "text"; value: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "italic"; children: InlineNode[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: InlineNode[] };

type BlockNode =
  | { type: "heading"; level: number; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "unordered-list"; items: InlineNode[][] }
  | { type: "ordered-list"; items: InlineNode[][] }
  | { type: "blockquote"; children: InlineNode[] }
  | { type: "code-block"; value: string; language: string | null };

function isSafeUrl(href: string): boolean {
  const trimmed = href.trim();
  return /^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed);
}

/** Splits raw text into block-level chunks, keeping a fenced code block's lines together (blank lines inside a fence don't end the block) even if the closing fence hasn't arrived yet. */
function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    const isFenceLine = /^\s*```/.test(line);
    if (isFenceLine) {
      if (!inFence) {
        flush();
        current.push(line);
        inFence = true;
      } else {
        current.push(line);
        flush();
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;
  let buffer = "";

  const flushText = () => {
    if (buffer) {
      nodes.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    // Inline code: `...` — no closing backtick found yet -> plain text (streaming-safe fallback).
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flushText();
        nodes.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      buffer += text.slice(i);
      break;
    }

    // Bold: **...**
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flushText();
        nodes.push({ type: "bold", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
      buffer += text.slice(i);
      break;
    }

    // Italic: *...* or _..._ (single marker, not doubled)
    if (text[i] === "*" || text[i] === "_") {
      const marker = text[i];
      const end = text.indexOf(marker, i + 1);
      if (end !== -1 && end > i + 1) {
        flushText();
        nodes.push({ type: "italic", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
      buffer += marker;
      i += 1;
      continue;
    }

    // Link: [text](url) — only http(s)/mailto hrefs become a real link; anything else, or an
    // incomplete/unsafe construct, falls back to plain text.
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen);
          if (isSafeUrl(href)) {
            flushText();
            nodes.push({ type: "link", href: href.trim(), children: parseInline(linkText) });
            i = closeParen + 1;
            continue;
          }
        }
      }
      buffer += "[";
      i += 1;
      continue;
    }

    buffer += text[i];
    i += 1;
  }

  flushText();
  return nodes;
}

function parseBlock(blockText: string): BlockNode {
  const lines = blockText.split("\n");

  const fenceMatch = lines[0].match(/^\s*```\s*([\w-]*)\s*$/);
  if (fenceMatch) {
    const language = fenceMatch[1] || null;
    const closingIndex = lines.slice(1).findIndex((l) => /^\s*```\s*$/.test(l));
    const contentLines = closingIndex === -1 ? lines.slice(1) : lines.slice(1, 1 + closingIndex);
    return { type: "code-block", value: contentLines.join("\n"), language };
  }

  const headingMatch = lines.length === 1 ? lines[0].match(/^(#{1,6})\s+(.*)$/) : null;
  if (headingMatch) {
    return { type: "heading", level: headingMatch[1].length, children: parseInline(headingMatch[2]) };
  }

  if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
    return { type: "unordered-list", items: lines.map((l) => parseInline(l.replace(/^\s*[-*+]\s+/, ""))) };
  }

  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
    return { type: "ordered-list", items: lines.map((l) => parseInline(l.replace(/^\s*\d+[.)]\s+/, ""))) };
  }

  if (lines.every((l) => /^\s*>\s?/.test(l))) {
    return { type: "blockquote", children: parseInline(lines.map((l) => l.replace(/^\s*>\s?/, "")).join(" ")) };
  }

  return { type: "paragraph", children: parseInline(lines.join(" ")) };
}

function renderInline(nodes: InlineNode[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "bold":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "italic":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "code":
        return (
          <code key={key} className="rounded bg-zinc-200 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-700">
            {node.value}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {renderInline(node.children, key)}
          </a>
        );
    }
  });
}

function renderHeading(level: number, children: ReactNode, key: string): ReactNode {
  // Demoted so a model-written "#" heading never outsizes the chat bubble it lives in.
  if (level === 1) return <p key={key} className="text-[0.95em] font-semibold">{children}</p>;
  if (level === 2) return <p key={key} className="text-[0.9em] font-semibold">{children}</p>;
  return <p key={key} className="font-semibold">{children}</p>;
}

/** Parses `text` and returns safe React content — the only supported way to render Tutor message content in this codebase (never `dangerouslySetInnerHTML`). */
export function renderSafeMarkdown(text: string): ReactNode {
  if (text.length === 0) return null;
  const blocks = splitBlocks(text).map(parseBlock);

  return (
    <>
      {blocks.map((block, idx) => {
        const key = `block-${idx}`;
        switch (block.type) {
          case "heading":
            return renderHeading(block.level, renderInline(block.children, key), key);
          case "paragraph":
            return (
              <p key={key} className="whitespace-pre-wrap">
                {renderInline(block.children, key)}
              </p>
            );
          case "unordered-list":
            return (
              <ul key={key} className="list-disc space-y-1 pl-5">
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            );
          case "ordered-list":
            return (
              <ol key={key} className="list-decimal space-y-1 pl-5">
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ol>
            );
          case "blockquote":
            return (
              <blockquote key={key} className="border-l-2 border-zinc-300 pl-3 italic text-zinc-600 dark:border-zinc-600 dark:text-zinc-400">
                {renderInline(block.children, key)}
              </blockquote>
            );
          case "code-block":
            return (
              <pre key={key} className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs text-zinc-100 dark:bg-black">
                <code>{block.value}</code>
              </pre>
            );
        }
      })}
    </>
  );
}
