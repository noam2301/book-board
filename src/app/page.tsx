"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabaseClient";

type Status = "read" | "reading" | "tbr" | "dnf";
type AiMode = "recommend_next" | "summarize";
type RecommendScope = "similar_to_current" | "similar_to_recent" | "unrelated";
type SummarizeScope = "short_summarize" | "long_summarize";

type OnboardingFlowStep = "ask_reader" | "reader_books" | "nonreader_prefs";

type SeedBook = { title: string; author: string };

type OnboardingAnswers = {
  isReader: boolean;
  seedBooks?: SeedBook[];
  mediaGenres?: string;
  maxPages?: number | null;
  seriesPref?: "any" | "standalone" | "series";
};

type Book = {
  id: string;
  title: string;
  author: string | null;
  genre: string | null;
  status: Status;
  created_at: string;
  rating: number | null;
};

type SubscriptionRow = {
  user_id: string;
  email: string | null;

  // book caps (null => unlimited)
  max_reading: number | null;
  max_tbr: number | null;
  max_read: number | null;
  max_dnf: number | null;

  // ai monthly quota (null => unlimited)
  ai_limit_monthly: number | null;
  ai_used_monthly: number;

  // for reset tracking (ISO string)
  ai_cycle_start: string; // start of current cycle
};

const ADMIN_EMAIL = "noambyr23@gmail.com";

function formatTs(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function startOfMonthISO(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  return x.toISOString();
}

function isSameMonth(aISO: string, bISO: string) {
  const a = new Date(aISO);
  const b = new Date(bISO);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** Makes URLs clickable + blue while preserving line breaks */
function LinkifiedText({ text }: { text: string }) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = (text ?? "").split(urlRegex);

  return (
    <div style={{ whiteSpace: "pre-wrap", fontFamily: "system-ui, sans-serif" }}>
      {parts.map((part, i) => {
        if (!part.match(/^https?:\/\/[^\s]+$/)) {
          return <React.Fragment key={i}>{part}</React.Fragment>;
        }
        return (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#60a5fa", textDecoration: "underline" }}
          >
            {part}
          </a>
        );
      })}
    </div>
  );
}

type Stage =
  | "cover"
  | "opening"
  | "library"
  | "ai_opening"
  | "ai"
  | "ai_closing"
  | "closing_to_cover";

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        borderRadius: 999,
        padding: "8px 14px",
        fontSize: 14,
        fontWeight: 800,
        cursor: "pointer",

        border: active
          ? "1px solid rgba(0,0,0,0.25)"
          : "1px solid rgba(0,0,0,0.10)",

        background: active
          ? "linear-gradient(180deg, rgba(0,0,0,0.65), rgba(0,0,0,0.35))"
          : "linear-gradient(180deg, rgba(0,0,0,0.08), rgba(0,0,0,0.02))",

        color: active ? "#fff" : "#18181b",

        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",

        boxShadow: active
          ? "inset 0 1px 0 rgba(255,255,255,0.15), 0 4px 10px rgba(0,0,0,0.15)"
          : "none",

        transition: "all 0.2s ease",
      }}
    >
      {label}
    </button>
  );
}
function SubscribeButton() {
  const [open, setOpen] = useState(false);
  const [billing, setBilling] = useState("monthly"); // "monthly" | "yearly"
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(null as any);

  const plans = [
    {
      name: "Page Turner",
      monthly: "$5 / month",
      yearly: "$45 / year",
      priceId: {
        monthly: "price_page_turner_month",
        yearly: "price_page_turner_year",
      },
    },
    {
      name: "Story Seeker",
      monthly: "$15 / month",
      yearly: "$90 / year",
      priceId: {
        monthly: "price_story_seeker_month",
        yearly: "price_story_seeker_year",
      },
    },
    {
      name: "Book Worm",
      monthly: "$20 / month",
      yearly: "$100 / year",
      priceId: {
        monthly: "price_book_worm_month",
        yearly: "price_book_worm_year",
      },
    },
  ];

  function startCheckout(plan: any) {
    const priceLabel = billing === "monthly" ? plan.monthly : plan.yearly;
    const priceId = billing === "monthly" ? plan.priceId.monthly : plan.priceId.yearly;

    setSelectedPlan({ name: plan.name, priceLabel, priceId });
    setOpen(false);
    setCheckoutOpen(true);
  }

  function closeCheckout() {
    setCheckoutOpen(false);
    setSelectedPlan(null);
  }

  function fakePay(e: React.FormEvent) {
    e.preventDefault();
    alert(
      `Pretend payment submitted!\nPlan: ${selectedPlan?.name}\nBilling: ${billing}\nPriceId: ${selectedPlan?.priceId}`
    );
    closeCheckout();
  }

  return (
    <div style={{ position: "relative" }}>
      <style>{`
        @keyframes bbFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes bbPopIn {
          from { transform: translateY(18px) scale(0.98); opacity: 0; }
          to   { transform: translateY(0) scale(1); opacity: 1; }
        }
      `}</style>

      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          borderRadius: 999,
          border: "1px solid rgba(0,0,0,0.10)",
          background: "rgba(255,255,255,0.70)",
          padding: "10px 14px",
          fontSize: 14,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Subscribe
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 12px)",
            right: 0,
            width: 360,
            borderRadius: 18,
            background: "rgba(255,255,255,0.95)",
            border: "1px solid rgba(0,0,0,0.12)",
            padding: 16,
            boxShadow: "0 20px 40px rgba(0,0,0,0.25)",
            zIndex: 100,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong style={{ fontSize: 16 }}>Choose a plan</strong>
            <button
              onClick={() => setOpen(false)}
              style={{ border: "none", background: "none", cursor: "pointer" }}
            >
              ✕
            </button>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button
              onClick={() => setBilling("monthly")}
              style={{
                flex: 1,
                padding: 8,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.15)",
                background: billing === "monthly" ? "#18181b" : "#fff",
                color: billing === "monthly" ? "#fff" : "#000",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Monthly
            </button>
            <button
              onClick={() => setBilling("yearly")}
              style={{
                flex: 1,
                padding: 8,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.15)",
                background: billing === "yearly" ? "#18181b" : "#fff",
                color: billing === "yearly" ? "#fff" : "#000",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Yearly
            </button>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            {plans.map((p) => (
              <div
                key={p.name}
                style={{
                  borderRadius: 14,
                  border: "1px solid rgba(0,0,0,0.12)",
                  padding: 12,
                }}
              >
                <div style={{ fontWeight: 900 }}>{p.name}</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  {billing === "monthly" ? p.monthly : p.yearly}
                </div>
                <button
                  onClick={() => startCheckout(p)}
                  style={{
                    marginTop: 8,
                    width: "100%",
                    height: 38,
                    borderRadius: 12,
                    border: "none",
                    background: "#18181b",
                    color: "#fff",
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Subscribe
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {checkoutOpen && (
        <div
          onClick={closeCheckout}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            zIndex: 1000,
            animation: "bbFadeIn 160ms ease-out",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 520,
              borderRadius: 20,
              background: "rgba(255,255,255,0.98)",
              border: "1px solid rgba(0,0,0,0.12)",
              boxShadow: "0 30px 70px rgba(0,0,0,0.35)",
              padding: 18,
              animation: "bbPopIn 180ms ease-out",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 950 }}>Checkout</div>
                <div style={{ marginTop: 4, fontSize: 13, color: "#52525b" }}>
                  Plan: <b>{selectedPlan?.name}</b> • {selectedPlan?.priceLabel}
                </div>
              </div>

              <button
                onClick={closeCheckout}
                style={{
                  height: 34,
                  borderRadius: 10,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "#fff",
                  cursor: "pointer",
                  fontWeight: 900,
                  padding: "0 10px",
                }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={fakePay} style={{ marginTop: 14, display: "grid", gap: 10 }}>
              <input
                required
                placeholder="Name on card"
                style={{
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "#fff",
                  padding: "0 14px",
                  outline: "none",
                }}
              />

              <input
                required
                placeholder="Card number"
                inputMode="numeric"
                style={{
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.12)",
                  background: "#fff",
                  padding: "0 14px",
                  outline: "none",
                }}
              />

              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
                <input
                  required
                  placeholder="MM/YY"
                  inputMode="numeric"
                  style={{
                    height: 44,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: "#fff",
                    padding: "0 14px",
                    outline: "none",
                  }}
                />
                <input
                  required
                  placeholder="CVC"
                  inputMode="numeric"
                  style={{
                    height: 44,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.12)",
                    background: "#fff",
                    padding: "0 14px",
                    outline: "none",
                  }}
                />
              </div>

              <button
                type="submit"
                style={{
                  marginTop: 4,
                  height: 44,
                  borderRadius: 12,
                  border: "none",
                  background: "#18181b",
                  color: "#fff",
                  fontWeight: 950,
                  cursor: "pointer",
                }}
              >
                Pay & Subscribe
              </button>

              <div style={{ fontSize: 12, color: "#71717a" }}>
                * UI only (no real payments yet). We’ll connect Stripe next.
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  const [stage, setStage] = useState<Stage>("cover");

  // Auth/session
  const [sessionChecked, setSessionChecked] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const isAdmin =
    (userEmail ?? "").toLowerCase() === ADMIN_EMAIL.toLowerCase();

  // Subscription / limits
  const [subRow, setSubRow] = useState<SubscriptionRow | null>(null);
  const [subLoading, setSubLoading] = useState(false);

  // Admin panel
  const [adminTargetEmail, setAdminTargetEmail] = useState("");
  const [adminMaxReading, setAdminMaxReading] = useState<string>("");
  const [adminMaxTbr, setAdminMaxTbr] = useState<string>("");
  const [adminMaxRead, setAdminMaxRead] = useState<string>("");
  const [adminMaxDnf, setAdminMaxDnf] = useState<string>("");
  const [adminAiLimitMonthly, setAdminAiLimitMonthly] = useState<string>("");
  const [adminSaving, setAdminSaving] = useState(false);

  // Email login
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);

  // Books
  const [books, setBooks] = useState<Book[]>([]);
  const [activeTab, setActiveTab] = useState<Status>("reading");

  // ⭐ Rating UI state (only for "read")
  const [ratingOpenFor, setRatingOpenFor] = useState<string | null>(null);
  const [ratingSaving, setRatingSaving] = useState<string | null>(null);

  // Add form
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState(""); // REQUIRED
  const [genre, setGenre] = useState("");
  const [status, setStatus] = useState<Status>("tbr");

  // ✅ "Like authors" list (local-only)
  const [likedAuthors, setLikedAuthors] = useState<string[]>([]);
  const [likedAuthorDraft, setLikedAuthorDraft] = useState("");

  // ✅ One-time AI tooltip (first time using app) - PER EMAIL
  const [showAiTip, setShowAiTip] = useState(false);
// ✅ Onboarding (first time after login, per email)
const [showOnboarding, setShowOnboarding] = useState(false);
const [onboardingStep, setOnboardingStep] = useState<OnboardingFlowStep>("ask_reader");
const [onboardingIsReader, setOnboardingIsReader] = useState<boolean | null>(null);

// Reader path: 3 books
const [seedBooks, setSeedBooks] = useState<SeedBook[]>([
  { title: "", author: "" },
  { title: "", author: "" },
  { title: "", author: "" },
]);

// Not-reader path
const [mediaGenres, setMediaGenres] = useState("");
const [onboardMaxPages, setOnboardMaxPages] = useState<string>("");
const [onboardSeries, setOnboardSeries] = useState<"any" | "standalone" | "series">("any");

// Stored answers used later (sent to /api/ai)
const [onboardingAnswers, setOnboardingAnswers] = useState<OnboardingAnswers | null>(null);

  // AI
  const [aiMode, setAiMode] = useState<AiMode>("recommend_next");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{ message: string } | null>(null);
  const [sumTitle, setSumTitle] = useState("");
  const [sumAuthor, setSumAuthor] = useState("");

  // Summarize scope state
  const [summarizeScope, setSummarizeScope] =
    useState<SummarizeScope>("short_summarize");

  // Recommend preferences
  const [recommendScope, setRecommendScope] =
    useState<RecommendScope>("similar_to_current");
  const [prefMaxPages, setPrefMaxPages] = useState<string>("");
  const [prefGenre, setPrefGenre] = useState<string>("");
  const [prefSeries, setPrefSeries] = useState<"any" | "standalone" | "series">(
    "any"
  );

  const aiTipKey = useMemo(() => {
    const e = (userEmail ?? "").trim().toLowerCase();
    return e ? `bb_seen_ai_tip:${e}` : "bb_seen_ai_tip:unknown";
  }, [userEmail]);

  const filtered = useMemo(
    () => books.filter((b) => b.status === activeTab),
    [books, activeTab]
  );

  const counts = useMemo(() => {
    return {
      reading: books.filter((b) => b.status === "reading").length,
      tbr: books.filter((b) => b.status === "tbr").length,
      read: books.filter((b) => b.status === "read").length,
      dnf: books.filter((b) => b.status === "dnf").length,
    };
  }, [books]);

  // ---- Limits helpers ----
  function getCapForStatus(s: Status): number | null {
  if (isAdmin) return null; // unlimited
  if (!subRow) return null; // if not loaded yet, don't block
  if (s === "reading") return subRow.max_reading;
  if (s === "tbr") return subRow.max_tbr;
  if (s === "read") return subRow.max_read;
  return subRow.max_dnf;
}


  function canAddToStatus(s: Status, delta = 1): { ok: boolean; reason?: string } {
  if (isAdmin) return { ok: true };

  if (subLoading || !subRow) {
    return { ok: false, reason: "Loading your subscription limits… try again in a second." };
  }

  const cap = getCapForStatus(s);
  if (cap == null) return { ok: true };

  const current =
    s === "reading" ? counts.reading : s === "tbr" ? counts.tbr : s === "read" ? counts.read : counts.dnf;

  if (current + delta > cap) {
    return { ok: false, reason: `Subscription limit reached for "${s.toUpperCase()}". Max allowed: ${cap}.` };
  }
  return { ok: true };
}


  function aiQuotaInfo() {
    if (isAdmin)
      return {
        unlimited: true,
        remaining: Infinity,
        limit: null as number | null,
        used: 0,
      };
    if (!subRow) return { unlimited: false, remaining: 0, limit: 0, used: 0 };

    const limit = subRow.ai_limit_monthly;
    const used = subRow.ai_used_monthly ?? 0;

    if (limit == null) return { unlimited: true, remaining: Infinity, limit, used };
    return { unlimited: false, remaining: Math.max(0, limit - used), limit, used };
  }

  async function ensureAiCycleIsCurrent(uid: string) {
    if (isAdmin) return;
    if (!subRow) return;

    const nowStart = startOfMonthISO(new Date());
    const currentCycleStart = subRow.ai_cycle_start;

    if (currentCycleStart && isSameMonth(currentCycleStart, nowStart)) return;

    const { data, error } = await supabase
      .from("subscriptions")
     .update({ ai_used_monthly: (subRow.ai_used_monthly ?? 0) + 1 })
      .eq("user_id", uid)
      .select("*")
      .single();

    if (error) {
      console.error("reset ai cycle error:", error);
      return;
    }
    setSubRow(data as SubscriptionRow);
  }

  async function incrementAiUsed(uid: string) {
  if (isAdmin) return;

  const { data, error } = await supabase.rpc("increment_ai_used", { p_user_id: uid });
  if (error) {
    console.error("increment ai used error:", error);
    return;
  }
  setSubRow(data as SubscriptionRow);
}

  // ---- Load liked authors from localStorage ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem("liked_authors");
      if (raw) setLikedAuthors(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("liked_authors", JSON.stringify(likedAuthors));
    } catch {}
  }, [likedAuthors]);

  // ✅ show AI tip only first time (per-email), after login
  useEffect(() => {
    if (!userId) return;
    if (isAdmin) {
      setShowAiTip(false);
      return;
    }
    try {
      const seen = localStorage.getItem(aiTipKey);
      if (!seen) setShowAiTip(true);
    } catch {}
  }, [userId, aiTipKey, isAdmin]);

  function dismissAiTip() {
    try {
      localStorage.setItem(aiTipKey, "1");
    } catch {}
    setShowAiTip(false);
  }

  async function loadBooks(uid: string) {
    const { data, error } = await supabase
      .from("books")
      .select("id,title,author,genre,status,created_at,rating")
      .eq("user_id", uid)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("loadBooks error:", error);
      alert(error.message);
      return;
    }
    setBooks((data ?? []) as Book[]);
  }

  /**
   * loadSubscription:
   * 1) Try by user_id
   * 2) If not found and email exists, try by email (admin-created rows),
   *    then "claim" it by setting user_id to this uid.
   * 3) Otherwise create default by user_id.
   */
  async function loadSubscription(uid: string, email: string | null) {
    if (!uid) return;

    setSubLoading(true);
    try {
      // 1) Try read existing by user_id
      {
        const { data, error } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("user_id", uid)
          .single();

        if (!error && data) {
          setSubRow(data as SubscriptionRow);
          return;
        }
      }

      const cleanEmail = (email ?? "").trim().toLowerCase();

      // 2) Try by email (if admin created a row ahead of time)
      if (cleanEmail) {
        const byEmail = await supabase
          .from("subscriptions")
          .select("*")
          .eq("email", cleanEmail)
          .single();

        if (!byEmail.error && byEmail.data) {
          const existing = byEmail.data as SubscriptionRow;

          // If the row isn't tied to this uid yet, claim it
          if (existing.user_id !== uid) {
            const claimed = await supabase
              .from("subscriptions")
              .update({ user_id: uid })
              .eq("email", cleanEmail)
              .select("*")
              .single();

            if (!claimed.error && claimed.data) {
              setSubRow(claimed.data as SubscriptionRow);
              return;
            }
          }

          setSubRow(existing);
          return;
        }
      }

      // 3) Create default if missing
      const defaultRow: Partial<SubscriptionRow> = {
        user_id: uid,
        email: cleanEmail || null,
        max_reading: 20,
        max_tbr: 50,
        max_read: 200,
        max_dnf: 50,
        ai_limit_monthly: 20,
        ai_used_monthly: 0,
        ai_cycle_start: startOfMonthISO(new Date()),
      };

      const ins = await supabase
        .from("subscriptions")
        .insert([defaultRow])
        .select("*")
        .single();

      if (ins.error) {
        console.error("create subscription error:", ins.error);
        setSubRow(null);
        return;
      }

      setSubRow(ins.data as SubscriptionRow);
    } finally {
      setSubLoading(false);
    }
  }

  // ✅ AUTH EFFECT
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) {
          console.error("getSession error:", error);
          setSessionChecked(true);
          return;
        }

        const uid = data.session?.user?.id ?? null;
        const uemail = (data.session?.user?.email ?? null) as string | null;

        setUserId(uid);
        setUserEmail(uemail);

        if (uid) {
          await loadBooks(uid);
          await loadSubscription(uid, uemail);
        }
      } finally {
        setSessionChecked(true);
      }
    })();

    const res: any = supabase.auth.onAuthStateChange(
      async (_event: any, session: any) => {
        const uid = session?.user?.id ?? null;
        const uemail = (session?.user?.email ?? null) as string | null;

        setUserId(uid);
        setUserEmail(uemail);
        setEmailSent(false);

        if (uid) {
          loadBooks(uid);
          loadSubscription(uid, uemail);
        } else {
          setBooks([]);
          setSubRow(null);
        }
      }
    );

    const subscription =
      res?.data?.subscription ?? res?.subscription ?? res?.data ?? null;

    return () => {
      subscription?.unsubscribe?.();
    };
  }, []);

 async function signInWithEmail(e: React.FormEvent) {
  e.preventDefault();

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) return;

  // ✅ Your deployed URL (never localhost)
  const PROD_URL = "https://book-board-vert.vercel.app";

  // ✅ Prefer env var if it exists, otherwise fall back to PROD_URL (not origin)
  const envUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  const origin =
    typeof window !== "undefined" ? window.location.origin.replace(/\/+$/, "") : "";

  const redirectBase =
    process.env.NODE_ENV === "production"
      ? (envUrl || PROD_URL) // ✅ never localhost in production
      : (envUrl || origin);  // ✅ dev can use localhost

  // Extra safety
  if (process.env.NODE_ENV === "production" && redirectBase.includes("localhost")) {
    alert(
      "Production redirect is localhost. Fix NEXT_PUBLIC_SITE_URL in Vercel settings.\n" +
        "Current: " + redirectBase
    );
    return;
  }

  const emailRedirectTo = `${redirectBase}/auth/callback`;

  console.log("signInWithEmail:", {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    origin,
    redirectBase,
    emailRedirectTo,
  });

  const { error } = await supabase.auth.signInWithOtp({
    email: cleanEmail,
    options: { emailRedirectTo },
  });

  if (error) {
    console.error("signInWithOtp error:", error);
    alert(error.message);
    return;
  }

  setEmailSent(true);
}


  function openBook() {
    if (stage !== "cover") return;
    setStage("opening");
    setTimeout(() => setStage("library"), 750);
  }

  function openAIPage() {
    if (stage !== "library") return;

    // Mark tip as seen for THIS email
    try {
      localStorage.setItem(aiTipKey, "1");
    } catch {}
    setShowAiTip(false);

    setStage("ai_opening");
    setTimeout(() => setStage("ai"), 650);
  }

  function closeAIPage() {
    if (stage !== "ai") return;
    setStage("ai_closing");
    setTimeout(() => setStage("library"), 650);
  }

  async function signOut() {
    setStage("closing_to_cover");
    setTimeout(async () => {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error("signOut error:", error);
        alert(error.message);
      }
      setStage("cover");
    }, 650);
  }

  async function addBook(e: React.FormEvent) {
    e.preventDefault();
    if (!userId) return;

    // enforce section cap
    const ok = canAddToStatus(status, 1);
    if (!ok.ok) return alert(ok.reason);

    const cleanTitle = title.trim();
    const cleanAuthor = author.trim();

    if (!cleanTitle) return alert("Title is required");
    if (!cleanAuthor) return alert("Author is required");

    const { data, error } = await supabase
      .from("books")
      .insert([
        {
          user_id: userId,
          title: cleanTitle,
          author: cleanAuthor,
          genre: genre.trim() ? genre.trim() : null,
          status,
          rating: null,
        },
      ])
      .select("id,title,author,genre,status,created_at,rating")
      .single();

    if (error) {
      console.error("addBook error:", error);
      alert(error.message);
      return;
    }

    setBooks((prev) => [data as Book, ...prev]);
    setTitle("");
    setAuthor("");
    setGenre("");
    setStatus("tbr");
    setActiveTab(status);
  }

  async function updateStatus(bookId: string, newStatus: Status) {
    const current = books.find((b) => b.id === bookId);
    if (!current) return;

    // If moving across sections, enforce cap for the destination
    if (current.status !== newStatus) {
      const ok = canAddToStatus(newStatus, 1);
      if (!ok.ok) return alert(ok.reason);
    }

    const clearRating = newStatus !== "read";

    const { error } = await supabase
      .from("books")
      .update(
        clearRating ? { status: newStatus, rating: null } : { status: newStatus }
      )
      .eq("id", bookId);

    if (error) {
      console.error("updateStatus error:", error);
      alert(error.message);
      return;
    }

    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? {
              ...b,
              status: newStatus,
              rating: clearRating ? null : b.rating,
            }
          : b
      )
    );

    if (clearRating) setRatingOpenFor((cur) => (cur === bookId ? null : cur));
  }

  async function removeBook(bookId: string) {
    const { error } = await supabase.from("books").delete().eq("id", bookId);
    if (error) {
      console.error("removeBook error:", error);
      alert(error.message);
      return;
    }
    setBooks((prev) => prev.filter((b) => b.id !== bookId));
    setRatingOpenFor((cur) => (cur === bookId ? null : cur));
  }

  async function saveRating(bookId: string, rating: number | null) {
    const book = books.find((b) => b.id === bookId);
    if (!book || book.status !== "read") return;

    setRatingSaving(bookId);

    const { error } = await supabase.from("books").update({ rating }).eq("id", bookId);
    if (error) {
      console.error("saveRating error:", error);
      alert(error.message);
      setRatingSaving(null);
      return;
    }

    setBooks((prev) => prev.map((b) => (b.id === bookId ? { ...b, rating } : b)));
    setRatingSaving(null);
    setRatingOpenFor(null);
  }

  function addLikedAuthor(name: string) {
    const n = name.trim();
    if (!n) return;
    setLikedAuthors((prev) => {
      const exists = prev.some((x) => x.toLowerCase() === n.toLowerCase());
      if (exists) return prev;
      return [n, ...prev];
    });
    setLikedAuthorDraft("");
  }

  function removeLikedAuthor(name: string) {
    setLikedAuthors((prev) => prev.filter((x) => x !== name));
  }

  async function runAI(mode: AiMode) {
    if (!userId) return;

    // Make sure subscription/cycle is loaded and current
    await ensureAiCycleIsCurrent(userId);

    // check quota
    const qi = aiQuotaInfo();
    if (!qi.unlimited && qi.remaining <= 0) {
      return alert(
        `AI monthly limit reached (${qi.used}/${qi.limit}). Upgrade subscription or ask admin to increase your limit.`
      );
    }

    setAiLoading(true);
    setAiResult(null);

    try {
      const payload: any = {
        mode,
        books: books.map((b) => ({
          title: b.title,
          author: b.author,
          genre: b.genre,
          status: b.status,
        })),
        ratings: books
          .filter((b) => b.status === "read" && typeof b.rating === "number")
          .map((b) => ({
            title: b.title,
            author: b.author,
            genre: b.genre,
            rating: b.rating as number,
          })),
      };

      if (mode === "recommend_next") {
        payload.recommendScope = recommendScope;

        const maxPagesNum = Number(prefMaxPages);
        payload.preferences = {
          maxPages:
            Number.isFinite(maxPagesNum) && maxPagesNum > 0 ? maxPagesNum : null,
          genre: prefGenre.trim() ? prefGenre.trim() : null,
          series: prefSeries,
          likedAuthors,
        };

        payload.recentRead = []; // keep for API compatibility if you use it server-side
      }

      if (mode === "summarize") {
        payload.title = sumTitle.trim();
        payload.author = sumAuthor.trim();
        payload.summarizeScope = summarizeScope;
      }

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.details || data?.error || "AI failed");

      setAiResult({ message: data.message });

      // ✅ count usage AFTER a successful response
      await incrementAiUsed(userId);
    } catch (e: any) {
      alert(e?.message || "AI failed");
    } finally {
      setAiLoading(false);
    }
  }

  // ---- Admin: set subscription by email ----
  async function adminUpsertSubscriptionByEmail() {
    if (!isAdmin) return;

    const targetEmail = adminTargetEmail.trim().toLowerCase();
    if (!targetEmail) return alert("Enter a user email");

    const toNullableInt = (v: string) => {
      const t = v.trim();
      if (!t) return null;
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.floor(n);
    };

    const max_reading = toNullableInt(adminMaxReading);
    const max_tbr = toNullableInt(adminMaxTbr);
    const max_read = toNullableInt(adminMaxRead);
    const max_dnf = toNullableInt(adminMaxDnf);
    const ai_limit_monthly = toNullableInt(adminAiLimitMonthly);

    setAdminSaving(true);
    try {
      // NOTE:
      // This assumes you have a UNIQUE constraint on subscriptions.email
      // and that "user_id" can be updated/claimed later when that user logs in.
      const { error } = await supabase.from("subscriptions").upsert(
        [
          {
            email: targetEmail,
            max_reading,
            max_tbr,
            max_read,
            max_dnf,
            ai_limit_monthly,
          },
        ],
        { onConflict: "email" as any }
      );

      if (error) {
        console.error("admin upsert error:", error);
        return alert(error.message);
      }

      alert("Saved subscription limits for " + targetEmail);
    } finally {
      setAdminSaving(false);
    }
  }

  const showCover = stage === "cover" || stage === "opening";
  const showInside = stage !== "cover";
  const showLibrary =
    stage === "library" ||
    stage === "ai_opening" ||
    stage === "ai_closing" ||
    stage === "closing_to_cover";
  const showAI = stage === "ai" || stage === "ai_opening" || stage === "ai_closing";

  const quota = aiQuotaInfo();

  return (
    <div style={{ position: "relative", minHeight: "100vh", overflow: "hidden", color: "#18181b" }}>
      {/* 🔎 DEBUG: shows which origin this build is actually running on */}
    <div
      style={{
        position: "fixed",
        bottom: 10,
        right: 10,
        background: "#000",
        color: "#fff",
        padding: 8,
        borderRadius: 8,
        zIndex: 9999,
        fontSize: 12,
      }}
    >
      {typeof window !== "undefined" ? window.location.origin : "server"}
    </div>

    {/* everything else you already have */}
      {/* BOOK SCENE (non-interactive background) */}
      <div style={{ position: "fixed", inset: 0, zIndex: -1, pointerEvents: "none" }}>
        {/* Cover */}
        <div
          className={[
            "book-layer",
            showCover ? "is-visible" : "is-hidden",
            stage === "opening" ? "cover-opening" : "",
          ].join(" ")}
          style={{ position: "absolute", inset: 0 }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: "url(/book-cover.jpg)",
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          />
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.25)" }} />
        </div>

        {/* Inside */}
        <div
          className={[
            "book-layer",
            showInside ? "is-visible" : "is-hidden",
            stage === "opening" ? "inside-opening" : "",
          ].join(" ")}
          style={{ position: "absolute", inset: 0 }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: "url(/book-inside.jpg)",
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          />
          <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.55)" }} />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(to bottom, rgba(0,0,0,0.10), transparent, rgba(255,255,255,0.25))",
            }}
          />
        </div>

        {/* Page flip overlay */}
        <div
          className={[
            "page-flip",
            stage === "ai_opening" ? "flip-forward" : "",
            stage === "ai_closing" ? "flip-backward" : "",
            stage === "closing_to_cover" ? "flip-backward" : "",
          ].join(" ")}
        />
      </div>

     {/* COVER INTERACTION */}
{stage === "cover" ? (
  <div style={{ position: "fixed", inset: 0, zIndex: 20 }}>
    <button
      type="button"
      onClick={() => {
        if (!sessionChecked) return;
        openBook();
      }}
      aria-label="Open book"
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        background: "transparent",
        border: "none",
        padding: 0,
        margin: 0,
        cursor: "pointer",
        zIndex: 10,
      }}
    />

    {/* Cover content */}
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        color: "#fff",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -0.5 }}>
          Book Boards
        </div>
        <div style={{ marginTop: 8, fontSize: 14, opacity: 0.9 }}>
          Read • Reading • TBR • DNF
        </div>

        {!sessionChecked ? (
          <div
            style={{
              marginTop: 24,
              borderRadius: 16,
              background: "rgba(255,255,255,0.10)",
              padding: 16,
            }}
          >
            Loading…
          </div>
        ) : !userId ? (
          <div
            style={{
              marginTop: 24,
              width: "100%",
              maxWidth: 420,
              borderRadius: 16,
              background: "rgba(255,255,255,0.15)",
              padding: 16,
              textAlign: "left",
              backdropFilter: "blur(6px)",
              pointerEvents: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ✅ LOGIN FORM (this is what should be here) */}
            <form onSubmit={signInWithEmail} style={{ display: "grid", gap: 12 }}>
              <input
                style={{
                  height: 44,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.25)",
                  background: "rgba(255,255,255,0.10)",
                  padding: "0 14px",
                  color: "#fff",
                  outline: "none",
                }}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />

              <button
                type="submit"
                disabled={emailSent}
                style={{
                  height: 44,
                  borderRadius: 12,
                  border: "none",
                  background: "rgba(0,0,0,0.75)",
                  color: "#fff",
                  fontWeight: 600,
                  cursor: emailSent ? "not-allowed" : "pointer",
                  opacity: emailSent ? 0.6 : 1,
                }}
              >
                {emailSent ? "Link sent (check email)" : "Send me a login link"}
              </button>
            </form>

            {emailSent ? (
              <p style={{ marginTop: 12, fontSize: 14, color: "#bbf7d0" }}>
                ✅ Check your inbox for the magic link, then come back here.
              </p>
            ) : (
              <p style={{ marginTop: 12, fontSize: 12, opacity: 0.85 }}>
                Click the cover anywhere else to open.
              </p>
            )}
          </div>
        ) : (
          <p style={{ marginTop: 18, fontSize: 12, opacity: 0.85 }}>
            Click the cover to open
          </p>
        )}
      </div>
    </div>
  </div>
) : null}

{/* MAIN CONTENT */}
<div style={{ position: "relative", zIndex: 10 }}>
  {/* Library */}
  {showLibrary && userId ? (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px 48px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <button
          onClick={signOut}
          style={{
            borderRadius: 999,
            border: "1px solid rgba(0,0,0,0.10)",
            background: "rgba(255,255,255,0.70)",
            padding: "10px 14px",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Sign out
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Subscription badge */}
          <SubscribeButton />
          <div
            style={{
              borderRadius: 999,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "rgba(255,255,255,0.70)",
              padding: "10px 14px",
              fontSize: 12,
              fontWeight: 800,
              color: "#18181b",
            }}
            title="Subscription / limits"
          >
            {isAdmin
              ? "ADMIN (unlimited)"
              : subLoading
              ? "Loading limits…"
              : quota.unlimited
              ? "AI: Unlimited"
              : `AI: ${quota.used}/${quota.limit} this month`}
          </div>

          {/* AI button + first-time popup */}
          <div style={{ position: "relative", display: "inline-flex" }}>
            <button
              onClick={() => {
                if (stage !== "library") return;
                openAIPage();
              }}
              style={{
                borderRadius: 999,
                border: "1px solid rgba(0,0,0,0.10)",
                background: "rgba(255,255,255,0.70)",
                padding: "10px 14px",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              AI
            </button>

            {showAiTip && stage === "library" ? (
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  right: "calc(100% + 12px)",
                  transform: "translateY(-50%)",
                  width: 240,
                  borderRadius: 14,
                  padding: "10px 12px",
                  color: "#fff",
                  background:
                    "linear-gradient(180deg, rgba(0,0,0,0.80), rgba(0,0,0,0.45))",
                  border: "1px solid rgba(255,255,255,0.18)",
                  boxShadow: "0 12px 30px rgba(0,0,0,0.25)",
                  backdropFilter: "blur(8px)",
                  WebkitBackdropFilter: "blur(8px)",
                  zIndex: 50,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 6 }}>
                  New here?
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.35, opacity: 0.95 }}>
                  Tap <b>AI</b> to get a recommendation based on your books and
                  ratings.
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    marginTop: 10,
                  }}
                >
                  <button
                    type="button"
                    onClick={dismissAiTip}
                    style={{
                      height: 30,
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.20)",
                      background: "rgba(255,255,255,0.10)",
                      color: "#fff",
                      fontWeight: 800,
                      padding: "0 10px",
                      cursor: "pointer",
                    }}
                  >
                    Got it
                  </button>
                </div>

                <div
                  style={{
                    position: "absolute",
                    top: "50%",
                    right: -6,
                    transform: "translateY(-50%) rotate(45deg)",
                    width: 12,
                    height: 12,
                    background: "rgba(0,0,0,0.55)",
                    borderRight: "1px solid rgba(255,255,255,0.18)",
                    borderTop: "1px solid rgba(255,255,255,0.18)",
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>


            <div style={{ marginTop: 20, display: "grid", gap: 14 }}>
              {/* Admin Panel */}
              {isAdmin ? (
                <div
                  style={{
                    borderRadius: 18,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "rgba(255,255,255,0.70)",
                    padding: 16,
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>
                    Admin: Set Subscription Limits
                  </h2>
                  <div style={{ marginTop: 8, fontSize: 12, color: "#71717a" }}>
                    Admin email: {ADMIN_EMAIL} (no restrictions)
                  </div>

                  <div
                    style={{
                      marginTop: 12,
                      display: "grid",
                      gap: 10,
                      gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
                    }}
                  >
                    <input
                      value={adminTargetEmail}
                      onChange={(e) => setAdminTargetEmail(e.target.value)}
                      placeholder="User email"
                      style={{
                        gridColumn: "span 2",
                        height: 44,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "rgba(255,255,255,0.85)",
                        padding: "0 14px",
                      }}
                    />

                    <input
                      value={adminAiLimitMonthly}
                      onChange={(e) => setAdminAiLimitMonthly(e.target.value)}
                      placeholder="AI/month (blank = unlimited)"
                      inputMode="numeric"
                      style={{
                        gridColumn: "span 2",
                        height: 44,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "rgba(255,255,255,0.85)",
                        padding: "0 14px",
                      }}
                    />

                    <button
                      type="button"
                      disabled={adminSaving}
                      onClick={adminUpsertSubscriptionByEmail}
                      style={{
                        gridColumn: "span 2",
                        height: 44,
                        borderRadius: 12,
                        border: "none",
                        background: "#18181b",
                        color: "#fff",
                        fontWeight: 900,
                        cursor: "pointer",
                        opacity: adminSaving ? 0.7 : 1,
                      }}
                    >
                      {adminSaving ? "Saving…" : "Save"}
                    </button>

                    <input
                      value={adminMaxReading}
                      onChange={(e) => setAdminMaxReading(e.target.value)}
                      placeholder="Max Reading (blank = unlimited)"
                      inputMode="numeric"
                      style={{
                        gridColumn: "span 2",
                        height: 44,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "rgba(255,255,255,0.85)",
                        padding: "0 14px",
                      }}
                    />

                    <input
                      value={adminMaxTbr}
                      onChange={(e) => setAdminMaxTbr(e.target.value)}
                      placeholder="Max TBR (blank = unlimited)"
                      inputMode="numeric"
                      style={{
                        gridColumn: "span 2",
                        height: 44,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "rgba(255,255,255,0.85)",
                        padding: "0 14px",
                      }}
                    />

                    <input
                      value={adminMaxRead}
                      onChange={(e) => setAdminMaxRead(e.target.value)}
                      placeholder="Max Read (blank = unlimited)"
                      inputMode="numeric"
                      style={{
                        gridColumn: "span 1",
                        height: 44,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "rgba(255,255,255,0.85)",
                        padding: "0 14px",
                      }}
                    />

                    <input
                      value={adminMaxDnf}
                      onChange={(e) => setAdminMaxDnf(e.target.value)}
                      placeholder="Max DNF (blank = unlimited)"
                      inputMode="numeric"
                      style={{
                        gridColumn: "span 1",
                        height: 44,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "rgba(255,255,255,0.85)",
                        padding: "0 14px",
                      }}
                    />
                  </div>

                  <div style={{ marginTop: 10, fontSize: 12, color: "#52525b" }}>
                    Notes: leave blank to mean “unlimited”. (This relies on the <code>subscriptions</code>{" "}
                    table.)
                  </div>
                </div>
              ) : null}

              {/* Add book */}
              <div
                style={{
                  borderRadius: 18,
                  border: "1px solid rgba(0,0,0,0.10)",
                  background: "rgba(255,255,255,0.70)",
                  padding: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Add a book</h2>
                  <div style={{ fontSize: 12, color: "#71717a" }}>
                    {isAdmin ? "Admin: unlimited" : "Limits apply per section"}
                  </div>
                </div>

                <form
                  onSubmit={addBook}
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gap: 10,
                    gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
                  }}
                >
                  <input
                    style={{
                      gridColumn: "span 2",
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                    placeholder="Title (required)"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                  />

                  <input
                    style={{
                      gridColumn: "span 2",
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                    placeholder="Author (required)"
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    required
                  />

                  <input
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                    placeholder="Genre (optional)"
                    value={genre}
                    onChange={(e) => setGenre(e.target.value)}
                  />

                  <select
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                    value={status}
                    onChange={(e) => setStatus(e.target.value as Status)}
                  >
                    <option value="tbr">TBR</option>
                    <option value="reading">Reading</option>
                    <option value="read">Read</option>
                    <option value="dnf">DNF</option>
                  </select>

                  <button
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "none",
                      background: "#18181b",
                      color: "#fff",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Add
                  </button>
                </form>
              </div>

              {/* Authors I like */}
              <div
                style={{
                  borderRadius: 18,
                  border: "1px solid rgba(0,0,0,0.10)",
                  background: "rgba(255,255,255,0.70)",
                  padding: 16,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Authors I like</h2>
                  <div style={{ fontSize: 12, color: "#71717a" }}>Used by “Recommend my next book”</div>
                </div>

                <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <input
                    style={{
                      height: 40,
                      width: "100%",
                      maxWidth: 360,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 12px",
                    }}
                    placeholder="Add an author"
                    value={likedAuthorDraft}
                    onChange={(e) => setLikedAuthorDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addLikedAuthor(likedAuthorDraft);
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => addLikedAuthor(likedAuthorDraft)}
                    style={{
                      height: 40,
                      borderRadius: 12,
                      border: "none",
                      background: "#18181b",
                      color: "#fff",
                      fontWeight: 700,
                      padding: "0 14px",
                      cursor: "pointer",
                    }}
                  >
                    Add
                  </button>
                </div>

                {likedAuthors.length ? (
                  <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {likedAuthors.map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => removeLikedAuthor(a)}
                        title="Click to remove"
                        style={{
                          borderRadius: 999,
                          border: "1px solid rgba(0,0,0,0.10)",
                          background: "rgba(255,255,255,0.85)",
                          padding: "8px 12px",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        {a} ✕
                      </button>
                    ))}
                  </div>
                ) : (
                  <p style={{ marginTop: 10, color: "#52525b" }}>No liked authors yet.</p>
                )}
              </div>

              {/* Tabs + list */}
              <div
                style={{
                  borderRadius: 18,
                  border: "1px solid rgba(0,0,0,0.10)",
                  background: "rgba(255,255,255,0.70)",
                  padding: 16,
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <TabButton active={activeTab === "reading"} onClick={() => setActiveTab("reading")} label={`Reading (${counts.reading})`} />
                  <TabButton active={activeTab === "tbr"} onClick={() => setActiveTab("tbr")} label={`TBR (${counts.tbr})`} />
                  <TabButton active={activeTab === "read"} onClick={() => setActiveTab("read")} label={`Read (${counts.read})`} />
                  <TabButton active={activeTab === "dnf"} onClick={() => setActiveTab("dnf")} label={`DNF (${counts.dnf})`} />
                </div>

                {filtered.length === 0 ? (
                  <p style={{ marginTop: 14, color: "#52525b" }}>No books here yet.</p>
                ) : (
                  <ul style={{ marginTop: 14, display: "grid", gap: 10, padding: 0, listStyle: "none" }}>
                    {filtered.map((b) => (
                      <li
                        key={b.id}
                        style={{
                          borderRadius: 18,
                          border: "1px solid rgba(0,0,0,0.10)",
                          background: "rgba(255,255,255,0.70)",
                          padding: 16,
                        }}
                      >
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 14,
                                fontWeight: 800,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                maxWidth: 520,
                              }}
                            >
                              {b.title}
                            </div>
                            <div style={{ marginTop: 4, fontSize: 12, color: "#52525b" }}>
                              {(b.author || "Unknown author") + (b.genre ? ` • ${b.genre}` : "")}
                            </div>
                            <div style={{ marginTop: 4, fontSize: 11, color: "#71717a" }}>
                              Added: {formatTs(b.created_at)}
                            </div>

                            {b.status === "read" ? (
                              <div style={{ marginTop: 8, fontSize: 12, color: "#3f3f46" }}>
                                Rating: {b.rating ? "⭐".repeat(b.rating) : "No rating"}
                              </div>
                            ) : null}
                          </div>

                          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                            <select
                              value={b.status}
                              onChange={(e) => updateStatus(b.id, e.target.value as Status)}
                              style={{
                                height: 40,
                                borderRadius: 12,
                                border: "1px solid rgba(0,0,0,0.10)",
                                background: "rgba(255,255,255,0.85)",
                                padding: "0 12px",
                              }}
                            >
                              <option value="tbr">TBR</option>
                              <option value="reading">Reading</option>
                              <option value="read">Read</option>
                              <option value="dnf">DNF</option>
                            </select>

                            {b.status === "read" ? (
                              <button
                                type="button"
                                onClick={() => setRatingOpenFor((cur) => (cur === b.id ? null : b.id))}
                                style={{
                                  height: 40,
                                  borderRadius: 12,
                                  border: "1px solid rgba(0,0,0,0.10)",
                                  background: "rgba(255,255,255,0.85)",
                                  padding: "0 12px",
                                  fontWeight: 700,
                                  cursor: "pointer",
                                }}
                              >
                                {ratingOpenFor === b.id ? "Close rating" : "⭐ Rate"}
                              </button>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => removeBook(b.id)}
                              style={{
                                height: 40,
                                borderRadius: 12,
                                border: "1px solid rgba(0,0,0,0.10)",
                                background: "rgba(255,255,255,0.85)",
                                padding: "0 12px",
                                fontWeight: 700,
                                cursor: "pointer",
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>

                        {b.status === "read" && ratingOpenFor === b.id ? (
                          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                            {[1, 2, 3, 4, 5].map((star) => (
                              <button
                                key={star}
                                type="button"
                                disabled={ratingSaving === b.id}
                                onClick={() => saveRating(b.id, star)}
                                style={{
                                  height: 36,
                                  borderRadius: 12,
                                  border: "1px solid rgba(0,0,0,0.10)",
                                  background: "rgba(255,255,255,0.85)",
                                  padding: "0 12px",
                                  fontWeight: 800,
                                  cursor: "pointer",
                                  opacity: ratingSaving === b.id ? 0.6 : 1,
                                }}
                              >
                                {star}⭐
                              </button>
                            ))}
                            <button
                              type="button"
                              disabled={ratingSaving === b.id}
                              onClick={() => saveRating(b.id, null)}
                              title="Clear rating"
                              style={{
                                height: 36,
                                borderRadius: 12,
                                border: "1px solid rgba(0,0,0,0.10)",
                                background: "rgba(255,255,255,0.85)",
                                padding: "0 12px",
                                fontWeight: 800,
                                cursor: "pointer",
                                opacity: ratingSaving === b.id ? 0.6 : 1,
                              }}
                            >
                              Clear
                            </button>
                            {ratingSaving === b.id ? (
                              <span style={{ fontSize: 12, color: "#52525b" }}>Saving…</span>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* AI Page */}
        {showAI && userId ? (
          <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px 48px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <button
                onClick={closeAIPage}
                style={{
                  borderRadius: 999,
                  border: "1px solid rgba(0,0,0,0.10)",
                  background: "rgba(255,255,255,0.70)",
                  padding: "10px 14px",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Back
              </button>

              <div style={{ fontSize: 14, color: "#52525b" }}>
                {isAdmin
                  ? "AI Page • ADMIN unlimited"
                  : quota.unlimited
                  ? "AI Page • Unlimited"
                  : `AI Page • ${quota.used}/${quota.limit} this month`}
              </div>
            </div>

            <div
              style={{
                marginTop: 20,
                borderRadius: 18,
                border: "1px solid rgba(0,0,0,0.10)",
                background: "rgba(255,255,255,0.70)",
                padding: 16,
              }}
            >
              <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: -0.3, color: "#18181b" }}>AI</div>

              {!isAdmin && !quota.unlimited ? (
                <div style={{ marginTop: 6, fontSize: 12, color: "#52525b" }}>
                  Remaining this month: <b>{quota.remaining}</b>
                </div>
              ) : null}

              <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setAiMode("recommend_next")}
                  style={{
                    height: 40,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "rgba(255,255,255,0.85)",
                    padding: "0 12px",
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Recommend my next book
                </button>
                <button
                  type="button"
                  onClick={() => setAiMode("summarize")}
                  style={{
                    height: 40,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "rgba(255,255,255,0.85)",
                    padding: "0 12px",
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Summarize this book
                </button>
              </div>

              {aiMode === "recommend_next" ? (
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gap: 10,
                    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                  }}
                >
                  <select
                    value={recommendScope}
                    onChange={(e) => setRecommendScope(e.target.value as RecommendScope)}
                    style={{
                      gridColumn: "span 2",
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                  >
                    <option value="similar_to_current">Similar to books I am currently reading</option>
                    <option value="similar_to_recent">Similar to books I have read in the last month</option>
                    <option value="unrelated">Unrelated to past/current reads</option>
                  </select>

                  <input
                    value={prefMaxPages}
                    onChange={(e) => setPrefMaxPages(e.target.value)}
                    inputMode="numeric"
                    placeholder="How many pages? (max)"
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                  />

                  <input
                    value={prefGenre}
                    onChange={(e) => setPrefGenre(e.target.value)}
                    placeholder="Genre (optional)"
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                  />

                  <select
                    value={prefSeries}
                    onChange={(e) => setPrefSeries(e.target.value as any)}
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                  >
                    <option value="any">Standalone or series</option>
                    <option value="standalone">Standalone only</option>
                    <option value="series">Series only</option>
                  </select>
                </div>
              ) : null}

              {aiMode === "summarize" ? (
                <div
                  style={{
                    marginTop: 12,
                    display: "grid",
                    gap: 10,
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  }}
                >
                  <input
                    value={sumTitle}
                    onChange={(e) => setSumTitle(e.target.value)}
                    placeholder="Book title"
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                  />

                  <input
                    value={sumAuthor}
                    onChange={(e) => setSumAuthor(e.target.value)}
                    placeholder="Author"
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                  />

                  <select
                    value={summarizeScope}
                    onChange={(e) => setSummarizeScope(e.target.value as SummarizeScope)}
                    style={{
                      height: 44,
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.10)",
                      background: "rgba(255,255,255,0.85)",
                      padding: "0 14px",
                    }}
                  >
                    <option value="short_summarize">Short summary</option>
                    <option value="long_summarize">Long summary</option>
                  </select>
                </div>
              ) : null}

              <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => runAI(aiMode)}
                  disabled={
                    aiLoading ||
                    (aiMode === "summarize" && (!sumTitle || !sumAuthor)) ||
                    (!isAdmin && !quota.unlimited && quota.remaining <= 0)
                  }
                  style={{
                    height: 40,
                    borderRadius: 12,
                    border: "none",
                    background: "#18181b",
                    color: "#fff",
                    fontWeight: 900,
                    padding: "0 14px",
                    cursor: "pointer",
                    opacity: aiLoading ? 0.7 : 1,
                  }}
                >
                  {aiLoading ? "Thinking…" : "Run"}
                </button>

                <button
                  type="button"
                  onClick={() => setAiResult(null)}
                  style={{
                    height: 40,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "rgba(255,255,255,0.85)",
                    padding: "0 14px",
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              </div>

              <div style={{ marginTop: 12, overflowX: "auto" }}>
                <div
                  style={{
                    borderRadius: 16,
                    background: "#18181b",
                    padding: 16,
                    color: "#fff",
                    boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
                    width: "110ch",
                    maxWidth: "100%",
                  }}
                >
                  <LinkifiedText text={aiResult?.message ?? "AI output will appear here…"} />
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
