// app/api/ai/route.ts
import OpenAI from "openai";

export const runtime = "nodejs";

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
  rating: number; // 1-5
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

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Helpers ----------

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

function isInLibrary(candidateTitle: string, candidateAuthor: string | null, library: BookLite[]) {
  const t = normalizeTitle(candidateTitle);
  const a = normalizeAuthor(candidateAuthor || "");
  return library.some((b) => {
    const bt = normalizeTitle(b.title);
    const ba = normalizeAuthor(b.author || "");
    if (bt !== t) return false;
    if (!a) return true;
    return ba === a;
  });
}

function amazonLink(title: string, author?: string | null) {
  const q = encodeURIComponent(`${title}${author ? " " + author : ""}`.trim());
  return `https://www.amazon.com/s?k=${q}`;
}

function parseMaybeDate(ts?: string | null) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
}

function computeRecentRead(books: BookLite[]) {
  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  return books
    .filter((b) => b.status === "read")
    .filter((b) => {
      const t = parseMaybeDate(b.finished_at) ?? parseMaybeDate(b.created_at);
      if (!t) return false;
      return now - t <= ONE_MONTH_MS;
    })
    .map((b) => ({
      title: b.title,
      author: b.author,
      genre: b.genre,
      status: b.status,
    }));
}

function safeNumber(n: any): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// --- summaries: hard word limit clamp ---
function clampWords(text: string, maxWords: number) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return (text || "").trim();
  return words.slice(0, maxWords).join(" ").replace(/[,\s]+$/, "").trim() + "…";
}

// ---------- Google Books (best match) ----------

function tokenOverlapScore(a: string, b: string) {
  const aa = normalizeTitle(a).split(" ").filter(Boolean);
  const bb = normalizeTitle(b).split(" ").filter(Boolean);
  if (aa.length === 0 || bb.length === 0) return 0;

  const setA = new Set(aa);
  const setB = new Set(bb);
  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;

  const denom = Math.max(setA.size, setB.size);
  return denom === 0 ? 0 : common / denom;
}

function scoreVolumeMatch(wantedTitle: string, wantedAuthor: string | null | undefined, volumeInfo: any) {
  const vTitle: string = volumeInfo?.title || "";
  const vAuthors: string[] = Array.isArray(volumeInfo?.authors) ? volumeInfo.authors : [];

  const titleScore = tokenOverlapScore(wantedTitle, vTitle);

  let authorScore = 0;
  if (wantedAuthor && wantedAuthor.trim() && vAuthors.length > 0) {
    const wa = normalizeAuthor(wantedAuthor);
    authorScore = Math.max(...vAuthors.map((a) => tokenOverlapScore(wa, normalizeAuthor(a))), 0);
  } else if (!wantedAuthor) {
    authorScore = 0.5;
  } else {
    authorScore = 0;
  }

  return titleScore * 0.75 + authorScore * 0.25;
}

async function googleBooksBestMatch(title: string, author?: string | null) {
  const qPlain = `${title}${author ? " " + author : ""}`.trim();
  const q = encodeURIComponent(qPlain);
  const url = `https://www.googleapis.com/books/v1/volumes?q=${q}&printType=books&maxResults=5`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) return null;

    let bestItem: any = null;
    let bestScore = -1;

    for (const item of items) {
      const vi = item?.volumeInfo || {};
      const s = scoreVolumeMatch(title, author || null, vi);
      if (s > bestScore) {
        bestScore = s;
        bestItem = item;
      }
    }

    if (!bestItem) return null;

    const volumeInfo = bestItem.volumeInfo || {};
    return {
      matchScore: bestScore,
      googleBooksId: bestItem.id ?? null,
      canonicalLink: volumeInfo.canonicalVolumeLink ?? null,
      infoLink: volumeInfo.infoLink ?? null,
      previewLink: volumeInfo.previewLink ?? null,
      pageCount: typeof volumeInfo.pageCount === "number" ? volumeInfo.pageCount : null, // ✅ trusted pages only
      canonicalTitle: typeof volumeInfo.title === "string" ? volumeInfo.title : title,
      canonicalAuthor:
        Array.isArray(volumeInfo.authors) && volumeInfo.authors.length ? String(volumeInfo.authors[0]) : author ?? null,
    };
  } catch {
    return null;
  }
}

// ---------- Extract recommendations (Title — Author only) ----------

function extractRecommendations(text: string) {
  const lines = (text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const recs: { title: string; author: string | null }[] = [];

  for (const line of lines) {
    // 1) Title — Author
    const m = line.match(/^\d+[\)\.]\s*(.+?)(?:\s*[—-]\s*(.+))?$/);
    if (!m) continue;

    let title = (m[1] || "").trim();
    let author = (m[2] || "").trim();

    // strip any extra facts if the model disobeys
    const stripExtras = (s: string) =>
      s.split("•")[0].split("(")[0].split("[")[0].split("{")[0].split("|")[0].trim();

    title = stripExtras(title);
    author = stripExtras(author);

    if (!title) continue;
    recs.push({ title, author: author || null });
  }

  return recs;
}

// ---------- JSON extraction (Responses API sometimes wraps text) ----------

function extractJsonFromText(raw: string) {
  const t = (raw || "").trim();
  // direct parse
  try {
    return JSON.parse(t);
  } catch {}
  // try to grab first {...} or [...]
  const m = t.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ---------- AI: generate reasons/themes (NO links, NO pages) ----------

async function generateBlurbs(args: {
  scope: RecommendScope;
  items: { title: string; author: string | null }[];
  ratings: RatingLite[];
  preferences: any;
  onboarding?: OnboardingAnswers | null;
  readingNow: BookLite[];
  readRecently: BookLite[];
}) {
  const { scope, items, ratings, preferences, onboarding, readingNow, readRecently } = args;

  const taskInstruction =
    scope === "unrelated"
      ? `For each book, write the GENERAL THEME of the book in 1 sentence (max 18 words).`
      : `For each book, write WHY you recommended it to this user in 1 sentence (max 18 words), referencing their taste/context.`;

  const input = `
You are helping format book recommendations for a reading app.

Rules (ABSOLUTE):
- Do NOT include page counts.
- Do NOT include any links.
- Do NOT include ratings or review counts.
- Output MUST be valid JSON only. No extra text.

${taskInstruction}

Return JSON array, each item EXACTLY:
[
  { "title": "...", "author": "...", "blurb": "..." }
]

User taste (ratings):
${JSON.stringify(ratings, null, 2)}

User preferences:
${JSON.stringify(preferences, null, 2)}

Onboarding (if present):
${JSON.stringify(onboarding ?? null, null, 2)}

Currently reading:
${JSON.stringify(readingNow, null, 2)}

Read recently:
${JSON.stringify(readRecently, null, 2)}

Books to describe:
${JSON.stringify(items, null, 2)}
`;

  const resp = await client.responses.create({
    model: "gpt-4.1-mini",
    input,
  });

  const raw = resp.output_text?.trim() || "[]";
  const parsed = extractJsonFromText(raw);

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((x) => x && typeof x.title === "string" && typeof x.blurb === "string")
    .map((x) => ({
      title: String(x.title),
      author: x.author != null ? String(x.author) : null,
      blurb: String(x.blurb),
    }));
}

// ---------- Route ----------

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return Response.json({ error: "Missing OPENAI_API_KEY in .env.local" }, { status: 500 });
    }

    const body = await req.json();

    const mode: Mode = body.mode;
    const books: BookLite[] = Array.isArray(body.books) ? body.books : [];
    const ratings: RatingLite[] = Array.isArray(body.ratings) ? body.ratings : [];
    const recommendScope: RecommendScope = body.recommendScope || "similar_to_current";
    const preferences = body.preferences || {};
    const onboarding: OnboardingAnswers | null = body.onboarding ?? null;

    // ✅ HARD RULE: never recommend above user maxPages
    // prefer explicit preferences.maxPages; fallback to onboarding.maxPages; fallback to body.maxPages
    const maxPages =
      safeNumber(preferences?.maxPages) ?? safeNumber(onboarding?.maxPages) ?? safeNumber(body?.maxPages) ?? null;

    const likedAuthorsRaw: string[] = Array.isArray(preferences.likedAuthors) ? preferences.likedAuthors : [];
    const likedAuthorsSet = new Set(likedAuthorsRaw.map((a) => normalizeAuthor(a)));

    const doNotRecommend = books; // full library: Read/Reading/TBR/DNF
    const readingNow = books.filter((b) => b.status === "reading");

    const dnfList = books.filter((b) => b.status === "dnf");
    const dnfAuthors = new Set(dnfList.filter((b) => b.author).map((b) => normalizeAuthor(b.author!)));

    let readRecently: BookLite[] = Array.isArray(body.recentRead) ? body.recentRead : [];
    if (recommendScope === "similar_to_recent" && (!readRecently || readRecently.length === 0)) {
      readRecently = computeRecentRead(books);
    }

    let prompt = "";
    let summarizeScope: SummarizeScope | null = null;

    if (mode === "recommend_next") {
      const scopeText =
        recommendScope === "similar_to_current"
          ? "Make recommendations similar to what I am CURRENTLY READING."
          : recommendScope === "similar_to_recent"
          ? "Make recommendations similar to what I have READ IN THE LAST MONTH."
          : "Make recommendations that are UNRELATED / DIFFERENT from my past and current reads.";

      prompt = `
You are a book expert.

Task: Recommend my NEXT books.

Scope:
${scopeText}

Hard rules:
- NEVER recommend any book already in my library (Read/Reading/TBR/DNF).
- Never recommend books similar to anything in my DNF list.
- Give 14–20 recommendations (some will be filtered by page limit and duplicates).
- Output MUST be in this exact format, one per line:
  1) Title — Author
  2) Title — Author
  (no extra text before or after)
- Do NOT include page counts, links, ratings, years, or any other facts.

Onboarding (if present):
${JSON.stringify(onboarding ?? null, null, 2)}

Taste signals:
${JSON.stringify(ratings, null, 2)}

Preferences:
${JSON.stringify(preferences, null, 2)}

Context:
Currently reading:
${JSON.stringify(readingNow, null, 2)}

Read recently:
${JSON.stringify(readRecently, null, 2)}

DNF list:
${JSON.stringify(dnfList, null, 2)}

My full library (DO NOT recommend anything from this):
${JSON.stringify(doNotRecommend, null, 2)}
`;
    }

    if (mode === "summarize") {
      const title = body.title;
      const author = body.author;
      summarizeScope = (body.summarizeScope as SummarizeScope) || "short_summarize";

      if (!title || !author) {
        return Response.json({ error: "Summarize requires title and author" }, { status: 400 });
      }

      const hardCapWords = summarizeScope === "long_summarize" ? 250 : 100;

      prompt = `
Summarize the following book with NO spoilers.
Be clear and friendly.

ABSOLUTE HARD RULE:
- Your entire response must be ${hardCapWords} words or fewer. Do not exceed this.

Book:
Title: ${title}
Author: ${author}

Include (within the word limit):
- Summary
- Themes
- Vibe
- Who it’s for
`;
    }

    if (mode === "similar_to_reading") {
      prompt = `
You are a book expert.

Recommend books similar ONLY to the books I am currently reading.
Avoid recommending books already listed (Read/Reading/TBR/DNF).
Output MUST be in this exact format, one per line:
  1) Title — Author
  2) Title — Author
(no extra text)

Currently reading:
${JSON.stringify(readingNow, null, 2)}

My full library (DO NOT recommend anything from this):
${JSON.stringify(doNotRecommend, null, 2)}
`;
    }

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    });

    let text = response.output_text?.trim();
    if (!text) {
      return Response.json({ error: "AI returned no text" }, { status: 500 });
    }

    // summaries: enforce word limits
    if (mode === "summarize") {
      const scope: SummarizeScope = summarizeScope || "short_summarize";
      const hardCapWords = scope === "long_summarize" ? 250 : 100;
      text = clampWords(text, hardCapWords);
      return Response.json({ message: text, meta: { summarizeScope: scope, hardCapWords } });
    }

    // recommend_next (and similar_to_reading) => parse list then enforce page limit if provided
    if (mode === "recommend_next" || mode === "similar_to_reading") {
      if (mode === "recommend_next" && maxPages == null) {
        return Response.json(
          { error: "Missing maxPages. Send preferences.maxPages (number) so we can enforce page limit." },
          { status: 400 }
        );
      }

      const parsed = extractRecommendations(text);

      // remove already-in-library + DNF author guard
      const filteredBase = parsed
        .filter((r) => !isInLibrary(r.title, r.author, doNotRecommend))
        .filter((r) => {
          if (!r.author) return true;
          const ra = normalizeAuthor(r.author);
          // If author appears in DNF authors, block unless user explicitly likes that author
          if (!dnfAuthors.has(ra)) return true;
          return likedAuthorsSet.has(ra);
        });

      // Enrich via Google Books to get verified pageCount + canonical title/author
      const enriched = await Promise.all(
        filteredBase.slice(0, 30).map(async (r) => {
          const gb = await googleBooksBestMatch(r.title, r.author);
          const title = gb?.canonicalTitle ?? r.title;
          const author = (gb?.canonicalAuthor ?? r.author) ?? null;

          return {
            title,
            author,
            pageCount: gb?.pageCount ?? null,
            googleBooksMatchScore: gb?.matchScore ?? null,
            amazon: amazonLink(title, author),
          };
        })
      );

      // ✅ HARD RULE: only keep books with KNOWN pageCount <= maxPages (for recommend_next)
      // For similar_to_reading, we still keep the same rule IF maxPages exists; otherwise no page filtering.
      const enforceMax = mode === "recommend_next" ? maxPages : maxPages; // if you ever send maxPages for similar_to_reading, it will enforce too

      const withinPages = enforceMax
        ? enriched
            .filter((r) => typeof r.pageCount === "number")
            .filter((r) => (r.pageCount as number) <= enforceMax)
            .sort((a, b) => (b.googleBooksMatchScore ?? 0) - (a.googleBooksMatchScore ?? 0))
            .slice(0, 8)
        : enriched
            .filter((r) => r.title)
            .sort((a, b) => (b.googleBooksMatchScore ?? 0) - (a.googleBooksMatchScore ?? 0))
            .slice(0, 8);

      if (mode === "recommend_next" && withinPages.length === 0) {
        return Response.json({
          message:
            "I couldn’t find recommendations under your page limit with verified page counts from Google Books. Try increasing max pages or widening your scope.",
          results: [],
          meta: { maxPages, kept: 0 },
        });
      }

      // For similar_to_reading, just return list + one amazon link per item (no blurbs)
      if (mode === "similar_to_reading") {
        const msg = withinPages
          .map((b, i) => `${i + 1}) ${b.title}${b.author ? ` — ${b.author}` : ""}\nBuy: ${b.amazon}`)
          .join("\n\n");

        return Response.json({
          message: msg || "No matches found.",
          results: withinPages.map((b) => ({ title: b.title, author: b.author, buyLink: b.amazon })),
          meta: { scope: "similar_to_current" as RecommendScope, maxPages: enforceMax ?? null },
        });
      }

      // recommend_next: Ask AI for reason/theme blurbs (NO pages, NO links)
      const blurbs = await generateBlurbs({
        scope: recommendScope,
        items: withinPages.map((b) => ({ title: b.title, author: b.author })),
        ratings,
        preferences,
        onboarding,
        readingNow,
        readRecently,
      });

      // Map blurbs by normalized key
      const blurbMap = new Map<string, string>();
      for (const b of blurbs) {
        const key = `${normalizeTitle(b.title)}::${normalizeAuthor(b.author || "")}`;
        blurbMap.set(key, b.blurb);
      }

      const label = recommendScope === "unrelated" ? "Theme" : "Why I recommended this";

      // Final message:
      // - Similar scopes: Similar to: (optional, we’ll try to infer lightly from readingNow/recentRead titles)
      // - Unrelated: Theme
      // - Always one Amazon link
      const anchors =
        recommendScope === "similar_to_current"
          ? readingNow.map((b) => b.title).filter(Boolean)
          : recommendScope === "similar_to_recent"
          ? readRecently.map((b) => b.title).filter(Boolean)
          : [];

      const friendly = withinPages
        .map((b, i) => {
          const key = `${normalizeTitle(b.title)}::${normalizeAuthor(b.author || "")}`;
          const blurb =
            blurbMap.get(key) ||
            (recommendScope === "unrelated"
              ? "A fresh direction with a clear, compelling core idea."
              : "Fits your taste based on your recent books and preferences.");

          const header = `${i + 1}) ${b.title}${b.author ? ` — ${b.author}` : ""}`;
          const similarLine =
            recommendScope === "unrelated" || anchors.length === 0 ? "" : `\nSimilar to: ${anchors[0]}`;
          return `${header}${similarLine}\n${label}: ${blurb}\nBuy: ${b.amazon}`;
        })
        .join("\n\n");

      return Response.json({
        message: friendly,
        results: withinPages.map((b) => ({
          title: b.title,
          author: b.author,
          buyLink: b.amazon, // ✅ only one link
        })),
        meta: {
          scope: recommendScope,
          maxPages,
          note: "Page limit enforced using Google Books pageCount. Output shows only a reason/theme + one Amazon link.",
        },
      });
    }

    // fallback (shouldn't hit)
    return Response.json({ message: text });
  } catch (err: any) {
    console.error("AI route error:", err);
    const message = err?.message || err?.error?.message || String(err);
    const status = message.includes("429") ? 429 : 500;
    return Response.json({ error: "AI request failed", details: message }, { status });
  }
}
