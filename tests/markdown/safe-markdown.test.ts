import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderSafeMarkdown } from "@/lib/markdown/safe-markdown";

/**
 * Renders through `renderToStaticMarkup` (no jsdom needed) so these tests
 * check what actually reaches the DOM as markup, not just the intermediate
 * React element tree — including that React's own text-escaping keeps any
 * literal HTML in model output inert (Phase 13 §14).
 */
function render(text: string): string {
  return renderToStaticMarkup(renderSafeMarkdown(text));
}

describe("renderSafeMarkdown (Phase 13 §12-15)", () => {
  it("renders plain text as a paragraph", () => {
    const html = render("Just a plain sentence.");
    expect(html).toContain("Just a plain sentence.");
    expect(html).toContain("<p");
  });

  it("renders bold text", () => {
    const html = render("This is **important**.");
    expect(html).toContain("<strong>important</strong>");
  });

  it("renders italic text with * and _", () => {
    expect(render("*emphasis*")).toContain("<em>emphasis</em>");
    expect(render("_emphasis_")).toContain("<em>emphasis</em>");
  });

  it("renders inline code", () => {
    const html = render("Use the `fetch` API.");
    expect(html).toContain("<code");
    expect(html).toContain(">fetch<");
  });

  it("renders unordered lists", () => {
    const html = render("- first\n- second\n- third");
    expect(html).toContain("<ul");
    expect(html.match(/<li>/g)?.length).toBe(3);
  });

  it("renders ordered lists", () => {
    const html = render("1. first\n2. second");
    expect(html).toContain("<ol");
    expect(html.match(/<li>/g)?.length).toBe(2);
  });

  it("renders fenced code blocks", () => {
    const html = render("```\nconst x = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("const x = 1;");
  });

  it("renders code blocks with a language tag without leaking it into the content", () => {
    const html = render("```js\nconst x = 1;\n```");
    expect(html).toContain("const x = 1;");
    expect(html).not.toContain("js\nconst");
  });

  it("renders blockquotes", () => {
    const html = render("> A quoted line.");
    expect(html).toContain("<blockquote");
    expect(html).toContain("A quoted line.");
  });

  it("renders headings, demoted so they never outsize the chat bubble", () => {
    const html = render("# Big Heading");
    expect(html).toContain("Big Heading");
    expect(html).not.toContain("<h1");
  });

  it("renders safe http(s) links with rel/target hardening", () => {
    const html = render("See [the docs](https://example.com/docs).");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
  });

  it("renders mailto links", () => {
    const html = render("[email us](mailto:test@example.com)");
    expect(html).toContain('href="mailto:test@example.com"');
  });

  it("does not turn a javascript: URL into a real link", () => {
    const html = render("[click me](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).toContain("[click me]");
  });

  it("does not turn a data: URL into a real link", () => {
    const html = render("[x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("<a ");
  });

  it("escapes literal HTML in the source text instead of injecting it", () => {
    const html = render("Ignore this: <img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes a literal script tag", () => {
    const html = render("<script>alert('xss')</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  describe("incomplete Markdown during streaming does not crash and falls back to plain text", () => {
    it("unterminated bold", () => {
      expect(() => render("Here is **important")).not.toThrow();
      expect(render("Here is **important")).toContain("**important");
    });

    it("unterminated inline code", () => {
      expect(() => render("Run `npm test")).not.toThrow();
      expect(render("Run `npm test")).toContain("`npm test");
    });

    it("unterminated link", () => {
      expect(() => render("See [the docs")).not.toThrow();
      expect(render("See [the docs")).toContain("[the docs");
    });

    it("an unterminated fenced code block still renders as a growing code block", () => {
      const html = render("```\nconst x = 1;\nconst y = 2;");
      expect(html).toContain("<pre");
      expect(html).toContain("const x = 1;");
      expect(html).toContain("const y = 2;");
    });

    it("progressive chunks of the same message never throw, and the final chunk renders the complete formatting", () => {
      const full = "Here is **an important concept** about `memory` — see [docs](https://example.com).";
      for (let i = 1; i <= full.length; i++) {
        expect(() => render(full.slice(0, i))).not.toThrow();
      }
      const finalHtml = render(full);
      expect(finalHtml).toContain("<strong>an important concept</strong>");
      expect(finalHtml).toContain("<code");
      expect(finalHtml).toContain('href="https://example.com"');
    });
  });

  it("final complete Markdown renders correctly with mixed constructs", () => {
    const text = ["# Heading", "", "A paragraph with **bold** and *italic* and `code`.", "", "- item one", "- item two", "", "> a quote"].join(
      "\n",
    );
    const html = render(text);
    expect(html).toContain("Heading");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code");
    expect(html).toContain("<ul");
    expect(html).toContain("<blockquote");
  });

  it("returns null for empty text", () => {
    expect(renderSafeMarkdown("")).toBeNull();
  });
});
