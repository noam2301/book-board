// app/api/ai/route.ts
import OpenAI from "openai";

export const runtime = "nodejs";

/* =========================
   SAFE OPENAI CLIENT
   ========================= */
function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

/* =========================
   TYPES
   ========================= */
type Status = "read" | "reading" | "tbr" | "dnf";

type BookLite = {
  title: string;
  author: string | null;
  genre: string | null;
  status: Status;
  created_at?: string | null;
  finished_at?: string | null;
};

type RatingLite = {
  title: string;
  author: string | null;
  genre: string | null;
  rating: number;
};

type RecommendScope = "similar_to_current" | "similar_to_recent" | "unrelated";
type SummarizeScope = "short_summarize" | "long_summarize";
type Mode = "recommend_next" | "summarize" | "similar_to_reading";

type OnboardingAnswers = {
  isReader: boolean;
  seedBooks?: { title: string; author: string }[];
  mediaGenres?: string;
  maxPages?: number | null;
  seriesPref?: "any" | "standalone" | "series";
};

/* =========================
   HELPERS
   ========================= */
function normalizeTitle(s: string) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function normalizeAuthor(s: string) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function isInLibrary(title: string, author: string | null, lib: BookLite[]) {
  const t = normalizeTitle(title);
  const a = normalizeAuthor(author || "");
  return lib.some((b) => {
    if (normalizeTitle(b.title) !== t) return false;
    if (!a) return true;
    return normalizeAuthor(b.author || "") === a;
  });
}

function amazonLink(title: string, author?: string | null) {
  return `https://www.amazon.com/s?k=${encodeURIComponent(
    `${title}${author ? " " + author : ""}`
  )}`;
}

function safeNumber(n: any): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function clampWords(text: string, max: number) {
  const words = (text || "").trim().split(/\s+/);
  if (words.length <= max) return text.trim();
  return words.slice(0, max).join(" ").replace(/[,\s]+$/, "") + "…";
}

/* =========================
   GOOGLE BOOKS
   ========================= */
async function googleBooksBestMatch(title: string, author?: string | null) {
  try {
    const q = encodeURIComponent(`${title}${author ? " " + author : ""}`);
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=5`
    );
    if (!res.ok) return null;

    const data = await res.json();
    const item = data?.items?.[0];
    if (!item) return null;

    const vi = item.volumeInfo || {};
    return {
      pageCount:
        typeof vi.pageCount === "number" ? vi.pageCount : null,
      canonicalTitle: vi.title ?? title,
      canonicalAuthor:
        Array.isArray(vi.authors) && vi.authors.length
          ? vi.authors[0]
          : author ?? null,
    };
  } catch {
    return null;
  }
}

/* =========================
   ROUTE
   ========================= */
export async function POST(req: Request) {
  try {
    const client = getOpenAIClient();
    if (!client) {
      return Response.json(
        { error: "OPENAI_API_KEY not set on server" },
        { status: 500 }
      );
    }

    const body = await req.json();
    const mode: Mode = body.mode;

    /* ---------- SUMMARIZE ---------- */
    if (mode === "summarize") {
      const { title, author, summarizeScope } = body;
      if (!title || !author) {
        return Response.json(
          { error: "Missing title or author" },
          { status: 400 }
        );
      }

      const maxWords = summarizeScope === "long_summarize" ? 250 : 100;

      const prompt = `
Summarize the following book with NO spoilers.
Max ${maxWords} words.

Title: ${title}
Author: ${author}

Include:
- Summary
- Themes
- Vibe
- Who it's for
`;

      const res = await client.responses.create({
        model: "gpt-4.1-mini",
        input: prompt,
      });

      const text = clampWords(res.output_text ?? "", maxWords);
      return Response.json({ message: text });
    }

    /* ---------- RECOMMEND ---------- */
    if (mode === "recommend_next" || mode === "similar_to_reading") {
      const books: BookLite[] = body.books ?? [];
      const preferences = body.preferences ?? {};
      const maxPages = safeNumber(preferences.maxPages);

      const prompt = `
Recommend books.
Output ONLY:
1) Title — Author
2) Title — Author
(no extra text)
`;

      const res = await client.responses.create({
        model: "gpt-4.1-mini",
        input: prompt,
      });

      const lines = (res.output_text || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      const parsed = lines
        .map((l) => {
          const m = l.match(/^\d+[\)\.]\s*(.+?)(?:\s*[—-]\s*(.+))?$/);
          return m ? { title: m[1], author: m[2] ?? null } : null;
        })
        .filter(Boolean) as { title: string; author: string | null }[];

      const filtered = [];
      for (const r of parsed) {
        if (isInLibrary(r.title, r.author, books)) continue;
        const gb = await googleBooksBestMatch(r.title, r.author);
        if (!gb?.pageCount || (maxPages && gb.pageCount > maxPages)) continue;

        filtered.push({
          title: gb.canonicalTitle,
          author: gb.canonicalAuthor,
          buy: amazonLink(gb.canonicalTitle, gb.canonicalAuthor),
        });

        if (filtered.length >= 8) break;
      }

      return Response.json({
        message:
          filtered.length === 0
            ? "No books found under your page limit."
            : filtered
                .map(
                  (b, i) =>
                    `${i + 1}) ${b.title}${b.author ? ` — ${b.author}` : ""}\nBuy: ${b.buy}`
                )
                .join("\n\n"),
        results: filtered,
      });
    }

    return Response.json({ error: "Unknown mode" }, { status: 400 });
  } catch (err: any) {
    console.error("AI route error:", err);
    return Response.json(
      { error: "AI request failed", details: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
