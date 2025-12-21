import { NextResponse } from "next/server";
import OpenAI from "openai";
import { LENS_PROMPTS } from "@/lib/lenses";

/**
 * POST /api/insight
 * Runtime-only OpenAI initialization (Vercel safe)
 */
export async function POST(req: Request) {
  try {
    // 🔐 Ensure API key exists at runtime (NOT build time)
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY at runtime");
      return NextResponse.json(
        { error: "Server misconfigured: missing OpenAI credentials" },
        { status: 500 }
      );
    }

    // ✅ Instantiate OpenAI INSIDE handler (critical)
    const openai = new OpenAI({ apiKey });

    const body = await req.json();
    const {
      question,
      lens = "strategic",
      birthDate,
      birthTime,
      birthPlace,
    } = body ?? {};

    if (!question || typeof question !== "string" || !question.trim()) {
      return NextResponse.json(
        { error: "Question is required" },
        { status: 400 }
      );
    }

    /* -----------------------------
       Astrology Context (Optional)
    ------------------------------ */
    let astroContext = "";

    if (birthDate && typeof birthDate === "string") {
      const date = new Date(`${birthDate.trim()}T12:00:00Z`);

      if (isNaN(date.getTime())) {
        astroContext =
          "\nAn invalid birth date was provided. Keep insights general and non-astrological.";
      } else {
        const month = date.getUTCMonth() + 1;
        const day = date.getUTCDate();

        let sunSign = "mysterious soul";
        if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) sunSign = "innovative Aquarius";
        else if ((month === 2 && day >= 19) || (month === 3 && day <= 20)) sunSign = "dreamy Pisces";
        else if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) sunSign = "bold Aries";
        else if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) sunSign = "steady Taurus";
        else if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) sunSign = "curious Gemini";
        else if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) sunSign = "nurturing Cancer";
        else if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) sunSign = "charismatic Leo";
        else if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) sunSign = "precise Virgo";
        else if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) sunSign = "harmonious Libra";
        else if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) sunSign = "intense Scorpio";
        else if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) sunSign = "adventurous Sagittarius";
        else sunSign = "ambitious Capricorn";

        astroContext = `
The user has a ${sunSign} Sun${
          birthTime || birthPlace ? " with additional birth details provided" : ""
        }.
Weave relevant ${sunSign.split(" ")[1]} traits subtly and insightfully.
Keep it affirming, grounded, non-deterministic, and tied directly to the question when useful.
        `;
      }
    } else {
      astroContext =
        "\nNo birth data was provided. Keep insights universal and avoid astrological references.";
    }

    /* -----------------------------
       Lens Prompt
    ------------------------------ */
    const lensPrompt =
      LENS_PROMPTS[lens as keyof typeof LENS_PROMPTS] ??
      LENS_PROMPTS.strategic;

    /* -----------------------------
       OpenAI Call
    ------------------------------ */
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `${lensPrompt}${astroContext}`,
        },
        {
          role: "user",
          content: question.trim(),
        },
      ],
      temperature: 0.8,
      max_tokens: 1000,
    });

    const insight =
      completion.choices?.[0]?.message?.content?.trim() ??
      "No insight generated.";

    return NextResponse.json({ insight });
  } catch (err) {
    console.error("Insight API error:", err);
    return NextResponse.json(
      { error: "Failed to generate insight" },
      { status: 500 }
    );
  }
}