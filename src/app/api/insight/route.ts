import { NextResponse } from "next/server";
import OpenAI from "openai";
import { LENS_PROMPTS } from "@/lib/lenses";

/**
 * POST /api/insight
 * Vercel-safe: instantiate OpenAI inside handler (runtime only)
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

    const openai = new OpenAI({ apiKey });

    const body = await req.json();

    const {
      question,
      lens = "strategic",
      birthDate,
      birthTime,
      birthPlace,
      metrics, // 👈 IMPORTANT: metrics from mobile
    } = body ?? {};

    if (!question || typeof question !== "string" || !question.trim()) {
      return NextResponse.json({ error: "Question is required" }, { status: 400 });
    }

    /* -----------------------------
       Metrics Context (CRITICAL)
       - Treat as real device data (HealthKit)
       - No "can't access data" disclaimers
    ------------------------------ */
    const rawSteps = metrics?.steps;
    const rawCalories = metrics?.calories;
    const rawSleepHours = metrics?.sleepHours;

    const steps = Number(rawSteps);
    const calories = Number(rawCalories);
    const sleepHours = Number(rawSleepHours);

    const hasSteps = Number.isFinite(steps);
    const hasCalories = Number.isFinite(calories);
    const hasSleep = Number.isFinite(sleepHours);

    // If your mobile app sends 0 when missing, the model should handle it gracefully.
    const metricsContext = `
HEALTH METRICS (from the user's device via Apple Health/HealthKit; treat as real, current inputs):

- Steps today: ${hasSteps ? steps : "unknown"}
- Active calories today: ${hasCalories ? calories : "unknown"}
- Sleep last night (hours): ${hasSleep ? sleepHours : "unknown"}

RULES (non-negotiable):
- Use these numbers directly in the answer.
- Do NOT claim you "can't access real-time data" or "don't have access to HealthKit". You have the data above.
- If values are unknown OR unusually low (e.g., 0), say so and give the most likely reason (no data yet, simulator, permissions, not refreshed) AND one specific next action.
- When the user asks for something not computable from these metrics (e.g., exact calorie deficit without intake/BMR), say what you CAN conclude from the metrics and what additional input is needed.
- Output format must be:

1) METRICS SNAPSHOT: (repeat the numbers)
2) DIRECT ANSWER: (answer the question plainly)
3) COACHING: (1–3 concrete actions for today)
4) IF DATA LOOKS OFF: (only if needed; one-liner + next step)

Keep it grounded, practical, and specific. Avoid generic motivational talk.
`;

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
Optional flavor: The user has a ${sunSign} Sun${birthTime || birthPlace ? " (with additional birth details)" : ""}.
Keep it light, non-deterministic, and ONLY include it if it helps the answer. No preachy astrology.
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
      LENS_PROMPTS[lens as keyof typeof LENS_PROMPTS] ?? LENS_PROMPTS.strategic;

    /* -----------------------------
       OpenAI Call
    ------------------------------ */
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `${lensPrompt}\n${metricsContext}\n${astroContext}`,
        },
        {
          role: "user",
          content: question.trim(),
        },
      ],
      temperature: 0.6, // slightly tighter = less fluffy, more grounded
      max_tokens: 900,
    });

    const insight =
      completion.choices?.[0]?.message?.content?.trim() ?? "No insight generated.";

    return NextResponse.json({ insight });
  } catch (err) {
    console.error("Insight API error:", err);
    return NextResponse.json({ error: "Failed to generate insight" }, { status: 500 });
  }
}