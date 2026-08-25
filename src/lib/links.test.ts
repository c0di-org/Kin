import { describe, expect, it } from "vitest";
import { extractLinks, linkHost, linkTail, withoutLinks } from "./links";

describe("extractLinks", () => {
  it("finds a link in the middle of a sentence", () => {
    expect(extractLinks("look at https://example.com/recipe it's lovely")).toEqual(["https://example.com/recipe"]);
  });

  it("takes the full stop off the end of a sentence, not off the link", () => {
    expect(extractLinks("here: https://example.com/a.")).toEqual(["https://example.com/a"]);
    expect(extractLinks("here: https://example.com/a.html")).toEqual(["https://example.com/a.html"]);
  });

  it("keeps a bracket the link opened and drops one the sentence did", () => {
    expect(extractLinks("(https://en.wikipedia.org/wiki/Cat_(disambiguation))")).toEqual(["https://en.wikipedia.org/wiki/Cat_(disambiguation)"]);
    expect(extractLinks("(see https://example.com/a)")).toEqual(["https://example.com/a"]);
  });

  it("accepts a bare www, since people type it", () => {
    expect(extractLinks("www.bbc.co.uk/news")).toEqual(["https://www.bbc.co.uk/news"]);
  });

  it("is not fooled by an ordinary sentence", () => {
    expect(extractLinks("see you at 8 p.m. tomorrow, ok?")).toEqual([]);
    expect(extractLinks("that costs £4.50 all in")).toEqual([]);
  });

  it("refuses a scheme that is not the web", () => {
    expect(extractLinks("javascript:alert(1)")).toEqual([]);
    expect(extractLinks("mailto:someone@example.com")).toEqual([]);
  });

  it("finds several, in the order they were written, without repeats", () => {
    expect(extractLinks("https://a.com and https://b.com and https://a.com again"))
      .toEqual(["https://a.com/", "https://b.com/"]);
  });
});

describe("naming a link", () => {
  it("shows the site without the www", () => {
    expect(linkHost("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
  });

  it("puts the path underneath, and nothing when there is none", () => {
    expect(linkTail("https://youtube.com/watch?v=abc")).toBe("/watch?v=abc");
    expect(linkTail("https://example.com/")).toBe("");
  });
});

describe("withoutLinks", () => {
  it("leaves what was actually said", () => {
    expect(withoutLinks("look at https://example.com/cake it's lovely")).toBe("look at it's lovely");
  });

  it("takes every link out, not only the tidy ones", () => {
    expect(withoutLinks("www.bbc.co.uk/news and https://example.com/a again")).toBe("and again");
  });

  it("has nothing to say about a message that was only a link", () => {
    expect(withoutLinks("https://example.com/a")).toBe("");
  });
});
