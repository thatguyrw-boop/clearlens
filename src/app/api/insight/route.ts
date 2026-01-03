// app/api/insight/route.ts

import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const DEBUG_AI =
  process.env.CLEARLENS_DEBUG_AI === "true" &&
  process.env.NODE_ENV !== "production" &&
  process.env.VERCEL_ENV !== "production";

// Minimal in-memory rate limit (dev + small-scale). Not a substitute for edge/CDN limits.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const rateMap = new Map<string, { count: number; resetAt: number }>();

// Supabase client — optional in dev; if env vars are missing, memory features are skipped.
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
      chatHistory: rawChatHistory = [],
      isVoiceInput = false, // NEW: true if this came from voice transcription
      metrics: rawMetrics = {},
      profile: rawProfile = {},
      preferences: rawPreferences = {},
      trends: rawTrends = {},
      feedback, // optional: { rating: "positive" | "negative" }
    } = body ?? {};

    if (DEBUG_AI) {
      console.log("[insight] rawProfile received", rawProfile);
    }

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

    // ====================== METRIC PARSING (UNCHANGED — YOUR MACROS STILL WORK!) ======================
    const num = (x: any): number | undefined => {
      const v = typeof x === "string" ? Number(x) : x;
      return Number.isFinite(v) ? Number(v) : undefined;
    };
    const fmt = (n?: number, suffix = "") => (n == null ? "—" : `${n}${suffix}`);

    const cmToFtIn = (cm?: number): string | undefined => {
      if (cm == null) return undefined;
      const totalIn = cm / 2.54;
      const ft = Math.floor(totalIn / 12);
      const inch = Math.round(totalIn - ft * 12);
      return `${ft}′ ${inch}″`;
    };

    const kgToLbs = (kg?: number): number | undefined => {
      if (kg == null) return undefined;
      return Math.round(kg * 2.2046226218);
    };

    const steps = num(rawMetrics.steps);
    const activeCalories = num(rawMetrics.activeCalories ?? rawMetrics.calories);
    const totalCaloriesBurned = num(rawMetrics.totalCaloriesBurned);
    const burnedSoFar = totalCaloriesBurned;
    const dietaryCalories = num(rawMetrics.dietaryEnergyConsumed ?? rawMetrics.dietaryCalories);
    const eatenSoFar = dietaryCalories;
    const netDeficitSoFar = (burnedSoFar != null && eatenSoFar != null)
      ? Math.round(burnedSoFar - eatenSoFar)
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
    const workoutMinutes = num(rawMetrics.workoutMinutes ?? rawMetrics.workoutsMinutes);
    const workoutCount = num(rawMetrics.workoutCount);
    const hasAnyNutritionToday = rawMetrics.hasAnyNutritionToday === true;
    const proteinBehindPace = rawMetrics.proteinBehindPace === true;

    // Profile
    const age = num(rawProfile.age);
    const biologicalSex = typeof rawProfile.biologicalSex === "string" ? rawProfile.biologicalSex : undefined;
    const heightCm = num((rawProfile as any).heightCm);
    const weightKg = num((rawProfile as any).weightKg);

    const heightUs = cmToFtIn(heightCm);
    const weightLbs = kgToLbs(weightKg);

    // Preferences
    const pressurePreference = num(rawPreferences.pressure) ?? 2; // 1=low, 2=medium, 3=high
    const tonePreference: "neutral" | "warm" | "sharp" =
      rawPreferences?.tone === "warm" || rawPreferences?.tone === "sharp"
        ? rawPreferences.tone
        : "neutral";

    // Sharpness level (only applies when tone is sharp). Derived from pressure so we don't add UI yet.
    // 1=Direct (blunt, respectful), 2=Spicy (witty edge), 3=Savage (hard accountability, still not insulting).
    const sharpnessLevel: 1 | 2 | 3 =
      tonePreference === "sharp"
        ? (pressurePreference === 1 ? 1 : pressurePreference === 3 ? 3 : 2)
        : 1;
    const sharpnessLabel = sharpnessLevel === 1 ? "DIRECT" : sharpnessLevel === 2 ? "SPICY" : "SAVAGE";

    // Trends
    const steps7dAvg = num(rawTrends.steps7dAvg);
    const steps7dAvgUsable = (steps7dAvg != null && steps7dAvg >= 2000) ? steps7dAvg : undefined;

    // Recovery / load trend summaries (optional; sent from client)
    const sleepAvg7d = num((rawTrends as any).sleepAvg7d);
    const rhrAvg7d = num((rawTrends as any).rhrAvg7d);
    const hrvAvg7d = num((rawTrends as any).hrvAvg7d);
    const workoutMinutes7d = num((rawTrends as any).workoutMinutes7d);

    // Box 2A: compute recovery/load deltas and lightweight readiness/load hints from existing metrics + the newly-parsed 7-day trend averages.
    // Recovery/load deltas vs 7-day averages (optional)
    const sleepDeltaHrs = (sleepHours != null && sleepAvg7d != null) ? Math.round((sleepHours - sleepAvg7d) * 10) / 10 : undefined;
    const rhrDeltaBpm = (restingHeartRate != null && rhrAvg7d != null) ? Math.round(restingHeartRate - rhrAvg7d) : undefined;
    const hrvDeltaMs = (hrvSdnn != null && hrvAvg7d != null) ? Math.round(hrvSdnn - hrvAvg7d) : undefined;

    // Lightweight readiness hint (not a rule engine; just context)
    let readinessHint: "green" | "yellow" | "red" = "yellow";
    if ((sleepHours != null && sleepHours < 6) || (rhrDeltaBpm != null && rhrDeltaBpm >= 6) || (hrvDeltaMs != null && hrvDeltaMs <= -10)) {
      readinessHint = "red";
    } else if ((sleepHours != null && sleepHours >= 7) && (rhrDeltaBpm == null || rhrDeltaBpm <= 0) && (hrvDeltaMs == null || hrvDeltaMs >= 0)) {
      readinessHint = "green";
    }

    // Simple recent load hint
    const loadMinutes = workoutMinutes7d;
    const loadHint: "low" | "moderate" | "high" =
      loadMinutes != null && loadMinutes >= 300 ? "high" :
      loadMinutes != null && loadMinutes >= 150 ? "moderate" :
      "low";

    // ====================== INTENT DETECTION ======================
    const qLower = question.toLowerCase();

    const isMetaFeedback = /\b(why are you|too harsh|too repetitive|stop roasting|same answers|feedback)\b/.test(qLower);
    const isMotivationRequest = /\b(roast me|be harsh|push me|motivate|do your worst|kick my ass|be strict|hold me accountable)\b/.test(qLower);
    const isFoodQuestion = /\b(what should i eat|dinner|lunch|snack|chicken|steak|shrimp|tacos|pizza|dessert|menu|burrito|lasagna|pasta)\b/.test(qLower);

    const mentionsUnloggedFood = /\b(had|ate|just ate|just had|i had|i ate|burrito|lasagna|pizza|pasta|dessert)\b/.test(qLower);
    const likelyUnlogged = mentionsUnloggedFood && (dietaryCalories == null || dietaryCalories < 800);

    const wantsQuickLog = /\b(just log it|just need to log|just log|log it|log this|add it|already logged|all logged)\b/.test(qLower);

    const planningLater = /\b(later|tonight|before bed|after dinner|movie night|popcorn|dessert later)\b/.test(qLower);

    const isProgressCheck = /\b(progress|how am i doing|how\s*'s my|how is my|today so far|late night check|recap)\b/.test(qLower);
    const baseNumbersRe = /\b(numbers?|calories|kcal|deficit|calculate|calculated|how did you|show your work|math)\b/;
    const macroWordsRe = /\b(protein|carbs?|fat|fiber|macros?)\b/;
    const numberCueRe = /\b(\d+|grams?|\bg\b|kcal|calories|how many|how much|what are|numbers?)\b/;
    const isNumbersRequest = baseNumbersRe.test(qLower) || (macroWordsRe.test(qLower) && numberCueRe.test(qLower));

    const intent =
      isMetaFeedback ? "meta_feedback" :
      (isNumbersRequest && isMotivationRequest) ? "motivation" :
      isNumbersRequest ? "numbers" :
      isFoodQuestion ? "food" :
      isMotivationRequest ? "motivation" :
      isProgressCheck ? "progress" :
      "general";

    // ====================== ON-TRACK ASSESSMENT ======================
    const movementOk = steps != null ? (steps7dAvg ? steps >= steps7dAvg * 0.8 : steps >= 6000) : true;
    const sleepOk = sleepHours != null ? sleepHours >= 6.5 : true;
    const nutritionOk = hasAnyNutritionToday ? !proteinBehindPace : true;
    const trainingOk =
      workoutMinutes != null || workoutCount != null
        ? true
        : (steps != null ? steps >= 10000 : true);

    const onTrack = [movementOk, sleepOk, nutritionOk, trainingOk].filter(Boolean).length >= 3;

    // ====================== USER MEMORY FROM SUPABASE (optional) ======================
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
    const proteinStreak = Number(memories.protein_streak_days ?? 0);
    const favoriteSnack = (memories.favorite_snack as string) || null;
    const workoutTimePref = (memories.workout_time_pref as string) || null;
    const goal = (memories.goal as string) || null;
    const lastFeedback = (memories.last_feedback as string) || null;

    // ====================== EFFECTIVE PRESSURE ======================
    let effectivePressure: "low" | "medium" | "high" =
      pressurePreference === 1 ? "low" :
      pressurePreference === 3 ? "high" :
      "medium";

    if (lastFeedback === "too_much_pressure") {
      effectivePressure = effectivePressure === "high" ? "medium" : "low";
    }

    if (intent === "numbers" || intent === "meta_feedback" || (onTrack && intent !== "motivation")) {
      effectivePressure = "low";
    } else if (onTrack && effectivePressure === "high") {
      effectivePressure = "medium";
    }

    // Pop culture should be rare and only when it fits (avoid cringe + avoid serious moments)
    const lowMood = /\b(tired|exhausted|stressed|anxious|pain|hurt|sick|rough|meh|down|depressed)\b/.test(qLower);
    const allowPopCulture =
      !lowMood &&
      (intent === "motivation" || intent === "progress") &&
      (tonePreference === "sharp" || effectivePressure !== "low") &&
      Math.random() < 0.35; // ~1 in 3

    const includeMacroContext =
      macroWordsRe.test(qLower) ||
      intent === "food" ||
      wantsQuickLog ||
      likelyUnlogged;

    const isProfileQuery = /\b(do you know|what\s*'s|what is|tell me)\b.*\b(height|weight|age)\b/.test(qLower);
    const isRecoveryQuery = /\b(recovery|readiness|sleep|hrv|sdnn|resting\s*hr|rhr|resting heart)\b/.test(qLower);

    // ====================== ASYNC MEMORY UPDATE ======================
    (async () => {
      if (!supabase) return;
      try {
        const updates: Record<string, any> = {
          days_active: daysActive + 1,
        };

        if (dietaryProteinG != null && dietaryProteinG >= 140) {
          updates.protein_streak_days = proteinStreak + 1;
        } else if (proteinStreak > 0) {
          updates.protein_streak_days = 0;
        }

        if (feedback?.rating) {
          updates.last_feedback = feedback.rating === "negative" ? "too_much_pressure" : "good";
        }

        for (const [key, value] of Object.entries(updates)) {
          await supabase
            .from('user_memories')
            .upsert(
              { user_id: userId, key, value },
              { onConflict: 'user_id,key' }
            );
        }
      } catch (e) {
        console.error('Memory update failed:', e);
      }
    })();


    // ====================== VOICE INPUT HANDLING ======================
    const voiceContext = isVoiceInput
      ? "\nThis question came from voice input — keep response extra concise, clear, and spoken-friendly (short sentences, no jargon)."
      : "";

    // ====================== TIME CONTEXT ======================
    const tzOffsetMinutes = num((rawProfile as any)?.tzOffsetMinutes ?? (rawPreferences as any)?.tzOffsetMinutes);
    const localHour = (() => {
      if (tzOffsetMinutes == null) return new Date().getHours();
      const utcMs = Date.now() + new Date().getTimezoneOffset() * 60_000;
      const localMs = utcMs - tzOffsetMinutes * 60_000;
      return new Date(localMs).getHours();
    })();
    const isLateNight = localHour >= 20 || localHour <= 5;
    const isEvening = localHour >= 18 && localHour < 22;

    // ===== SIMPLE MEAL-REMAINING HEURISTIC (for per-meal suggestions) =====
    const mealsLeft = localHour < 11 ? 3 : localHour < 16 ? 2 : localHour < 21 ? 2 : 1;
    const proteinPerMealG = proteinRemainingG != null
      ? Math.min(70, Math.max(25, Math.round(proteinRemainingG / mealsLeft)))
      : undefined;

    // ===== CHAT HISTORY (compact, safe) =====
    const chatHistory = Array.isArray(rawChatHistory) ? rawChatHistory : [];
    const chatHistoryText = chatHistory
      .slice(-12)
      .map((m: any) => {
        const role = m?.role === "assistant" ? "assistant" : "user";
        const text = String(m?.text ?? "").trim();
        return text ? `${role}: ${text}` : null;
      })
      .filter(Boolean)
      .join("\n");

    const systemPrompt = `You are ClearLens — a calm, witty wellness friend who’s actually inside this app.

NON-NEGOTIABLES
- You DO have access to the user’s HealthKit metrics via the provided data. Never say you can’t access their health data or can’t connect to external apps.
- Keep it human: reflection first, advice second, question rarely.
- If the user did NOT ask a question, do NOT ask one back.
- Avoid lists/bullets unless the user explicitly asks for options/ideas.
- Avoid blog/coach filler. Keep it tight.

VOICE TEXTURE (use naturally, not every time)
- Signature phrases (sprinkle, not spam): “That tracks.” “No shame.” “Let’s be real.”
- Anti-template repetition: avoid starting multiple replies with the same opener (“You’ve”, “With”, “If you…”, “Just checking…”, “Alright, here goes…”).
  - Don’t reuse an opener used in the last 2 assistant messages.
- Hard opener ban: do NOT start any reply with “You’ve got”.

CURRENT SETTINGS
- Pressure: ${effectivePressure.toUpperCase()}
- Tone: ${tonePreference.toUpperCase()}${tonePreference === "sharp" ? ` (Sharpness: ${sharpnessLabel})` : ""}
- Intent: ${intent.toUpperCase()}
- Pop culture: ${allowPopCulture ? "YES" : "NO"}

CONTEXT (use only if relevant)
- Goal: ${goal || "not set"}
- Favorite snack: ${favoriteSnack || "none"}
- No gallbladder: prefer moderate fat per meal; spread fats out.

TODAY (use what matters; don’t re-dump everything)
- Steps: ${fmt(steps)} (7d avg: ${fmt(steps7dAvgUsable)})
- Burned: ${fmt(totalCaloriesBurned)} kcal | Eaten: ${fmt(dietaryCalories)} kcal | Net: ${fmt(netDeficitSoFar)} kcal
- Sleep: ${fmt(sleepHours)} h | RHR: ${fmt(restingHeartRate)} bpm | HRV (SDNN): ${fmt(hrvSdnn)} ms
${(sleepAvg7d != null || rhrAvg7d != null || hrvAvg7d != null || workoutMinutes7d != null) ? `- Readiness hint: ${readinessHint.toUpperCase()} | Load: ${loadHint.toUpperCase()}
  - Sleep vs 7d avg: ${sleepDeltaHrs != null ? fmt(sleepDeltaHrs, " h") : "—"}
  - RHR vs 7d avg: ${rhrDeltaBpm != null ? fmt(rhrDeltaBpm, " bpm") : "—"}
  - HRV vs 7d avg: ${hrvDeltaMs != null ? fmt(hrvDeltaMs, " ms") : "—"}
` : ""}
${includeMacroContext ? `- Macros so far: Protein ${fmt(dietaryProteinG)}g (target ${proteinTargetG != null ? fmt(proteinTargetG, "g") : "—"}, remaining ${proteinRemainingG != null ? fmt(proteinRemainingG, "g") : "—"}) | Carbs ${fmt(dietaryCarbsG)}g | Fat ${fmt(dietaryFatG)}g | Fiber ${fmt(dietaryFiberG)}g
- Meals left (est): ${mealsLeft} | Protein per meal (est): ${proteinPerMealG != null ? fmt(proteinPerMealG, "g") : "—"}
` : ""}

REPLY FORMAT
- Prefer 1–2 short paragraphs.
- Default endings: a complete thought (no question) unless the user is planning/choosing or explicitly asked a question.
- Choose ONE mode per reply: INFORMATION (facts), REFLECTION (validate), GUIDANCE (one next step), or BANTER (one line, only if Pop culture: YES).

${chatHistoryText ? `RECENT CHAT (for continuity; do not quote verbatim)\n${chatHistoryText}\n\n` : ""}User message: "${question.trim()}"
`;

    const debugFooter = DEBUG_AI
      ? `\n\n—\nDEBUG\n• intent: ${intent}`
        + `\n• includeMacroContext: ${includeMacroContext}`
        + `\n• proteinPerMealG: ${proteinPerMealG != null ? proteinPerMealG : "—"}`
        + `\n• onTrack: ${onTrack}\n• pressure: ${effectivePressure}\n• tone: ${tonePreference}\n• voiceInput: ${isVoiceInput}\n• localHour: ${localHour}\n• lateNight: ${isLateNight}\n• daysActive: ${daysActive}\n• proteinStreak: ${proteinStreak}`
        + `\n• profile.age: ${fmt(age)}`
        + `\n• profile.sex: ${biologicalSex || "—"}`
        + `\n• profile.height: ${heightUs || "—"} (${fmt(heightCm, " cm")})`
        + `\n• profile.weight: ${weightLbs != null ? `${weightLbs} lb` : "—"} (${fmt(weightKg, " kg")})`
      : "";

    const temperature = intent === "numbers"
      ? 0.2
      : intent === "motivation"
        ? (effectivePressure === "high" ? 0.7 : 0.55)
        : (isEvening ? 0.3 : 0.35);

    // Deterministic profile answer: avoid the model hallucinating "I don't have that" when profile is present.
    if (isProfileQuery && (heightUs || weightLbs != null || age != null)) {
      if (DEBUG_AI) {
        console.log("[insight] profile shortcut", { age, biologicalSex, heightCm, weightKg, heightUs, weightLbs });
      }
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
          note = "Resting HR is above your recent baseline — that’s often a sign to go easier today.";
        } else {
          note = "Recovery looks okay from resting HR.";
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


    // ===== Voice guardrails (hard enforcement) =====
    const userAskedAQuestion = /\?\s*$/.test(question.trim());
    const isRoastRequest = /\broast me\b/.test(qLower) || (/\bdo your worst\b|\bkick my ass\b|\bbe harsh\b/.test(qLower) && tonePreference === "sharp");

    // Helper values for post-processing
    const qTrim = question.trim();

    // Grab the most recent assistant message to avoid repeating the same roast hook
    const lastAssistantMsg = [...chatHistory].slice().reverse().find((m: any) => (m?.role === "assistant"))?.text;
    const lastAssistantText = String(lastAssistantMsg ?? "");

    // Step 1: Treat tiny reactions as replies to the last assistant message (banter, no pivot)
    // Tiny reactions / acknowledgements we should treat as direct replies to the last assistant message
    const isReactionMessage = /^(meh|mid|boo|nah|eh|hmm+|hmmm+|ok|okay|lol|lmao|haha+|ha\b|nice|good one|fair|touch[eé]|you got me|got me|dang|oof)$/i.test(qTrim);

    if (isReactionMessage && lastAssistantText) {
      const lastWasRoast = /\b(roast|olympic|marathon|snack|steps|buffet|training|gym|walk)\b/i.test(lastAssistantText);
      const neg = /\b(meh|mid|nah|boo|eh)\b/i.test(qTrim);
      if (lastWasRoast) {
        insight = neg
          ? "Fair. That one was mid. I’ll do better."
          : "That tracks.";
      } else {
        // Non-roast last message: keep it short and in-character
        insight = neg ? "Fair." : "That tracks.";
      }
      return NextResponse.json({ insight: insight + debugFooter });
    }




    // ROAST MODE: one punch only (1–2 lines), no softening after ("but hey", "just remember", etc.)
    if (isRoastRequest || (intent === "motivation" && tonePreference === "sharp")) {
      insight = insight
        // hard-stop anything after common softening pivots
        .replace(/\b(but hey|but seriously|just remember|remember|at least|seriously|in all seriousness)\b[\s\S]*/i, "")
        .replace(/\?\s*$/g, "")
        .trim();

      // If our stripping leaves only a preamble (or empties the roast), generate a fresh 1–2 line roast.
      const tooShort = insight.replace(/\s+/g, " ").trim().length < 35;
      const preambleOnly = /^\s*(let’s be real\.|lets be real\.|alright[,!]?\s*(here we go|here goes)?[:.!]?|ok[,!]?\s*)\s*$/i.test(insight.trim());
      if (tooShort || preambleOnly) {
        const s = steps != null ? Math.round(steps) : undefined;
        const deficit = netDeficitSoFar;
        const protLeft = proteinRemainingG;
        const prot = dietaryProteinG;
        // Keep it punchy, avoid starting with "You've".
        const parts: string[] = [];
        if (s != null) parts.push(`you’re at ~${s.toLocaleString()} steps`);
        if (deficit != null) parts.push(`a ~${Math.abs(deficit).toLocaleString()} kcal ${deficit >= 0 ? "deficit" : "surplus"}`);
        if (protLeft != null && prot != null) parts.push(`${protLeft}g protein left (you’re at ${Math.round(prot)}g)`);
        const detail = parts.length ? parts.join(", ") : "today";
        insight = `Let’s be real. ${detail} — and you’re still acting surprised you feel cooked.`;
      }

      // If the roast starts with template openers, strip them and lead with a signature phrase.
      if (/^\s*(alright|okay|you\s*'?ve|you\s+have|you\s+are|you\s+had|you\s+hit|you\s*'?ve\s+got)\b/i.test(insight)) {
        insight = "Let’s be real. " + insight.replace(/^\s*(alright|okay)(,|\:)?\s*(here\s+goes\:?)?\s*/i, "").replace(/^\s*(you\s*'?ve\s+got|you\s*'?ve\s+been|you\s+have|you\s+are|you\s+had|you\s+hit)\b\s*[:,—-]?\s*/i, "").trim();
      }

      // Keep max 2 lines
      const lines = insight.split(/\n+/).map(l => l.trim()).filter(Boolean);
      insight = lines.slice(0, 2).join("\n");

      // If still long, keep first 2 sentences max
      const sentences = insight.split(/(?<=[.!])\s+/).filter(Boolean);
      insight = sentences.slice(0, 2).join(" ").trim();
    }

    if (!userAskedAQuestion) {
      // Drop any sentence that ends with a question mark.
      const parts = insight.split(/(?<=[.!?])\s+/).filter(Boolean);
      const kept = parts.filter(s => !/\?\s*$/.test(s.trim()));
      insight = (kept.length ? kept.join(" ") : insight).trim();
      // Final guard: strip trailing '?' if present.
      insight = insight.replace(/\?\s*$/g, "").trim();
    }

    return NextResponse.json({ insight: insight + debugFooter });

  } catch (error: any) {
    console.error('Insight API error:', error);
    return NextResponse.json({ error: 'Failed to generate insight' }, { status: 500 });
  }
}