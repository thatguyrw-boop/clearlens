import { NextResponse } from "next/server";
import OpenAI from "openai";
import { LENS_PROMPTS } from "@/lib/lenses";

function num(x: any): number | undefined {
  const v = typeof x === "string" ? Number(x) : x;
  return Number.isFinite(v) ? Number(v) : undefined;
}

function fmt(n?: number, suffix = "") {
  return n == null ? "—" : `${n}${suffix}`;
}

/**
 * POST /api/insight
 * Runtime-only OpenAI initialization (Vercel safe)
 */
export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY at runtime");
      return NextResponse.json(
        { error: "Server misconfigured: missing OpenAI credentials" },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey });

    const body = await req.json().catch(() => ({}));
    const {
      question,
      lens = "strategic",
      birthDate,
      birthTime,
      birthPlace,
      metrics: rawMetrics = {},
    } = body ?? {};

    if (!question || typeof question !== "string" || !question.trim()) {
      return NextResponse.json({ error: "Question is required" }, { status: 400 });
    }

    // Accept both legacy + new metric names
    const steps = num(rawMetrics.steps);
    const activeCalories = num(rawMetrics.activeCalories ?? rawMetrics.calories);
    const basalCalories = num(rawMetrics.basalCalories);
    const totalCaloriesBurned = num(rawMetrics.totalCaloriesBurned);
    const sleepHours = num(rawMetrics.sleepHours);
    const restingHeartRate = num(rawMetrics.restingHeartRate);
    const hrvSdnn = num(rawMetrics.hrvSdnn);

    const metricsLines: string[] = [];
    if (steps != null) metricsLines.push(`- Steps today: ${steps}`);
    if (activeCalories != null) metricsLines.push(`- Active calories burned: ${activeCalories} kcal`);
    if (basalCalories != null) metricsLines.push(`- Basal calories burned: ${basalCalories} kcal`);
    if (totalCaloriesBurned != null) metricsLines.push(`- Total calories burned: ${totalCaloriesBurned} kcal`);
    if (sleepHours != null) metricsLines.push(`- Sleep: ${sleepHours} hours`);
    if (restingHeartRate != null) metricsLines.push(`- Resting heart rate: ${restingHeartRate} bpm`);
    if (hrvSdnn != null) metricsLines.push(`- HRV (SDNN): ${hrvSdnn} ms`);

    const metricsContext =
      metricsLines.length > 0
        ? `\n\nTODAY'S APPLE HEALTH METRICS (ground truth — use these exact numbers):\n${metricsLines.join(
            "\n"
          )}\n`
        : `\n\nNo Apple Health metrics were provided. If the user asks for a number you don't have, say what is missing and suggest how to collect it.\n`;

    /* -----------------------------
       Astrology Context (Optional)
    ------------------------------ */
    let astroContext = "";
    if (birthDate && typeof birthDate === "string") {
      const date = new Date(`${birthDate.trim()}T12:00:00Z`);
      if (isNaN(date.getTime())) {
        astroContext =
          "\nInvalid birth date provided. Keep insights general and non-astrological.";
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

        astroContext = `\nUser has a ${sunSign} Sun${
          birthTime || birthPlace ? " (extra birth details provided)" : ""
        }. Keep it light, non-deterministic, and only use if it helps the question.`;
      }
    } else {
      astroContext = "\nNo birth info provided. Avoid astrology references.";
    }

    /* -----------------------------
       Lens Prompt + Grounding Rules
    ------------------------------ */
    const lensPrompt =
      LENS_PROMPTS[lens as keyof typeof LENS_PROMPTS] ?? LENS_PROMPTS.strategic;

    const groundingRules = `
You are ClearLens. You MUST use the provided Apple Health metrics when answering.

Rules:
- If the user asks for a metric (steps, calories, sleep, RHR, HRV), answer with the exact value you have in the FIRST line.
- If a value is missing, say it's missing and tell the user exactly what to connect/log to get it.
- Keep it practical. Avoid generic “I can’t access data” if metrics are present.
- Format the rest as:
  1) ONE tradeoff that matters (1 sentence)
  2) ONE decision rule (1 sentence)
- Not medical advice; if symptoms are concerning, suggest a clinician.
`;

    const system = `${lensPrompt}\n${astroContext}\n${metricsContext}\n${groundingRules}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question.trim() },
      ],
      temperature: 0.4,
      max_tokens: 700,
    });

    const insight =
      completion.choices?.[0]?.message?.content?.trim() ?? "No insight generated.";

    // Optional: include the metrics we saw (helps debugging)
    return NextResponse.json({
      insight,
      debugMetrics: {
        steps: fmt(steps),
        activeCalories: fmt(activeCalories, " kcal"),
        basalCalories: fmt(basalCalories, " kcal"),
        totalCaloriesBurned: fmt(totalCaloriesBurned, " kcal"),
        sleepHours: fmt(sleepHours, " h"),
        restingHeartRate: fmt(restingHeartRate, " bpm"),
        hrvSdnn: fmt(hrvSdnn, " ms"),
      },
    });
  } catch (err) {
    console.error("Insight API error:", err);
    return NextResponse.json({ error: "Failed to generate insight" }, { status: 500 });
  }
}