// app/api/insight/route.ts

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const DEBUG_AI =
  process.env.CLEARLENS_DEBUG_AI === "true" &&
  process.env.NODE_ENV !== "production" &&
  process.env.VERCEL_ENV !== "production";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateMap = new Map<string, { count: number; resetAt: number }>();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

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
      metrics: rawMetrics = {},
      profile: rawProfile = {},
      preferences: rawPreferences = {},
      trends: rawTrends = {},
    } = body ?? {};


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

    const num = (x: any): number | undefined => {
      const v = typeof x === "string" ? Number(x) : x;
      return Number.isFinite(v) ? Number(v) : undefined;
    };
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

    // Profile
    const age = num(rawProfile.age);
    const biologicalSex = typeof rawProfile.biologicalSex === "string" ? rawProfile.biologicalSex : undefined;
    const heightCm = num((rawProfile as any).heightCm);
    const weightKg = num((rawProfile as any).weightKg);

    const heightUs = (() => {
      if (heightCm == null) return undefined;
      const totalIn = heightCm / 2.54;
      const ft = Math.floor(totalIn / 12);
      const inch = Math.round(totalIn - ft * 12);
      return `${ft}′ ${inch}″`;
    })();

    const weightLbs = (weightKg == null) ? undefined : Math.round(weightKg * 2.2046226218);

    // Preferences
    const tonePreference: "neutral" | "warm" | "sharp" =
      rawPreferences?.tone === "warm" || rawPreferences?.tone === "sharp"
        ? rawPreferences.tone
        : "neutral";
    // ====================== INTENT DETECTION ======================
    const qLower = question.toLowerCase();
    const isGreetingOnly = /^(hi|hey|hello|yo|sup|what\s*'s\s*up|whats\s*up)\b[!.\s]*$/i.test(question.trim());
    const isMotivationRequest = /\b(roast me|be harsh|push me|motivate|do your worst|kick my ass|be strict|hold me accountable)\b/.test(qLower);
    const isFoodQuestion = /\b(what should i eat|dinner|lunch|snack|chicken|steak|shrimp|tacos|pizza|dessert|menu|burrito|lasagna|pasta)\b/.test(qLower);
    const wantsQuickLog = /\b(just log it|just need to log|just log|log it|log this|add it|already logged|all logged)\b/.test(qLower);
    const baseNumbersRe = /\b(numbers?|calories|kcal|deficit|calculate|calculated|how did you|show your work|math)\b/;
    const macroWordsRe = /\b(protein|carbs?|fat|fiber|macros?)\b/;
    const numberCueRe = /\b(\d+|grams?|\bg\b|kcal|calories|how many|how much|what are|numbers?)\b/;
    const isNumbersRequest = baseNumbersRe.test(qLower) || (macroWordsRe.test(qLower) && numberCueRe.test(qLower));

    const intent =
      isGreetingOnly ? "greeting" :
      (isNumbersRequest && isMotivationRequest) ? "motivation" :
      isNumbersRequest ? "numbers" :
      isFoodQuestion ? "food" :
      isMotivationRequest ? "motivation" :
      "general";


    const supabase = getSupabase();

    let memories: Record<string, any> = {};
    if (supabase) {
      const { data: memoryData, error: memoryError } = await supabase
        .from('user_memories')
        .select('key,value')
        .eq('user_id', userId);

      if (memoryError) console.error('Supabase memory fetch error:', memoryError);

      memories = memoryData?.reduce((acc, row) => {
        acc[row.key] = row.value;
        return acc;
      }, {} as Record<string, any>) || {};
    }

    const daysActive = Number(memories.days_active ?? 0);
    const favoriteSnack = (memories.favorite_snack as string) || null;
    const goal = (memories.goal as string) || null;



    const includeMacroContext =
      macroWordsRe.test(qLower) ||
      intent === "food" ||
      wantsQuickLog;

    const isProfileQuery = /\b(do you know|what\s*'s|what is|tell me)\b.*\b(height|weight|age)\b/.test(qLower);
    const isRecoveryQuery = /\b(recovery|readiness|sleep|hrv|sdnn|resting\s*hr|rhr|resting heart|push today|go lighter|take it easy|train today|workout today|lift today|hit it hard)\b/.test(qLower);

    (async () => {
      if (!supabase) return;
      try {
        const updates: Record<string, any> = {
          days_active: daysActive + 1,
        };
        const rows = Object.entries(updates).map(([key, value]) => ({ user_id: userId, key, value }));
        if (rows.length) {
          await supabase.from("user_memories").upsert(rows, { onConflict: "user_id,key" });
        }
      } catch (e) {
        console.error("Memory update failed:", e);
      }
    })();
    const systemPrompt = `You are ClearLens, a calm witty wellness friend inside this app.

Hard rules: You DO have access to the provided HealthKit metrics. Don’t say you can’t access data. Be direct and practical (not therapy). Do NOT infer emotional state from sarcasm, short replies, or feedback (“meh”, “horrible”, “weak”)—treat those as simple feedback. No pep talks (“you’ve got this”, “I’m here to listen”, “deep breaths”). If the user didn’t ask a question, don’t ask one. No lists unless the user asks.

Context: goal=${goal || "not set"}; favoriteSnack=${favoriteSnack || "none"}; no gallbladder → moderate fat per meal.

Today: steps=${fmt(steps)}; burned=${fmt(totalCaloriesBurned)}; eaten=${fmt(dietaryCalories)}; net=${fmt(netDeficitSoFar)}; sleep=${fmt(sleepHours)}h; rhr=${fmt(restingHeartRate)}; hrvSdnn=${fmt(hrvSdnn)}.
${includeMacroContext ? `Macros: protein=${fmt(dietaryProteinG)}g (target ${proteinTargetG != null ? fmt(proteinTargetG, "g") : "—"}, remaining ${proteinRemainingG != null ? fmt(proteinRemainingG, "g") : "—"}); carbs=${fmt(dietaryCarbsG)}g; fat=${fmt(dietaryFatG)}g; fiber=${fmt(dietaryFiberG)}g.` : ""}

Reply: 1–2 short paragraphs. End with a complete thought.
User: "${question.trim()}"`;

    const debugFooter = DEBUG_AI
      ? `\n\n—\nDEBUG`
        + `\nintent: ${intent}`
        + `\nmacroCtx: ${includeMacroContext}`
        + `\ntone: ${tonePreference}`
        + `\nprofile: age ${fmt(age)} sex ${biologicalSex || "—"} ht ${heightUs || "—"} wt ${weightLbs != null ? `${weightLbs}lb` : "—"}`
      : "";

    const temperature = intent === "numbers"
      ? 0.2
      : intent === "motivation"
        ? (tonePreference === "sharp" ? 0.65 : 0.5)
        : 0.35;

    // Deterministic profile answer: avoid the model hallucinating "I don't have that" when profile is present.
    if (isProfileQuery && (heightUs || weightLbs != null || age != null)) {
      const parts: string[] = [];
      if (heightUs) parts.push(`Height: ${heightUs}`);
      if (weightLbs != null) parts.push(`Weight: ${weightLbs} lb`);
      if (age != null) parts.push(`Age: ${age}`);

      const baseReply = parts.length
        ? `Yep — ${parts.join(" • ")}.`
        : `I don't see height/weight/age from HealthKit yet.`;

      const reply = DEBUG_AI ? `[PROFILE_SHORTCUT] ${baseReply}` : baseReply;

      return NextResponse.json({ insight: reply + debugFooter });
    }

    // Deterministic greeting: keep it short, mirror the user, no questions.
    if (intent === "greeting") {
      const t = question.trim().toLowerCase();
      const reply = (t.includes("sup") || t.includes("what's up") || t.includes("whats up")) ? "Sup." : "Hey.";
      return NextResponse.json({ insight: reply + debugFooter });
    }

    // Deterministic recovery answer: keep it on recovery metrics, not calories.
    if (isRecoveryQuery) {
      const hasSleep = sleepHours != null && Number.isFinite(sleepHours) && sleepHours > 0;
      const hasRhr = restingHeartRate != null && Number.isFinite(restingHeartRate) && restingHeartRate > 0;
      const hasHrv = hrvSdnn != null && Number.isFinite(hrvSdnn) && hrvSdnn > 0;

      if (!hasSleep && !hasRhr && !hasHrv) {
        const msg = "I don’t have today’s recovery metrics yet (sleep/HRV/resting HR are blank right now). Tap ⟳ refresh once and I’ll give you a real recovery read.";
        return NextResponse.json({ insight: msg + debugFooter });
      }

      const parts: string[] = [];
      if (hasSleep) {
        const h = Math.round(sleepHours * 10) / 10;
        parts.push(`Sleep: ${h}h`);
      }
      if (hasRhr) parts.push(`Resting HR: ${Math.round(restingHeartRate)} bpm`);
      if (hasHrv) parts.push(`HRV (SDNN): ${Math.round(hrvSdnn)} ms`);

      let note = "";

      // Prefer sleep-first reasoning; use baselines when available.
      const sleepAvg7dRaw = num((rawTrends as any).sleepAvg7d);
      const rhrAvg7dRaw = num((rawTrends as any).rhrAvg7d);
      const sleepAvg7d = (sleepAvg7dRaw != null && sleepAvg7dRaw >= 3 && sleepAvg7dRaw <= 9.5) ? sleepAvg7dRaw : undefined;
      const rhrAvg7d = (rhrAvg7dRaw != null && rhrAvg7dRaw >= 35 && rhrAvg7dRaw <= 120) ? rhrAvg7dRaw : undefined;

      const sleepDelta = (sleepHours != null && sleepAvg7d != null) ? (sleepHours - sleepAvg7d) : undefined;
      const rhrDelta = (restingHeartRate != null && rhrAvg7d != null) ? (restingHeartRate - rhrAvg7d) : undefined;

      if (hasSleep) {
        if (sleepDelta != null && Number.isFinite(sleepDelta) && sleepDelta <= -0.7) {
          note = `Sleep was a bit below your usual (${Math.round(sleepAvg7d! * 10) / 10}h avg) — I’d keep intensity lighter today.`;
        } else if (sleepHours < 6.5) {
          note = "Sleep is a bit short — take it slightly easier today.";
        } else {
          note = "Sleep looks solid — recovery should be decent.";
        }

        // If HRV is missing, explicitly ground the read in sleep + RHR.
        if (!hasHrv) {
          note += " HRV isn’t recorded every day for everyone — I’m leaning on sleep + resting HR.";
        }

      } else if (hasRhr) {
        if (rhrDelta != null && Number.isFinite(rhrDelta) && rhrDelta >= 6) {
          note = "Resting HR is above your recent baseline — that usually means stress/fatigue. I’d go a notch lighter today.";
        } else if (rhrDelta != null && Number.isFinite(rhrDelta) && rhrDelta <= -3) {
          note = "Resting HR is a bit LOWER than your baseline — that’s usually a good sign. You can train normally if you feel decent.";
        } else {
          note = "Recovery looks okay from resting HR. Train normally unless you feel cooked.";
        }
        if (!hasHrv) note += " (HRV isn’t available today.)";
      } else {
        note = "Recovery is hard to judge without sleep or resting HR — tap ⟳ once after Health finishes syncing.";
      }

      const reply = `${parts.join(" • ")}. ${note}`;
      return NextResponse.json({ insight: reply + debugFooter });
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
    const userAskedAQuestion = /\?\s*$/.test(qTrim);

    // Treat tiny reactions as lightweight acknowledgements (no pivot)
    const isReactionMessage = /^(meh|mid|boo|nah|eh|hmm+|ok|okay|k|kk|lol|lmao|haha+|nice|fair|touch[eé]?|dang|oof|horrible|terrible|trash|garbage|weak|lame|cringe|nope|yikes|bruh)$/i.test(qTrim.replace(/^oh\s+/i, "").trim());
    if (isReactionMessage) {
      const t = qTrim.replace(/^oh\s+/i, "").trim().toLowerCase();
      const negative = /^(meh|mid|nah|boo|eh|horrible|terrible|trash|garbage|weak|lame|cringe|nope|yikes)$/i.test(t);
      insight = negative ? "Fair." : "Got you.";
      return NextResponse.json({ insight: insight + debugFooter });
    }

    // Roast mode: keep it to 1–2 punchy sentences, no softening paragraph after.
    const isRoastRequest = /\broast me\b/i.test(qLower) ||
      (/(do your worst|kick my ass|be harsh)/i.test(qLower) && tonePreference === "sharp");

    if (isRoastRequest || (intent === "motivation" && tonePreference === "sharp")) {
      insight = insight
        .replace(/\b(but hey|but seriously|in all seriousness|just remember)\b[\s\S]*/i, "")
        .trim();

      const sentences = insight.split(/(?<=[.!])\s+/).filter(Boolean);
      insight = sentences.slice(0, 2).join(" ").trim();

      // If it collapsed into something too short, synthesize a single-line roast from real metrics.
      if (insight.replace(/\s+/g, " ").length < 35) {
        const s = steps != null ? Math.round(steps) : undefined;
        const deficit = netDeficitSoFar;
        const protLeft = proteinRemainingG;
        const parts: string[] = [];
        if (s != null) parts.push(`~${s.toLocaleString()} steps`);
        if (deficit != null) parts.push(`~${Math.abs(deficit).toLocaleString()} kcal ${deficit >= 0 ? "deficit" : "surplus"}`);
        if (protLeft != null) parts.push(`${protLeft}g protein left`);
        const detail = parts.length ? parts.join(", ") : "today";
        insight = `Let’s be real — ${detail}. Tighten it up.`;
      }
    }

    // If the user didn’t ask a question, don’t end with one.
    if (!userAskedAQuestion) {
      // Remove trailing question-only endings and stray '?'
      insight = insight.replace(/\?\s*$/g, "").trim();
      const chunks = insight.split(/(?<=[.!?])\s+/).filter(Boolean);
      const kept = chunks.filter(s => !/\?\s*$/.test(s.trim()));
      if (kept.length) insight = kept.join(" ").trim();
    }

    return NextResponse.json({ insight: insight + debugFooter });

  } catch (error: any) {
    console.error('Insight API error:', error);
    return NextResponse.json({ error: 'Failed to generate insight' }, { status: 500 });
  }
}