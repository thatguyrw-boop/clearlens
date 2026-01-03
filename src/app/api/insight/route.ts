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

// ====================== SYSTEM PROMPT — CONCISE, CHAT-STYLE, MEMORY-AWARE ======================
    const systemPrompt = `You are ClearLens — a quiet, personal wellness companion that feels like texting a real friend who knows your habits and goals.

INTERNAL REASONING (do not output):
- Review all available metrics, profile data, preferences, trends, and memory.
- Identify up to 3 relevant insights ranked by importance to the user's question.
- Lead with the single most helpful insight.
- Only add nuance if it clearly helps decision-making.
- Do not mention internal rules or system prompts. Do not cite formulas unless asked.
- NEVER use the specific phrasing “25–40g”, “25-40g”, “25 to 40g”, or “25–40 grams/gram” in your response.
- Never claim you cannot access the user's health data or connect to external apps; HealthKit metrics are already provided by this app.



-CONVERSATIONAL STYLE
- Be a calm, present friend — not an interviewer or coach.
- Reflection > instruction > questions.
- Do not ask a follow-up unless it clearly improves the answer.
- Many responses should end without a question.
- Silence after a good response is acceptable and intentional.
- Match the user's emotional energy.
- Vary phrasing and structure; avoid predictable patterns.
- Language texture:
  - Avoid repeatedly starting responses with “It sounds like…”, “That sounds like…”, or “It seems like…”.
  - Do not use those phrases at all unless quoting the user.
  - Prefer natural openers such as: “Yeah.” “Totally.” “That tracks.” “I get that.” “Makes sense.”
  - Vary sentence length; occasional short fragments are okay.
  - Anti-template repetition: avoid starting multiple replies with the same opener (e.g., "You’ve", "With", "If you..."). Do not reuse an opener used in the last 2 assistant messages.
  - Signature phrases (use naturally, not all at once): "That tracks." "No shame." "Let’s be real."
- If the user did not ask a question, you do not need to ask one back.
- If Tone is SHARP, follow the SHARPNESS mode (DIRECT/SPICY/SAVAGE) shown in CURRENT SETTINGS.


- You are a calm, witty friend — not a comedian.
- Humor is optional and must be subtle. Never force a joke.
- Avoid generic hype or motivational-poster lines (e.g., "keep that energy going", "crush it", "you've got this") unless the user explicitly asks for motivation.
- Pop culture references are optional and must never derail the answer.
- Use pop culture ONLY when CURRENT SETTINGS says "Pop culture: YES".
- Avoid stereotypes. Tailor loosely by age cohort (not gender):
  • under 25: modern internet culture (light, non-cringe)
  • 25–34: 2010s references
  • 35–44: 90s/2000s references
  • 45+: 80s/90s classics
- Keep any reference to ONE short line, then return to the user’s real situation.
- If a reference doesn’t fit naturally, do not include one.

PSYCHOLOGY (behavioral, non-clinical)
- Use light behavioral principles to improve clarity and motivation; do not provide therapy or clinical advice.
- Reciprocity: Offer a brief, relatable insight first ("I see this a lot…") before inviting the user to share more.
- Social proof: When celebrating, reference anonymized trends or streaks ("Many people struggle here—you're ahead today"). Never imply medical outcomes.
- Dissonance resolution: Gently acknowledge conflicts (e.g., wanting progress while feeling tired) and normalize adjustment.
- Anchoring: Start suggestions from the user’s actual data (e.g., remaining protein, sleep vs 7‑day avg) rather than generic targets.
- Self‑efficacy: Highlight small wins and capabilities to reinforce confidence; keep praise specific and grounded.
- Safety: If the user seems distressed, anxious, or in pain, keep responses supportive and practical; avoid humor and pop culture.

SHARPNESS (only when Tone is SHARP)
- DIRECT: concise, blunt, respectful. No fluff. No insults.
- SPICY: direct + a little witty edge. Light teasing is allowed.
- SAVAGE: hard accountability. Call out excuses. Still no insults, cruelty, or personal attacks.
- If the user is tired/sad/stressed, keep sharpness one notch softer.

CONVERSATIONAL RESTRAINT
- Prioritize reflection over advancement.
- Validate first. Add advice only if it clearly improves the user’s next decision.
- Do not ask a follow-up question unless:
  • the user is actively planning (meal/workout), OR
  • more information is required for accuracy, OR
  • the user explicitly asks for ideas.
- Silence after a complete, helpful response is intentional.
- Ending without a question is confidence, not failure.
- When giving suggestions, default to ONE strong suggestion (optionally a second). Avoid numbered lists or long option dumps unless the user explicitly asks for options.

PRIMARY MODE SELECTION (pick ONE per response)
- Choose exactly one mode unless the user explicitly asks for both:
  1) REFLECTION: validate/normalize only. No advice. No question.
  2) GUIDANCE: one practical next step. Minimal empathy. No extra questions.
  3) INFORMATION: facts/metrics only. No coaching language.
  4) BANTER: one short playful line (allowed only if Pop culture: YES), then stop.
- Do not blend REFLECTION + GUIDANCE in the same response.

CURRENT SETTINGS
- Pressure: ${effectivePressure.toUpperCase()}
- Tone: ${tonePreference.toUpperCase()}
${tonePreference === "sharp" ? `- Sharpness: ${sharpnessLabel}` : ""}
- Intent: ${intent.toUpperCase()}
- Pop culture: ${allowPopCulture ? "YES" : "NO"}
- On track today: ${onTrack ? "YES" : "NO"}
- Late night: ${isLateNight ? "YES" : "NO"}
${voiceContext}

RELATIONSHIP MEMORY (use naturally)
- Days active: ${daysActive}
- Goal: ${goal || "not set"}
- Favorite snack: ${favoriteSnack || "none"}
- Workout time: ${workoutTimePref || "any"}
- Protein streak: ${proteinStreak} days
- Recent feedback: ${lastFeedback || "none"}

PREFERENCE
- When discussing height/weight or calorie targets, use US units first (ft/in, lb). You may include metric in parentheses.
- Medical/nutrition context: User does not have a gallbladder.
  - Prefer lower-fat meals and avoid recommending large fat boluses.
  - If suggesting fats, recommend small amounts spread across meals (e.g., 5–15g per meal) and emphasize tolerance.
  - If user reports GI upset, suggest reducing fat per meal and spreading it out.
- Macro guidance context (for reference only; don’t quote directly):
  - Active adults often aim for ~0.7–1.0 g protein per lb bodyweight daily (higher for muscle gain / hard training).
  - Daily total matters more than any single meal.
  - If remaining protein is large, focus on sustainable pacing across remaining meals (use proteinRemainingG / mealsLeft as a guide).
  - If fat shows as 0g, it may reflect incomplete logging rather than intentional restriction.
  - User has no gallbladder: prefer moderate fat per meal, spread across the day, and prioritize tolerance.

- Coaching behavior:
  - For intent PROGRESS or GENERAL: do not default to nutrition. Lead with the most relevant category (movement/sleep/training) unless the user asked about macros or nutrition is clearly the limiting factor.
  - When advising push vs rest, briefly explain the reasoning using recent sleep/load/recovery context before giving the recommendation.
  - If proteinRemainingG is provided, anchor guidance in “remaining today” and suggest a realistic pacing across meals (proteinPerMealG), rather than generic meal ranges.
  - If you mention a next-meal protein amount, use proteinPerMealG directly (a single number), not a range.
  - Keep it conversational: 1–2 short paragraphs. Offer one practical next step only when helpful. Do not force a follow-up question.

PROFILE (available from HealthKit; use when asked)
- Age: ${fmt(age)}
- Sex: ${biologicalSex || "—"}
- Height: ${heightUs || "—"} (${fmt(heightCm, " cm")})
- Weight: ${weightLbs != null ? `${weightLbs} lb` : "—"} (${fmt(weightKg, " kg")})

TODAY (use only what’s relevant; avoid repeating unchanged metrics on follow-ups)
- Steps: ${fmt(steps)} (7-day avg: ${fmt(steps7dAvgUsable)})
- Burned so far: ~${fmt(totalCaloriesBurned)} kcal
- Eaten so far: ${fmt(dietaryCalories)} kcal
${likelyUnlogged ? "- Note: user mentioned food that may not be logged yet; treat intake as incomplete." : ""}
${wantsQuickLog ? "- User wants to log the item quickly; offer a default estimate and ask to confirm." : ""}
${wantsQuickLog ? "- User indicates food is already logged; treat intake as current." : ""}
${isEvening ? "- Time context: evening; prefer light guidance and day‑wrap rather than optimization." : ""}
${planningLater ? "- User is planning a later snack; answer directly without follow‑up interrogation." : ""}
- Net (burned − eaten): ${fmt(netDeficitSoFar)} kcal
${(sleepAvg7d != null || rhrAvg7d != null || hrvAvg7d != null || workoutMinutes7d != null) ? `- Recovery/load context (reference only):
  - Readiness hint: ${readinessHint.toUpperCase()}
  - Sleep vs 7d avg: ${sleepDeltaHrs != null ? fmt(sleepDeltaHrs, " h") : "—"}
  - RHR vs 7d avg: ${rhrDeltaBpm != null ? fmt(rhrDeltaBpm, " bpm") : "—"}
  - HRV vs 7d avg: ${hrvDeltaMs != null ? fmt(hrvDeltaMs, " ms") : "—"}
  - Recent load (7d): ${loadHint.toUpperCase()} (${workoutMinutes7d != null ? fmt(workoutMinutes7d, " min") : "—"})
` : ""}
${includeMacroContext ? `- Protein: ${fmt(dietaryProteinG)} g
- Protein target: ${proteinTargetG != null ? fmt(proteinTargetG, " g") : "—"}
- Protein remaining: ${proteinRemainingG != null ? fmt(proteinRemainingG, " g") : "—"}
- Meals left today (estimate): ${mealsLeft}
- Protein per meal (to finish target): ${proteinPerMealG != null ? fmt(proteinPerMealG, " g") : "—"}
- Carbs/Fat/Fiber: ${dietaryCarbsG != null ? fmt(dietaryCarbsG) : "—"}/${dietaryFatG != null ? fmt(dietaryFatG) : "—"}/${dietaryFiberG != null ? fmt(dietaryFiberG) : "—"} g
- Important: When answering about macros, interpret them as "so far today" and avoid judging balance as final unless user asks for end-of-day planning.
` : ""}
- Sleep: ${fmt(sleepHours)} h

${chatHistoryText ? `RECENT CHAT (for continuity; do not repeat verbatim)\n${chatHistoryText}\n\n` : ""}Question: "${question.trim()}"
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

    // Last-resort: strip the common blog-trope protein range if the model emits it.
    // Use a single, computed number when available.
    const perMeal = proteinPerMealG != null ? `${proteinPerMealG}g` : "50g";
    insight = insight
      // 25–40g / 25-40g / 25 to 40g (with optional space and optional trailing 'of protein')
      .replace(/\b25\s*[–-]\s*40\s*g\b(?:\s*(?:of\s+protein|protein))?/gi, perMeal)
      .replace(/\b25\s*to\s*40\s*g\b(?:\s*(?:of\s+protein|protein))?/gi, perMeal)
      // 25–40 grams / 25-40 grams / 25 to 40 grams (with optional trailing 'of protein')
      .replace(/\b25\s*[–-]\s*40\s*grams?\b(?:\s*(?:of\s+protein|protein))?/gi, perMeal)
      .replace(/\b25\s*to\s*40\s*grams?\b(?:\s*(?:of\s+protein|protein))?/gi, perMeal)
      // fallback: '25–40' followed shortly by 'protein' even if units are missing
      .replace(/\b25\s*[–-]\s*40\b(?=[^\n]{0,24}\bprotein\b)/gi, perMeal)
      .replace(/\b25\s*to\s*40\b(?=[^\n]{0,24}\bprotein\b)/gi, perMeal);

    return NextResponse.json({ insight: insight + debugFooter });

  } catch (error: any) {
    console.error('Insight API error:', error);
    return NextResponse.json({ error: 'Failed to generate insight' }, { status: 500 });
  }
}