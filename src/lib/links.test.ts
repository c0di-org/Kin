import { describe, expect, it } from "vitest";
import { extractLinks, linkHost, linkKind, linkTitle, segments, shortLink, shortPath, summariseLinks, linkWarning, withoutLinks } from "./links";

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
    expect(shortPath("https://youtube.com/watch?v=abc")).toBe("/watch?v=abc");
    expect(shortPath("https://example.com/")).toBe("");
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

describe("segments", () => {
  it("cuts a sentence into its prose and its links", () => {
    expect(segments("look at https://example.com/cake it's lovely")).toEqual([
      { kind: "text", text: "look at " },
      { kind: "link", text: "https://example.com/cake", url: "https://example.com/cake" },
      { kind: "text", text: " it's lovely" }
    ]);
  });

  it("hands the sentence back its full stop", () => {
    expect(segments("here: https://example.com/a.")).toEqual([
      { kind: "text", text: "here: " },
      { kind: "link", text: "https://example.com/a", url: "https://example.com/a" },
      { kind: "text", text: "." }
    ]);
  });

  it("keeps a repeat, because the message was written that way", () => {
    const parts = segments("https://a.com/x then https://a.com/x again");
    expect(parts.filter(p => p.kind === "link")).toHaveLength(2);
  });

  it("leaves text with no links as one piece", () => {
    expect(segments("just talking")).toEqual([{ kind: "text", text: "just talking" }]);
  });

  it("gives back nothing for an empty message", () => {
    expect(segments("")).toEqual([]);
  });
});

describe("shortLink", () => {
  it("drops the scheme and the www", () => {
    expect(shortLink("https://www.bbc.co.uk/news")).toBe("bbc.co.uk/news");
  });

  it("drops a trailing slash", () => {
    expect(shortLink("https://example.com/")).toBe("example.com");
  });

  it("keeps a short, meaningful query", () => {
    expect(shortLink("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("drops the tracking a newsletter added", () => {
    expect(shortLink("https://shop.com/kettle?utm_source=news&utm_campaign=spring")).toBe("shop.com/kettle");
  });

  it("elides the middle of a long path rather than the end of it", () => {
    const short = shortLink("https://www.reddit.com/r/cooking/comments/1a2b3c4d5e/best_brownies_i_have_made/");
    expect(short).toBe("reddit.com/r/…/best_brownies_i_have_made");
  });

  it("never comes back longer than it was asked for, and says when it cut", () => {
    const long = `https://example.com/${"a".repeat(400)}`;
    expect(shortLink(long).length).toBeLessThanOrEqual(44);
    expect(shortLink(long).endsWith("…")).toBe(true);
  });

  it("reads a path somebody typed in their own alphabet", () => {
    expect(shortLink("https://de.wikipedia.org/wiki/K%C3%A4sekuchen")).toBe("de.wikipedia.org/wiki/Käsekuchen");
  });
});

describe("linkTitle", () => {
  it("reads a slug as the sentence it is", () => {
    expect(linkTitle("https://en.wikipedia.org/wiki/Chocolate_cake")).toBe("Chocolate cake");
    expect(linkTitle("https://a.com/blog/how-to-bake-bread")).toBe("How to bake bread");
  });

  it("looks past a row id to the words before it", () => {
    expect(linkTitle("https://a.com/blog/how-to-bake-bread/88213")).toBe("How to bake bread");
    expect(linkTitle("https://a.com/recipes/lemon-drizzle-cake-10394")).toBe("Lemon drizzle cake");
  });

  it("names a file after itself", () => {
    expect(linkTitle("https://a.com/files/agenda.pdf")).toBe("Agenda");
  });

  it("refuses to call a section of a site a title", () => {
    expect(linkTitle("https://www.bbc.co.uk/news/articles/c9wk1z0vwlgo")).toBeNull();
    expect(linkTitle("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(linkTitle("https://www.amazon.co.uk/dp/B08N5WRWNW")).toBeNull();
    expect(linkTitle("https://example.com")).toBeNull();
  });
});

describe("linkKind", () => {
  it("knows a video, a shop and a map when it sees one", () => {
    expect(linkKind("https://youtu.be/abc")).toBe("video");
    expect(linkKind("https://www.amazon.co.uk/dp/B08")).toBe("shop");
    expect(linkKind("https://www.google.co.uk/maps/place/Kew")).toBe("map");
  });

  it("trusts a file extension over anything else", () => {
    expect(linkKind("https://example.com/holiday.mp4")).toBe("video");
    expect(linkKind("https://example.com/terms.pdf")).toBe("doc");
  });

  it("falls back to a plain link", () => {
    expect(linkKind("https://some-blog.example/post")).toBe("link");
  });
});

describe("linkWarning", () => {
  it("catches the address that reads as one site and goes to another", () => {
    expect(linkWarning("https://www.bbc.co.uk@evil.example/x")).toMatch(/evil\.example/);
  });

  it("speaks up about a look-alike alphabet, a bare machine and a plain connection", () => {
    expect(linkWarning("https://xn--80ak6aa92e.com")).toBeTruthy();
    expect(linkWarning("http://192.168.1.5/admin")).toBeTruthy();
    expect(linkWarning("http://example.com")).toBeTruthy();
  });

  it("stays quiet about an ordinary link", () => {
    expect(linkWarning("https://www.bbc.co.uk/news")).toBeNull();
  });
});

describe("summariseLinks", () => {
  it("puts the site on a summary line instead of the whole address", () => {
    expect(summariseLinks("look at https://www.bbc.co.uk/news/articles/c9wk1z0vwlgo please"))
      .toBe("look at 🔗 bbc.co.uk please");
  });

  it("leaves a message with no links alone", () => {
    expect(summariseLinks("back in ten")).toBe("back in ten");
  });
});
