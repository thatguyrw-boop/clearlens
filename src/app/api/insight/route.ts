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

const ALLOWED_INTENTS = new Set(["plate", "label", "menu", "pantry", "chat", "estimate_text"]);

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

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const parseJsonFromResponse = (raw: string): UnknownRecord | undefined => {
  let parsedUnknown = parseJson(raw);
  if (!parsedUnknown) {
    const extracted = raw.match(/\{[\s\S]*\}/)?.[0];
    if (extracted) parsedUnknown = parseJson(extracted);
  }
  return isRecord(parsedUnknown) ? parsedUnknown : undefined;
};

const hasOwn = (obj: UnknownRecord, key: string) =>
  Object.prototype.hasOwnProperty.call(obj, key);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const normalizeOptionalRange = (lowRaw: unknown, highRaw: unknown) => {
  const hasLow = lowRaw !== undefined && lowRaw !== null;
  const hasHigh = highRaw !== undefined && highRaw !== null;
  if (!hasLow && !hasHigh) return { low: null, high: null };
  if (hasLow !== hasHigh) return null;
  const low = toNumber(lowRaw);
  const high = toNumber(highRaw);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  if (low >= high) return null;
  return { low, high };
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

    const { intent, imageBase64 } = body ?? {};
    if (!intent || typeof intent !== "string" || !ALLOWED_INTENTS.has(intent)) {
      return NextResponse.json(
        { error: "intent must be one of: plate, label, menu, pantry, chat, estimate_text" },
        { status: 400 }
      );
    }

    const userMemory = isRecord(body?.userMemory) ? body.userMemory : undefined;
    const chatHistory = Array.isArray(body?.chatHistory) ? body.chatHistory : undefined;

    const needsImage = ["label", "plate", "menu", "pantry"].includes(intent);
    const forceVisionOpenAI = needsImage;
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
    if (needsImage) {
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
    } else if (!isNonEmptyString(question)) {
      return NextResponse.json(
        { error: "question is required" },
        { status: 400 }
      );
    }

    const memoryLine = userMemory ? `User memory JSON: ${JSON.stringify(userMemory)}.` : "User memory: none.";
    const historyLine = chatHistory ? `Chat history JSON: ${JSON.stringify(chatHistory)}.` : "Chat history: none.";
    const questionLine = question ? `User question: ${question}` : "User question: none.";

    switch (intent) {
      case "label": {
        const visionPrompt = `
You are reading a Nutrition Facts label.
Return ONLY valid JSON with this exact shape:
{
  "insight": string,
  "label": {
    "title": string|null,
    "caloriesPerServing": number,
    "proteinGPerServing": number,
    "carbsGPerServing": number,
    "fatGPerServing": number,
    "fiberGPerServing": number,
    "servingSizeText": string,
    "servingSizeGrams": number,
    "servingSizeMl": number,
    "servingSizeFlOz": number,
    "servingsPerContainer": number,
    "isLiquid": boolean,
    "primaryUnit": "g"|"ml"|"fl_oz"|"serving"
  }
}
Title should be 2-5 words from front/package text. Use null if not found.
Optional fields may be omitted if not visible.
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
      const parsed = parseJsonFromResponse(raw);
      if (!parsed) {
        return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
      }

      const insight = (getString(parsed, "insight") ?? "").trim();
      const labelUnknown = getUnknown(parsed, "label");
      const label = isRecord(labelUnknown) ? labelUnknown : undefined;

      const caloriesPerServing = toNumber(label ? getUnknown(label, "caloriesPerServing") : undefined);
      const proteinGPerServing = toNumber(label ? getUnknown(label, "proteinGPerServing") : undefined);
      const carbsRaw = label ? getUnknown(label, "carbsGPerServing") : undefined;
      const fatRaw = label ? getUnknown(label, "fatGPerServing") : undefined;
      const fiberRaw = label ? getUnknown(label, "fiberGPerServing") : undefined;
      const carbsGPerServing = toNullableNumber(carbsRaw);
      const fatGPerServing = toNullableNumber(fatRaw);
      const fiberGPerServing = toNullableNumber(fiberRaw);
      const titleRaw = label ? getUnknown(label, "title") : undefined;
      let title: string | null | undefined;
      let titleInvalid = false;
      if (titleRaw !== undefined) {
        if (titleRaw === null) {
          title = null;
        } else if (typeof titleRaw === "string") {
          const trimmedTitle = titleRaw.trim();
          title = trimmedTitle ? trimmedTitle : null;
        } else {
          titleInvalid = true;
        }
      }
      const servingSizeText = (getString(label ?? {}, "servingSizeText") ?? "").trim();
      const servingSizeGramsRaw = label ? getUnknown(label, "servingSizeGrams") : undefined;
      const servingSizeMlRaw = label ? getUnknown(label, "servingSizeMl") : undefined;
      const servingSizeFlOzRaw = label ? getUnknown(label, "servingSizeFlOz") : undefined;
      const servingsPerContainerRaw = label ? getUnknown(label, "servingsPerContainer") : undefined;
      const servingSizeGrams = toNullableNumber(servingSizeGramsRaw);
      const servingSizeMl = toNullableNumber(servingSizeMlRaw);
      const servingSizeFlOz = toNullableNumber(servingSizeFlOzRaw);
      const servingsPerContainer = toNullableNumber(servingsPerContainerRaw);
      const isLiquidRaw = label ? getUnknown(label, "isLiquid") : undefined;
      let isLiquid: boolean | undefined;
      let isLiquidInvalid = false;
      if (isLiquidRaw !== undefined && isLiquidRaw !== null) {
        if (typeof isLiquidRaw === "boolean") {
          isLiquid = isLiquidRaw;
        } else {
          isLiquidInvalid = true;
        }
      }
      const primaryUnitRaw = label ? getUnknown(label, "primaryUnit") : undefined;
      let primaryUnit: string | undefined;
      let primaryUnitInvalid = false;
      if (primaryUnitRaw !== undefined && primaryUnitRaw !== null) {
        if (typeof primaryUnitRaw === "string" && ["g", "ml", "fl_oz", "serving"].includes(primaryUnitRaw)) {
          primaryUnit = primaryUnitRaw;
        } else {
          primaryUnitInvalid = true;
        }
      }

      if (
        !insight ||
        !Number.isFinite(caloriesPerServing) ||
        !Number.isFinite(proteinGPerServing) ||
        !servingSizeText ||
        titleInvalid ||
        isLiquidInvalid ||
        primaryUnitInvalid
      ) {
        return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
      }
      if (label) {
        if (hasOwn(label, "carbsGPerServing") && carbsRaw !== null && carbsGPerServing === undefined) {
          return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
        }
        if (hasOwn(label, "fatGPerServing") && fatRaw !== null && fatGPerServing === undefined) {
          return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
        }
        if (hasOwn(label, "fiberGPerServing") && fiberRaw !== null && fiberGPerServing === undefined) {
          return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
        }
        if (hasOwn(label, "servingSizeGrams") && servingSizeGramsRaw !== null && servingSizeGrams === undefined) {
          return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
        }
        if (hasOwn(label, "servingSizeMl") && servingSizeMlRaw !== null && servingSizeMl === undefined) {
          return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
        }
        if (hasOwn(label, "servingSizeFlOz") && servingSizeFlOzRaw !== null && servingSizeFlOz === undefined) {
          return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
        }
        if (hasOwn(label, "servingsPerContainer") && servingsPerContainerRaw !== null && servingsPerContainer === undefined) {
          return NextResponse.json({ error: "Invalid label response" }, { status: 500 });
        }
      }

      return NextResponse.json({
        insight,
        label: {
          caloriesPerServing,
          proteinGPerServing,
          ...(title !== undefined ? { title } : {}),
          ...(carbsGPerServing !== undefined && carbsGPerServing !== null ? { carbsGPerServing } : {}),
          ...(fatGPerServing !== undefined && fatGPerServing !== null ? { fatGPerServing } : {}),
          ...(fiberGPerServing !== undefined && fiberGPerServing !== null ? { fiberGPerServing } : {}),
          servingSizeText,
          ...(servingSizeGrams !== undefined && servingSizeGrams !== null ? { servingSizeGrams } : {}),
          ...(servingSizeMl !== undefined && servingSizeMl !== null ? { servingSizeMl } : {}),
          ...(servingSizeFlOz !== undefined && servingSizeFlOz !== null ? { servingSizeFlOz } : {}),
          ...(servingsPerContainer !== undefined && servingsPerContainer !== null ? { servingsPerContainer } : {}),
          ...(isLiquid !== undefined ? { isLiquid } : {}),
          ...(primaryUnit !== undefined ? { primaryUnit } : {})
        }
      });
      }
      case "plate": {
        const visionPrompt = `
You are estimating nutrition for a plate of food from a photo.
${memoryLine}
${questionLine}
Identify foods and estimate LOW/MID/HIGH calories and protein.
Respond ONLY as valid JSON with this exact shape:
{
  "insight": string,
  "plateEstimate": {
    "lowCal": number,
    "midCal": number,
    "highCal": number,
    "lowProteinG": number,
    "midProteinG": number,
    "highProteinG": number
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
        const parsed = parseJsonFromResponse(raw);
        if (!parsed) {
          return NextResponse.json({ error: "Invalid plate response" }, { status: 500 });
        }

        const insight = (getString(parsed, "insight") ?? "").trim();
        const plateEstimateUnknown = getUnknown(parsed, "plateEstimate");
        const plateEstimate = isRecord(plateEstimateUnknown) ? plateEstimateUnknown : undefined;
        const lowCal = toNumber(plateEstimate ? getUnknown(plateEstimate, "lowCal") : undefined);
        const midCal = toNumber(plateEstimate ? getUnknown(plateEstimate, "midCal") : undefined);
        const highCal = toNumber(plateEstimate ? getUnknown(plateEstimate, "highCal") : undefined);
        const lowProteinG = toNumber(plateEstimate ? getUnknown(plateEstimate, "lowProteinG") : undefined);
        const midProteinG = toNumber(plateEstimate ? getUnknown(plateEstimate, "midProteinG") : undefined);
        const highProteinG = toNumber(plateEstimate ? getUnknown(plateEstimate, "highProteinG") : undefined);

        if (
          !insight ||
          !Number.isFinite(lowCal) ||
          !Number.isFinite(midCal) ||
          !Number.isFinite(highCal) ||
          !Number.isFinite(lowProteinG) ||
          !Number.isFinite(midProteinG) ||
          !Number.isFinite(highProteinG)
        ) {
          return NextResponse.json({ error: "Invalid plate response" }, { status: 500 });
        }

        return NextResponse.json({
          insight,
          plateEstimate: {
            lowCal,
            midCal,
            highCal,
            lowProteinG,
            midProteinG,
            highProteinG
          }
        });
      }
      case "menu": {
        const visionPrompt = `
You are reading a menu from an image.
${memoryLine}
${questionLine}
Respond ONLY as valid JSON with this exact shape:
{
  "insight": string,
  "menuChoices": [
    {
      "title": string,
      "reason": string,
      "orderText": string,
      "caloriesLow": number|null,
      "caloriesHigh": number|null,
      "proteinLow": number|null,
      "proteinHigh": number|null
    }
  ]
}

Rules:
- Return exactly 3 choices.
- If a calorie or protein range is provided, include both low/high and keep low < high; otherwise use null for both.
- Keep ranges realistic; avoid fake precision.
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
        const parsed = parseJsonFromResponse(raw);
        if (!parsed) {
          return NextResponse.json({ error: "Invalid menu response" }, { status: 500 });
        }

        const insight = (getString(parsed, "insight") ?? "").trim();
        const choicesUnknown = getUnknown(parsed, "menuChoices");
        if (!insight || !Array.isArray(choicesUnknown)) {
          return NextResponse.json({ error: "Invalid menu response" }, { status: 500 });
        }

        const menuChoices = choicesUnknown.map((choice: unknown) => {
          if (!isRecord(choice)) return null;

          const title = (getString(choice, "title") ?? "").trim();
          const reason = (getString(choice, "reason") ?? "").trim();
          const orderText = (getString(choice, "orderText") ?? "").trim();

          const caloriesRange = normalizeOptionalRange(
            getUnknown(choice, "caloriesLow"),
            getUnknown(choice, "caloriesHigh")
          );
          const proteinRange = normalizeOptionalRange(
            getUnknown(choice, "proteinLow"),
            getUnknown(choice, "proteinHigh")
          );

          if (!title || !reason || !orderText || !caloriesRange || !proteinRange) {
            return null;
          }

          return {
            title,
            reason,
            orderText,
            caloriesLow: caloriesRange.low,
            caloriesHigh: caloriesRange.high,
            proteinLow: proteinRange.low,
            proteinHigh: proteinRange.high
          };
        }).filter(Boolean) as Array<{
          title: string;
          reason: string;
          orderText: string;
          caloriesLow: number | null;
          caloriesHigh: number | null;
          proteinLow: number | null;
          proteinHigh: number | null;
        }>;

        if (menuChoices.length !== 3) {
          return NextResponse.json({ error: "Invalid menu response" }, { status: 500 });
        }

        return NextResponse.json({ insight, menuChoices });
      }
      case "pantry": {
        const pantryPrompt = `
You are analyzing a photo of a pantry or fridge.
${memoryLine}
${questionLine}

Task:
- Identify ONLY clear staple items you can see.
- Suggest EXACTLY 3 practical snack or meal ideas.
- Each idea must be realistic, quick, and goal-aligned.
- Include calorie and protein ranges (low/high).

Output JSON ONLY in this exact format:

{
  "insight": string,
  "pantryIdeas": [
    {
      "title": "string",
      "reason": "string",
      "caloriesLow": number|null,
      "caloriesHigh": number|null,
      "proteinLow": number|null,
      "proteinHigh": number|null,
      "logDesc": "string"
    }
  ]
}

Rules:
- Do NOT include markdown.
- Do NOT include explanations outside JSON.
Optional fields may be omitted if not visible.
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
        const parsed = parseJsonFromResponse(raw);
        if (!parsed) {
          return NextResponse.json({ error: "Invalid pantry response" }, { status: 500 });
        }

        const insight = (getString(parsed, "insight") ?? "").trim();
        const ideasUnknown = getUnknown(parsed, "pantryIdeas");
        if (!insight || !Array.isArray(ideasUnknown)) {
          return NextResponse.json({ error: "Invalid pantry response" }, { status: 500 });
        }

        const pantryIdeas = ideasUnknown.map((idea: unknown) => {
          if (!isRecord(idea)) return null;

          const title = (getString(idea, "title") ?? "").trim();
          const reason = (getString(idea, "reason") ?? "").trim();
          const logDesc = (getString(idea, "logDesc") ?? "").trim();
          const caloriesRange = normalizeOptionalRange(
            getUnknown(idea, "caloriesLow"),
            getUnknown(idea, "caloriesHigh")
          );
          const proteinRange = normalizeOptionalRange(
            getUnknown(idea, "proteinLow"),
            getUnknown(idea, "proteinHigh")
          );

          if (!title || !reason || !caloriesRange || !proteinRange) {
            return null;
          }

          return {
            title,
            reason,
            ...(logDesc ? { logDesc } : {}),
            caloriesLow: caloriesRange.low,
            caloriesHigh: caloriesRange.high,
            proteinLow: proteinRange.low,
            proteinHigh: proteinRange.high
          };
        }).filter(Boolean) as Array<{
          title: string;
          reason: string;
          logDesc?: string;
          caloriesLow: number | null;
          caloriesHigh: number | null;
          proteinLow: number | null;
          proteinHigh: number | null;
        }>;

        if (pantryIdeas.length !== 3) {
          return NextResponse.json({ error: "Invalid pantry response" }, { status: 500 });
        }

        return NextResponse.json({ insight, pantryIdeas });
      }
      case "chat": {
        const prompt = `
You are a helpful nutrition coach.
${memoryLine}
${historyLine}
${questionLine}
Respond in plain text.
`;

        const completion = await llm.chat.completions.create({
          model,
          temperature: 0.4,
          max_tokens: 400,
          messages: [{ role: "user", content: prompt }]
        });

        const raw = (completion.choices[0]?.message?.content || "").trim();
        if (!raw) {
          return NextResponse.json({ error: "Empty chat response" }, { status: 500 });
        }

        return NextResponse.json({ insight: raw });
      }
      case "estimate_text": {
        const prompt = `
Estimate calories and protein from this text description.
${memoryLine}
${questionLine}
Return a single line with LOW/MID/HIGH estimates.
Example format: LOW: 350 cal, 20g protein | MID: 500 cal, 30g protein | HIGH: 650 cal, 40g protein.
Respond with only that line.
`;

        const completion = await llm.chat.completions.create({
          model,
          temperature: 0.2,
          max_tokens: 120,
          messages: [{ role: "user", content: prompt }]
        });

        const raw = (completion.choices[0]?.message?.content || "").trim();
        if (!raw) {
          return NextResponse.json({ error: "Empty estimate response" }, { status: 500 });
        }

        return NextResponse.json({ insight: raw });
      }
      default:
        return NextResponse.json({ error: "intent must be one of: plate, label, menu, pantry, chat, estimate_text" }, { status: 400 });
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
