import { NextResponse } from "next/server";
import OpenAI from "openai";
import { LENS_PROMPTS } from "@/lib/lenses";

const VERSION = "metrics-v3";

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

    const metricsFirstLine = `METRICS: steps=${steps ?? "—"}, active_kcal=${activeCalories ?? "—"}, basal_kcal=${basalCalories ?? "—"}, total_kcal=${totalCaloriesBurned ?? "—"}, sleep_h=${sleepHours ?? "—"}, rhr_bpm=${restingHeartRate ?? "—"}, hrv_ms=${hrvSdnn ?? "—"}`;

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

Hard requirements:
- The VERY FIRST LINE of your response must be EXACTLY:
  ${metricsFirstLine}
- Do NOT claim you "can't access real-time data" or that you lack HealthKit access.
- If a needed value is missing (shown as —), say what is missing and how to get it (Refresh, permissions, add data, test on device).

Answer format (use these headings):
DIRECT ANSWER:
- (Answer the user's question in 1–3 sentences using the numbers.)

INTERPRETATION:
- (What the numbers suggest today. If values are 0/—, explain likely reasons.)
- You MUST reference at least TWO metrics (e.g., steps + sleep, or sleep + HRV/RHR) in interpretation and in the actions.

ACTIONS:
- (1–3 concrete actions for today.)

NOTES:
- (Only if needed: missing data, safety caveat.)

Not medical advice; if symptoms are concerning, suggest a clinician.
`;

    const system = `${lensPrompt}\n${astroContext}\n${metricsContext}\n${groundingRules}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question.trim() },
      ],
      temperature: 0.2,
      max_tokens: 650,
    });

    const modelText =
      completion.choices?.[0]?.message?.content?.trim() ?? "No insight generated.";

    // Hard-enforce first line metrics echo even if the model doesn't comply
    const alreadyHasFirstLine = modelText.startsWith("METRICS:") || modelText.startsWith(metricsFirstLine);
    const insight = alreadyHasFirstLine ? modelText : `${metricsFirstLine}\n\n${modelText}`;

    // Optional: include the metrics we saw (helps debugging)
    return NextResponse.json({
      version: VERSION,
      metricsFirstLine,
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