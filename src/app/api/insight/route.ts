// force-redeploy: grok-provider-version-v2
// app/api/insight/route.ts

import { NextResponse } from 'next/server';
import OpenAI from 'openai';

function getLLMClient() {
  const provider = String(process.env.LLM_PROVIDER || "openai").toLowerCase();
  if (provider === "xai" || provider === "grok") {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) throw new Error("Server misconfigured: missing XAI_API_KEY");
    return {
      provider: "xai",
      model: process.env.XAI_MODEL || "grok-4",
      client: new OpenAI({ apiKey, baseURL: "https://api.x.ai/v1" }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Server misconfigured: missing OPENAI_API_KEY");
  return {
    provider: "openai",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    client: new OpenAI({ apiKey }),
  };
}

const ALLOWED_MODES = new Set(["plate", "label", "label_extract", "menu", "pantry", "restaurant"]);

const toNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? Number(n) : undefined;
};

const toNullableNumber = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return toNumber(value);
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is UnknownRecord => typeof v === "object" && v !== null;

const getString = (obj: UnknownRecord, key: string) => {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
};

const getUnknown = (obj: UnknownRecord, key: string) => obj[key];

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (question.toLowerCase() === "version") {
      const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_REF || "local";
      const p = String(process.env.LLM_PROVIDER || "openai").toLowerCase();
      return NextResponse.json({ insight: `backend:${String(sha).slice(0, 12)} provider:${p}` });
    }

    const { mode, imageBase64, userProfile } = body ?? {};
    const debugEnabled = process.env.NODE_ENV !== "production" || body?.debug === true;
    if (!mode || typeof mode !== "string" || !ALLOWED_MODES.has(mode)) {
      return NextResponse.json(
        { error: "mode must be one of: plate, label, label_extract, menu, pantry, restaurant" },
        { status: 400 }
      );
    }

    const normalizedMode = mode === "label_extract" ? "label" : mode;

    const forceVisionOpenAI = ["label", "plate", "menu", "pantry"].includes(normalizedMode);
    let llm: OpenAI;
    let model: string;
    if (forceVisionOpenAI) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("Server misconfigured: missing OPENAI_API_KEY");
      llm = new OpenAI({ apiKey });
      model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    } else {
      const c = getLLMClient();
      llm = c.client;
      model = c.model;
    }
    const providerUsed = forceVisionOpenAI ? "openai" : (String(process.env.LLM_PROVIDER || "openai").toLowerCase());
    const includeMeta = process.env.NODE_ENV !== "production";
    const meta = includeMeta ? { _provider: providerUsed, _model: model } : {};

    if (normalizedMode !== "restaurant") {
      if (!imageBase64 || typeof imageBase64 !== "string") {
        return NextResponse.json(
          { error: "imageBase64 is required" },
          { status: 400 }
        );
      }

      if (imageBase64.length > 3_000_000) {
        return NextResponse.json(
          { error: "Image too large. Retake closer." },
          { status: 400 }
        );
      }
    }

    const profile = typeof userProfile === "object" && userProfile ? userProfile : {};
    const profileSex = profile.sex ?? profile.biologicalSex;
    const profileActivity = profile.activity ?? profile.activityLevel ?? profile.activity_level;
    const profileSnippet = [
      profileSex ? `sex: ${profileSex}` : null,
      profileActivity ? `activity: ${profileActivity}` : null
    ].filter(Boolean).join(", ");
    const profileLine = profileSnippet ? `User profile: ${profileSnippet}.` : "User profile: not provided.";

    switch (normalizedMode) {
      case "label": {
        const visionPrompt = `
You are reading a Nutrition Facts label.
If the label is unreadable or missing, respond ONLY with:
{"type":"label","error":"unreadable"}

Otherwise respond ONLY as valid JSON:
{
  "caloriesPerServing": number,
  "proteinGPerServing": number|null,
  "carbsGPerServing": number|null,
  "fatGPerServing": number|null,
  "fiberGPerServing": number|null,
  "servingSizeText": string
}
`;

      const completion = await llm.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: 220,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: visionPrompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
            ]
          }
        ]
      });

      const raw = completion.choices[0]?.message?.content || "";
      const extracted = raw.match(/\{[\s\S]*\}/)?.[0];
      let parsedUnknown = parseJson(raw);
      if (!parsedUnknown && extracted) {
        parsedUnknown = parseJson(extracted);
      }
      const parsed = isRecord(parsedUnknown) ? parsedUnknown : undefined;
      if (!parsed) {
        if (debugEnabled) {
          return NextResponse.json({ type: "label", debugRaw: raw });
        }
        return NextResponse.json({ type: "label", error: "unreadable" });
      }
      const parsedType = getString(parsed, "type");
      const parsedError = getString(parsed, "error");
      if (parsedType === "label" && parsedError === "unreadable") {
        return NextResponse.json({ type: "label", error: "unreadable" });
      }

      const caloriesPerServing = toNumber(getUnknown(parsed, "caloriesPerServing"));
      const proteinGPerServing = toNullableNumber(getUnknown(parsed, "proteinGPerServing"));
      const carbsGPerServing = toNullableNumber(getUnknown(parsed, "carbsGPerServing"));
      const fatGPerServing = toNullableNumber(getUnknown(parsed, "fatGPerServing"));
      const fiberGPerServing = toNullableNumber(getUnknown(parsed, "fiberGPerServing"));
      const servingSizeText = (getString(parsed, "servingSizeText") ?? "").trim();

      if (
        !Number.isFinite(caloriesPerServing) ||
        (proteinGPerServing === undefined || (proteinGPerServing !== null && !Number.isFinite(proteinGPerServing))) ||
        (carbsGPerServing === undefined || (carbsGPerServing !== null && !Number.isFinite(carbsGPerServing))) ||
        (fatGPerServing === undefined || (fatGPerServing !== null && !Number.isFinite(fatGPerServing))) ||
        (fiberGPerServing === undefined || (fiberGPerServing !== null && !Number.isFinite(fiberGPerServing))) ||
        !servingSizeText
      ) {
        return NextResponse.json({ type: "label", error: "unreadable" });
      }

      return NextResponse.json({
        caloriesPerServing,
        proteinGPerServing,
        carbsGPerServing,
        fatGPerServing,
        fiberGPerServing,
        servingSizeText,
        ...meta
      });
      }
      case "plate": {
        const visionPrompt = `
You are estimating nutrition for a plate of food from a photo.
${profileLine}
Respond ONLY as valid JSON with this exact shape:
{
  "type": "plate",
  "estimate": {
    "low": { "calories": number, "protein": number },
    "mid": { "calories": number, "protein": number },
    "high": { "calories": number, "protein": number }
  }
}
`;

        const completion = await llm.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 220,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: visionPrompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
              ]
            }
          ]
        });

        const raw = completion.choices[0]?.message?.content || "";
        const parsedUnknown = parseJson(raw);
        const parsed = isRecord(parsedUnknown) ? parsedUnknown : undefined;
        const estimateUnknown = parsed ? getUnknown(parsed, "estimate") : undefined;
        const estimate = isRecord(estimateUnknown) ? estimateUnknown : undefined;
        const lowUnknown = estimate ? (getUnknown(estimate, "low") ?? getUnknown(estimate, "LOW")) : undefined;
        const midUnknown = estimate ? (getUnknown(estimate, "mid") ?? getUnknown(estimate, "MID")) : undefined;
        const highUnknown = estimate ? (getUnknown(estimate, "high") ?? getUnknown(estimate, "HIGH")) : undefined;
        const low = isRecord(lowUnknown) ? lowUnknown : undefined;
        const mid = isRecord(midUnknown) ? midUnknown : undefined;
        const high = isRecord(highUnknown) ? highUnknown : undefined;
        const lowCalories = toNumber(low ? getUnknown(low, "calories") : undefined);
        const lowProtein = toNumber(low ? getUnknown(low, "protein") : undefined);
        const midCalories = toNumber(mid ? getUnknown(mid, "calories") : undefined);
        const midProtein = toNumber(mid ? getUnknown(mid, "protein") : undefined);
        const highCalories = toNumber(high ? getUnknown(high, "calories") : undefined);
        const highProtein = toNumber(high ? getUnknown(high, "protein") : undefined);
        const parsedType = parsed ? getString(parsed, "type") : undefined;

        if (
          parsedType !== "plate" ||
          !Number.isFinite(lowCalories) ||
          !Number.isFinite(lowProtein) ||
          !Number.isFinite(midCalories) ||
          !Number.isFinite(midProtein) ||
          !Number.isFinite(highCalories) ||
          !Number.isFinite(highProtein)
        ) {
          return NextResponse.json({ error: "Invalid plate response" }, { status: 500 });
        }

        return NextResponse.json({
          type: "plate",
          estimate: {
            low: { calories: lowCalories, protein: lowProtein },
            mid: { calories: midCalories, protein: midProtein },
            high: { calories: highCalories, protein: highProtein }
          },
          ...meta
        });
      }
      case "menu": {
        const visionPrompt = `
You are reading a menu from an image.
${profileLine}
Respond ONLY as valid JSON with this exact shape:
{
  "type": "menu",
  "choices": [
    {
      "title": string,
      "reason": string,
      "orderText": string,
      "caloriesLow": number,
      "caloriesHigh": number,
      "proteinLow": number,
      "proteinHigh": number,
      "carbsLow": number|null,
      "carbsHigh": number|null,
      "fatLow": number|null,
      "fatHigh": number|null,
      "fiberLow": number|null,
      "fiberHigh": number|null
    }
  ]
}

Rules:
- Return exactly 3 choices.
- caloriesLow < caloriesHigh and proteinLow < proteinHigh for each choice.
- If a macro range is provided, include both low/high and keep low < high; otherwise use null for both.
- Keep ranges realistic; avoid fake precision.
- If unreadable, return: { "type": "menu", "error": "unreadable" }
- No markdown, no extra keys, no extra text.
`;

        const completion = await llm.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 260,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: visionPrompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
              ]
            }
          ]
        });

        const raw = completion.choices[0]?.message?.content || "";
        const extracted = raw.match(/\{[\s\S]*\}/)?.[0];
        let parsedUnknown = parseJson(raw);
        if (!parsedUnknown && extracted) {
          parsedUnknown = parseJson(extracted);
        }
        const parsed = isRecord(parsedUnknown) ? parsedUnknown : undefined;

        if (!parsed) {
          return NextResponse.json({ type: "menu", error: "unreadable" });
        }

        const parsedType = getString(parsed, "type");
        const parsedError = getString(parsed, "error");
        if (parsedType === "menu" && parsedError === "unreadable") {
          return NextResponse.json({ type: "menu", error: "unreadable" });
        }

        const choicesUnknown = getUnknown(parsed, "choices");
        if (parsedType !== "menu" || !Array.isArray(choicesUnknown)) {
          return NextResponse.json({ type: "menu", error: "unreadable" });
        }

        const normalizeNullableRange = (lowRaw: unknown, highRaw: unknown) => {
          const hasLow = lowRaw !== undefined;
          const hasHigh = highRaw !== undefined;
          if (!hasLow && !hasHigh) return { low: null, high: null };
          if (hasLow !== hasHigh) return null;
          const low = toNullableNumber(lowRaw);
          const high = toNullableNumber(highRaw);
          if (low === undefined || high === undefined) return null;
          if (low === null && high === null) return { low: null, high: null };
          if (low === null || high === null) return null;
          if (low >= high) return null;
          return { low, high };
        };

        const choices = choicesUnknown.map((choice: unknown) => {
          if (!isRecord(choice)) return null;

          const title = (getString(choice, "title") ?? "").trim();
          const reason = (getString(choice, "reason") ?? "").trim();
          const orderText = (getString(choice, "orderText") ?? "").trim();

          const caloriesLow = toNumber(getUnknown(choice, "caloriesLow"));
          const caloriesHigh = toNumber(getUnknown(choice, "caloriesHigh"));
          const proteinLow = toNumber(getUnknown(choice, "proteinLow"));
          const proteinHigh = toNumber(getUnknown(choice, "proteinHigh"));

          const carbsRange = normalizeNullableRange(
            getUnknown(choice, "carbsLow"),
            getUnknown(choice, "carbsHigh")
          );
          const fatRange = normalizeNullableRange(
            getUnknown(choice, "fatLow"),
            getUnknown(choice, "fatHigh")
          );
          const fiberRange = normalizeNullableRange(
            getUnknown(choice, "fiberLow"),
            getUnknown(choice, "fiberHigh")
          );

          if (
            !title ||
            !reason ||
            !orderText ||
            !isFiniteNumber(caloriesLow) ||
            !isFiniteNumber(caloriesHigh) ||
            !isFiniteNumber(proteinLow) ||
            !isFiniteNumber(proteinHigh) ||
            !carbsRange ||
            !fatRange ||
            !fiberRange
          ) {
            return null;
          }

          if (caloriesLow >= caloriesHigh || proteinLow >= proteinHigh) {
            return null;
          }

          return {
            title,
            reason,
            orderText,
            caloriesLow,
            caloriesHigh,
            proteinLow,
            proteinHigh,
            carbsLow: carbsRange.low,
            carbsHigh: carbsRange.high,
            fatLow: fatRange.low,
            fatHigh: fatRange.high,
            fiberLow: fiberRange.low,
            fiberHigh: fiberRange.high
          };
        }).filter(Boolean) as Array<{
          title: string;
          reason: string;
          orderText: string;
          caloriesLow: number;
          caloriesHigh: number;
          proteinLow: number;
          proteinHigh: number;
          carbsLow: number | null;
          carbsHigh: number | null;
          fatLow: number | null;
          fatHigh: number | null;
          fiberLow: number | null;
          fiberHigh: number | null;
        }>;

        if (choices.length !== 3) {
          return NextResponse.json({ type: "menu", error: "unreadable" });
        }

        return NextResponse.json({ type: "menu", choices, ...meta });
      }
      case "pantry": {
        const pantryPrompt = `
You are analyzing a photo of a pantry or fridge.

Task:
- Identify ONLY clear staple items you can see.
- Suggest EXACTLY 3 practical snack or meal ideas.
- Each idea must be realistic, quick, and goal-aligned.
- Include calorie and protein ranges (low/high).

Output JSON ONLY in this exact format:

{
  "type": "pantry",
  "ideas": [
    {
      "title": "string",
      "reason": "string",
      "caloriesLow": number,
      "caloriesHigh": number,
      "proteinLow": number,
      "proteinHigh": number,
      "logDesc": "string"
    }
  ]
}

Rules:
- Do NOT include markdown.
- Do NOT include explanations outside JSON.
- If photo is unreadable, return:
  { "type": "pantry", "error": "unreadable" }
`;

        const completion = await llm.chat.completions.create({
          model,
          temperature: 0.3,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: pantryPrompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
              ]
            }
          ]
        });

        const raw = completion.choices[0]?.message?.content || "";
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return NextResponse.json(
            { type: "pantry", error: "unreadable" },
            { status: 200 }
          );
        }

        return NextResponse.json(parsed);
      }
      case "restaurant": {
        const restaurant = typeof body?.restaurant === "string" ? body.restaurant.trim() : "";
        const query = typeof body?.query === "string" ? body.query.trim() : "";

        if (!restaurant || !query) {
          return NextResponse.json(
            { error: "restaurant and query are required" },
            { status: 400 }
          );
        }

        const restaurantPrompt = `
You are suggesting restaurant order options with estimated nutrition ranges.
${profileLine}
Restaurant: ${restaurant}
Query: ${query}

Respond ONLY as valid JSON with this exact shape:
{
  "type": "restaurant",
  "restaurant": "string",
  "items": [
    {
      "title": "string",
      "notes": "string",
      "caloriesLow": number,
      "caloriesHigh": number,
      "proteinLow": number,
      "proteinHigh": number,
      "carbsLow": number|null,
      "carbsHigh": number|null,
      "fatLow": number|null,
      "fatHigh": number|null,
      "source": "estimate",
      "log": {
        "desc": "string",
        "calLow": number,
        "calHigh": number,
        "protLow": number,
        "protHigh": number,
        "carbLow": number|null,
        "carbHigh": number|null,
        "fatLow": number|null,
        "fatHigh": number|null
      }
    }
  ]
}

Rules:
- Return exactly 3 items.
- caloriesLow < caloriesHigh and proteinLow < proteinHigh for each item.
- Use estimated ranges (no web sources); include "source":"estimate" on each item.
- No markdown, no extra keys, no extra text.
- If you cannot comply, return: { "type": "restaurant", "error": "unreadable" }
`;

        const completion = await llm.chat.completions.create({
          model,
          temperature: 0.2,
          max_tokens: 500,
          messages: [
            { role: "user", content: restaurantPrompt }
          ]
        });

        const raw = completion.choices[0]?.message?.content || "";
        const extracted = raw.match(/\{[\s\S]*\}/)?.[0];
        let parsedUnknown = parseJson(raw);
        if (!parsedUnknown && extracted) {
          parsedUnknown = parseJson(extracted);
        }
        const parsed = isRecord(parsedUnknown) ? parsedUnknown : undefined;

        if (!parsed) {
          return NextResponse.json({ type: "restaurant", error: "unreadable" });
        }

        const parsedType = getString(parsed, "type");
        const parsedError = getString(parsed, "error");
        if (parsedType === "restaurant" && parsedError === "unreadable") {
          return NextResponse.json({ type: "restaurant", error: "unreadable" });
        }

        const itemsUnknown = getUnknown(parsed, "items");
        if (parsedType !== "restaurant" || !Array.isArray(itemsUnknown)) {
          return NextResponse.json({ type: "restaurant", error: "unreadable" });
        }

        const items = itemsUnknown.map((item: unknown) => {
          if (!isRecord(item)) return null;

          const title = (getString(item, "title") ?? "").trim();
          const notes = (getString(item, "notes") ?? "").trim();

          const caloriesLow = toNumber(getUnknown(item, "caloriesLow"));
          const caloriesHigh = toNumber(getUnknown(item, "caloriesHigh"));
          const proteinLow = toNumber(getUnknown(item, "proteinLow"));
          const proteinHigh = toNumber(getUnknown(item, "proteinHigh"));

          const carbsLow = toNullableNumber(getUnknown(item, "carbsLow"));
          const carbsHigh = toNullableNumber(getUnknown(item, "carbsHigh"));
          const fatLow = toNullableNumber(getUnknown(item, "fatLow"));
          const fatHigh = toNullableNumber(getUnknown(item, "fatHigh"));

          const source = getUnknown(item, "source");
          const logUnknown = getUnknown(item, "log");
          const log = isRecord(logUnknown) ? logUnknown : undefined;

          const logDesc = log ? (getString(log, "desc") ?? "").trim() : "";
          const calLow = log ? toNumber(getUnknown(log, "calLow")) : undefined;
          const calHigh = log ? toNumber(getUnknown(log, "calHigh")) : undefined;
          const protLow = log ? toNumber(getUnknown(log, "protLow")) : undefined;
          const protHigh = log ? toNumber(getUnknown(log, "protHigh")) : undefined;
          const carbLow = log ? toNullableNumber(getUnknown(log, "carbLow")) : undefined;
          const carbHigh = log ? toNullableNumber(getUnknown(log, "carbHigh")) : undefined;
          const logFatLow = log ? toNullableNumber(getUnknown(log, "fatLow")) : undefined;
          const logFatHigh = log ? toNullableNumber(getUnknown(log, "fatHigh")) : undefined;

          if (
            !title ||
            !notes ||
            !isFiniteNumber(caloriesLow) ||
            !isFiniteNumber(caloriesHigh) ||
            !isFiniteNumber(proteinLow) ||
            !isFiniteNumber(proteinHigh) ||
            carbsLow === undefined ||
            carbsHigh === undefined ||
            fatLow === undefined ||
            fatHigh === undefined ||
            source !== "estimate" ||
            !log ||
            !logDesc ||
            !isFiniteNumber(calLow) ||
            !isFiniteNumber(calHigh) ||
            !isFiniteNumber(protLow) ||
            !isFiniteNumber(protHigh) ||
            carbLow === undefined ||
            carbHigh === undefined ||
            logFatLow === undefined ||
            logFatHigh === undefined
          ) {
            return null;
          }

          if (
            caloriesLow >= caloriesHigh ||
            proteinLow >= proteinHigh ||
            calLow >= calHigh ||
            protLow >= protHigh
          ) {
            return null;
          }

          return {
            title,
            notes,
            caloriesLow,
            caloriesHigh,
            proteinLow,
            proteinHigh,
            carbsLow,
            carbsHigh,
            fatLow,
            fatHigh,
            source: "estimate" as const,
            log: {
              desc: logDesc,
              calLow,
              calHigh,
              protLow,
              protHigh,
              carbLow,
              carbHigh,
              fatLow: logFatLow as number | null,
              fatHigh: logFatHigh as number | null
            }
          };
        }).filter(Boolean) as Array<{
          title: string;
          notes: string;
          caloriesLow: number;
          caloriesHigh: number;
          proteinLow: number;
          proteinHigh: number;
          carbsLow: number | null;
          carbsHigh: number | null;
          fatLow: number | null;
          fatHigh: number | null;
          source: "estimate";
          log: {
            desc: string;
            calLow: number;
            calHigh: number;
            protLow: number;
            protHigh: number;
            carbLow: number | null;
            carbHigh: number | null;
            fatLow: number | null;
            fatHigh: number | null;
          };
        }>;

        if (items.length !== 3) {
          return NextResponse.json({ type: "restaurant", error: "unreadable" });
        }

        return NextResponse.json({
          type: "restaurant",
          restaurant,
          items
        });
      }
      default:
        return NextResponse.json({ error: "mode must be one of: plate, label, label_extract, menu, pantry, restaurant" }, { status: 400 });
    }

  } catch (error: unknown) {
    console.error('Insight API error:', error);
    const message =
      typeof (error as { message?: unknown } | null | undefined)?.message === "string"
        ? String((error as { message?: unknown }).message)
        : "Failed to generate insight";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
