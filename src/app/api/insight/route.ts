// app/api/insight/route.ts

import { NextResponse } from 'next/server';
import OpenAI from 'openai';


const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateMap = new Map<string, { count: number; resetAt: number }>();


export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server misconfigured: missing OpenAI credentials" },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey });
    const body = await req.json().catch(() => ({}));

    const {
      userId, // REQUIRED
      question,
      localHour: rawLocalHour,
      metrics: rawMetrics = {},
    } = body ?? {};

    const num = (x: any): number | undefined => {
      const v = typeof x === "string" ? Number(x) : x;
      return Number.isFinite(v) ? Number(v) : undefined;
    };
    const localHour = num(rawLocalHour);
    const isMorning = localHour != null && localHour >= 0 && localHour < 11;

    if (!userId || !question || typeof question !== "string" || !question.trim()) {
      return NextResponse.json(
        { error: "userId and valid question are required" },
        { status: 400 }
      );
    }

    // Rate limit by userId
    const now = Date.now();
    const key = String(userId);
    const entry = rateMap.get(key);
    if (!entry || now > entry.resetAt) {
      rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    } else {
      entry.count += 1;
      if (entry.count > RATE_MAX) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Try again in a minute." },
          { status: 429 }
        );
      }
    }

    const fmt = (n?: number, suffix = "") => (n == null ? "—" : `${n}${suffix}`);
    const steps = num(rawMetrics.steps);
    const totalCaloriesBurned = num(rawMetrics.totalCaloriesBurned);
    const dietaryCalories = num(rawMetrics.dietaryEnergyConsumed ?? rawMetrics.dietaryCalories);
    const netDeficitSoFar = (totalCaloriesBurned != null && dietaryCalories != null)
      ? Math.round(totalCaloriesBurned - dietaryCalories)
      : undefined;
    const sleepHours = num(rawMetrics.sleepHours);
    const restingHeartRate = num(rawMetrics.restingHeartRate);
    const hrvRaw = num(rawMetrics.hrvSdnn);
    const hrvSdnn = hrvRaw === 0 ? undefined : hrvRaw;
    const dietaryProteinG = num(rawMetrics.dietaryProteinG);
    const dietaryCarbsG = num(rawMetrics.dietaryCarbsG);
    const dietaryFatG = num(rawMetrics.dietaryFatG);
    const dietaryFiberG = num(rawMetrics.dietaryFiberG);
    const proteinTargetG = num(rawMetrics.proteinTargetG);
    const proteinRemainingG = num(rawMetrics.proteinRemainingG);

    // ====================== INTENT DETECTION ======================
    const qLower = question.toLowerCase();
    const isGreetingOnly = /^(hi|hey|hello|yo|sup|what\s*'s\s*up|whats\s*up)\b[!.\s]*$/i.test(question.trim());
    const isMotivationRequest = /\b(roast me|be harsh|push me|motivate|do your worst|kick my ass|be strict|hold me accountable)\b/.test(qLower);
    const isNumbersRequest = /\b(numbers?|calories|kcal|deficit|calculate|math|protein|carbs?|fat|fiber|macros?)\b/.test(qLower);

    const intent =
      isGreetingOnly ? "greeting" :
      isMotivationRequest ? "motivation" :
      isNumbersRequest ? "numbers" :
      "general";

    // Response mode contract
    const wantsSuggestions = /\b(ideas?|suggest|what should i|options?|help me|plan)\b/.test(qLower);
    const wantsRoast = intent === "motivation";
    const wantsNumbersOnly = isNumbersRequest && !wantsSuggestions && !wantsRoast;


    const includeMacroContext = /\b(protein|carbs?|fat|fiber|macros?)\b/.test(qLower) || /\b(eat|food|meal|dinner|lunch|snack|dessert|menu)\b/.test(qLower);


    // Removed days_active memory update
    const systemPrompt = `You are ClearLens. Report metrics accurately and briefly.

Rules:
- Default to one sentence.
- Do not give advice unless explicitly asked.
- Do not recommend food unless the user asks for suggestions.
- Do not add motivational wrap-ups.
- If data is unavailable, say so plainly.
- If it's morning (localHour < 11), avoid guilt/urgency language unless the user explicitly asks for a plan.
Local hour: ${fmt(localHour)}.
Today: steps=${fmt(steps)}; burned=${fmt(totalCaloriesBurned)}; eaten=${fmt(dietaryCalories)}; net=${fmt(netDeficitSoFar)}; sleep=${fmt(sleepHours)}h; rhr=${fmt(restingHeartRate)}; hrvSdnn=${fmt(hrvSdnn)}.
${includeMacroContext ? `Macros: protein=${fmt(dietaryProteinG)}g (target ${proteinTargetG != null ? fmt(proteinTargetG, "g") : "—"}, remaining ${proteinRemainingG != null ? fmt(proteinRemainingG, "g") : "—"}); carbs=${fmt(dietaryCarbsG)}g; fat=${fmt(dietaryFatG)}g; fiber=${fmt(dietaryFiberG)}g.` : ""}

Reply: one sentence. End with a complete thought.
User: "${question.trim()}"`;


    const temperature = intent === "numbers"
      ? 0.2
      : intent === "motivation"
        ? 0.6
        : 0.35;


    // Deterministic greeting: keep it short, mirror the user, no questions.
    if (intent === "greeting") {
      const t = question.trim().toLowerCase();
      const reply = (t.includes("sup") || t.includes("what's up") || t.includes("whats up")) ? "Sup." : "Hey.";
      return NextResponse.json({ insight: reply });
    }

    // Default metrics-only responses (one line, no advice)
    if (wantsNumbersOnly) {
      if (/\bsteps?\b/.test(qLower)) {
        return NextResponse.json({ insight: `${fmt(steps)} steps today.` });
      }
      if (/\b(protein)\b/.test(qLower)) {
        return NextResponse.json({ insight: `${fmt(dietaryProteinG)}g protein so far.` });
      }
      if (/\b(calories|kcal|deficit)\b/.test(qLower)) {
        return NextResponse.json({ insight: `Net ${fmt(netDeficitSoFar)} kcal.` });
      }
      if (/\b(sleep)\b/.test(qLower)) {
        return NextResponse.json({ insight: `${fmt(sleepHours)} hours of sleep.` });
      }
    }


    // Roast / motivation: one line only
    if (intent === "motivation") {
      const s = steps != null ? Math.round(steps) : undefined;
      if (s != null) {
        return NextResponse.json({ insight: `${s.toLocaleString()} steps. Your legs are in airplane mode.` });
      }
      return NextResponse.json({ insight: `Let’s be honest — effort is on standby today.` });
    }


    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature,
      max_tokens: 300, // Enforce brevity
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question.trim() },
      ],
    });

    let insight = completion.choices[0]?.message?.content?.trim() ?? "No response.";


    // ===== Minimal post-processing (keep flow, avoid rule debt) =====
    const qTrim = question.trim();

    // Treat tiny reactions as lightweight acknowledgements (no pivot)
    const isReactionMessage = /^(meh|mid|boo|nah|eh|hmm+|ok|okay|k|kk|lol|lmao|haha+|nice|fair|touch[eé]?|dang|oof|horrible|terrible|trash|garbage|weak|lame|cringe|nope|yikes|bruh)$/i.test(qTrim.replace(/^oh\s+/i, "").trim());
    if (isReactionMessage) {
      const t = qTrim.replace(/^oh\s+/i, "").trim().toLowerCase();
      const negative = /^(meh|mid|nah|boo|eh|horrible|terrible|trash|garbage|weak|lame|cringe|nope|yikes)$/i.test(t);
      insight = negative ? "Fair." : "Got you.";
      return NextResponse.json({ insight: insight });
    }

    // Don’t end with a question mark.
    // insight = insight.replace(/\?\s*$/g, "").trim();

    return NextResponse.json({ insight: insight });

  } catch (error: any) {
    console.error('Insight API error:', error);
    return NextResponse.json({ error: 'Failed to generate insight' }, { status: 500 });
  }
}