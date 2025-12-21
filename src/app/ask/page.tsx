"use client";

import { useState } from "react";
import type { Lens } from "@/lib/lenses";

const LENSES: { key: Lens; label: string }[] = [
  { key: "strategic", label: "Strategic" },
  { key: "emotional", label: "Emotional" },
  { key: "practical", label: "Practical" },
  { key: "risk", label: "Risk" },
  { key: "contrarian", label: "Contrarian" },
];

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [lens, setLens] = useState<Lens>("strategic");
  const [compareMode, setCompareMode] = useState(false);
  const [secondLens, setSecondLens] = useState<Lens | null>(null);
  const [loading, setLoading] = useState(false);
  const [insights, setInsights] = useState<{ lens: Lens; text: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  // New controlled states for birth info
  const [birthDate, setBirthDate] = useState("");
  const [birthTime, setBirthTime] = useState("");
  const [birthPlace, setBirthPlace] = useState("");

  async function handleSubmit() {
    if (!question.trim() || loading) return;
    if (compareMode && !secondLens) {
      setError("Please select a second lens to compare");
      return;
    }

    setLoading(true);
    setError(null);
    setInsights([]);

    try {
      const lensesToUse = compareMode && secondLens ? [lens, secondLens] : [lens];

      const results = await Promise.all(
        lensesToUse.map(async (currentLens) => {
          const res = await fetch("/api/insight", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
              question: question.trim(),
              lens: currentLens,
              birthDate: birthDate || null,
              birthTime: birthTime || null,
              birthPlace: birthPlace || null,
            }),
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Request failed");
          return { lens: currentLens, text: data.insight ?? "" };
        })
      );

      setInsights(results);
    } catch (e: any) {
      setError(e.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-black text-white px-6 py-12">
      <main className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold text-center mb-12">What do you want clarity on?</h1>

        {/* Primary Lens Selector */}
        <div className="flex flex-wrap justify-center gap-3 mb-8">
          {LENSES.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => setLens(l.key)}
              className={`px-6 py-3 rounded-lg font-medium transition ${
                lens === l.key ? "bg-white text-black" : "bg-gray-800 text-white hover:bg-gray-700"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>

        {/* Compare Mode Toggle */}
        <div className="text-center mb-10">
          <button
            type="button"
            onClick={() => {
              setCompareMode(!compareMode);
              if (!compareMode) setSecondLens(null);
            }}
            className="text-gray-400 hover:text-white underline text-sm"
          >
            {compareMode ? "← Back to Single Lens" : "+ Compare with Another Lens"}
          </button>
        </div>

        {/* Second Lens Selector */}
        {compareMode && (
          <div className="flex flex-wrap justify-center gap-3 mb-10">
            {LENSES.filter((l) => l.key !== lens).map((l) => (
              <button
                key={l.key}
                type="button"
                onClick={() => setSecondLens(l.key)}
                className={`px-6 py-3 rounded-lg font-medium transition ${
                  secondLens === l.key ? "bg-white text-black" : "bg-gray-800 text-white hover:bg-gray-700"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}

        {/* Question Input */}
        <textarea
          className="w-full border border-gray-700 p-5 rounded-xl bg-black text-white text-lg resize-none focus:border-white/50 focus:outline-none placeholder-gray-500"
          rows={6}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What do you want clarity on?"
        />

        {/* Birth Info Section */}
        <div className="mt-10 p-7 bg-gray-900/60 rounded-2xl border border-gray-800">
          <h3 className="text-xl font-semibold text-white mb-6">
            Want more personal insights? Add your birth date (optional)
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Birth Date - Now Fully Controlled & Auto-Formatting */}
            <input
              type="text"
              placeholder="MM / DD / YYYY"
              value={birthDate}
              onChange={(e) => {
                let value = e.target.value.replace(/\D/g, ""); // Only digits
                if (value.length > 8) value = value.slice(0, 8);

                let formatted = "";
                if (value.length > 0) formatted = value.slice(0, 2);
                if (value.length > 2) formatted += " / " + value.slice(2, 4);
                if (value.length > 4) formatted += " / " + value.slice(4);

                setBirthDate(formatted);
              }}
              className="w-full px-5 py-4 bg-black/70 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-white/60 focus:outline-none"
            />

            {/* Birth Time */}
            <input
              type="text"
              placeholder="Birth time (e.g. 14:30) — optional"
              value={birthTime}
              onChange={(e) => setBirthTime(e.target.value)}
              className="px-5 py-4 bg-black/70 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-white/60 focus:outline-none"
            />

            {/* Birth Place */}
            <input
              type="text"
              placeholder="Birth place (city, country) — optional"
              value={birthPlace}
              onChange={(e) => setBirthPlace(e.target.value)}
              className="px-5 py-4 bg-black/70 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-white/60 focus:outline-none"
            />
          </div>
        </div>

        {/* Submit Button */}
        <div className="mt-12 text-center">
          <button
            className="bg-white text-black font-semibold text-lg px-10 py-4 rounded-xl hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-lg"
            disabled={!question.trim() || loading || (compareMode && !secondLens)}
            onClick={handleSubmit}
          >
            {loading ? "Thinking..." : "Get Insight"}
          </button>
        </div>

        {/* Error */}
        {error && <p className="text-red-500 text-center mt-6">{error}</p>}

        {/* Results */}
        {insights.length > 0 && (
          <div className={`mt-16 grid gap-12 ${insights.length > 1 ? "grid-cols-1 lg:grid-cols-2" : ""}`}>
            {insights.map(({ lens: resultLens, text }) => {
              const sections = text
                .split(/\n\n(?=\*\*|Core Insight|Why This Matters|Next Actions|Emotional driver|Avoidance pattern)/i)
                .filter((s) => s.trim())
                .map((s) => s.trim());

              let accentColor = "text-white";
              if (resultLens === "strategic") accentColor = "text-cyan-400";
              if (resultLens === "emotional") accentColor = "text-pink-400";
              if (resultLens === "practical") accentColor = "text-green-400";
              if (resultLens === "risk") accentColor = "text-red-400";
              if (resultLens === "contrarian") accentColor = "text-purple-400";

              const lensLabel = LENSES.find((l) => l.key === resultLens)?.label || resultLens;

              return (
                <div key={resultLens} className="space-y-6">
                  <h2 className={`text-3xl font-bold text-center mb-8 ${accentColor}`}>
                    {lensLabel} Lens
                  </h2>
                  <div className="space-y-6">
                    {sections.map((section, idx) => {
                      const lines = section.split("\n");
                      const header = lines[0].replace(/\*\*/g, "").trim();
                      const body = lines.slice(1);

                      return (
                        <div key={idx} className="p-6 bg-gray-900/50 rounded-2xl border border-gray-800">
                          <h3 className={`text-xl font-bold mb-4 ${accentColor}`}>{header}</h3>
                          <div className="space-y-3 text-gray-200 text-lg leading-relaxed">
                            {body.map((line, i) => {
                              const cleanLine = line
                                .replace(/^\d+\.\s*\*\*|\*\*/g, "")
                                .replace(/^\*\s*/, "• ")
                                .trim();
                              if (cleanLine.startsWith("•")) {
                                return <p key={i} className="pl-4">{cleanLine}</p>;
                              }
                              return <p key={i}>{cleanLine}</p>;
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}