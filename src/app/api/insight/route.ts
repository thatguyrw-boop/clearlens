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

const ALLOWED_MODES = new Set(["plate", "label", "label_extract", "menu", "pantry"]);

const toNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? Number(n) : undefined;
};

const parseJson = (raw: string) => {
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
        { error: "mode must be one of: plate, label, label_extract, menu, pantry" },
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
  "proteinGPerServing": number,
  "carbsGPerServing": number,
  "fatGPerServing": number,
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
      let parsed = parseJson(raw);
      if (!parsed && extracted) {
        parsed = parseJson(extracted);
      }
      if (!parsed) {
        if (debugEnabled) {
          return NextResponse.json({ type: "label", debugRaw: raw });
        }
        return NextResponse.json({ type: "label", error: "unreadable" });
      }
      if (parsed?.type === "label" && parsed?.error === "unreadable") {
        return NextResponse.json({ type: "label", error: "unreadable" });
      }

      const caloriesPerServing = toNumber(parsed?.caloriesPerServing);
      const proteinGPerServing = toNumber(parsed?.proteinGPerServing);
      const carbsGPerServing = toNumber(parsed?.carbsGPerServing);
      const fatGPerServing = toNumber(parsed?.fatGPerServing);
      const servingSizeText = typeof parsed?.servingSizeText === "string" ? parsed.servingSizeText.trim() : "";

      if (
        !Number.isFinite(caloriesPerServing) ||
        !Number.isFinite(proteinGPerServing) ||
        !Number.isFinite(carbsGPerServing) ||
        !Number.isFinite(fatGPerServing) ||
        !servingSizeText
      ) {
        return NextResponse.json({ type: "label", error: "unreadable" });
      }

      return NextResponse.json({
        caloriesPerServing,
        proteinGPerServing,
        carbsGPerServing,
        fatGPerServing,
        servingSizeText
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
        const parsed = parseJson(raw);
        const low = parsed?.estimate?.low ?? parsed?.estimate?.LOW;
        const mid = parsed?.estimate?.mid ?? parsed?.estimate?.MID;
        const high = parsed?.estimate?.high ?? parsed?.estimate?.HIGH;
        const lowCalories = toNumber(low?.calories);
        const lowProtein = toNumber(low?.protein);
        const midCalories = toNumber(mid?.calories);
        const midProtein = toNumber(mid?.protein);
        const highCalories = toNumber(high?.calories);
        const highProtein = toNumber(high?.protein);

        if (
          parsed?.type !== "plate" ||
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
          }
        });
      }
      case "menu": {
        const visionPrompt = `
You are reading a menu from an image.
${profileLine}
Respond ONLY as valid JSON in one of these forms:
{"type":"menu","choices":[...]}
OR
{"type":"menu","text":"..."}
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
        const parsed = parseJson(raw);

        if (parsed?.type !== "menu") {
          return NextResponse.json({ error: "Invalid menu response" }, { status: 500 });
        }

        if (Array.isArray(parsed?.choices)) {
          const choices = parsed.choices.map((choice: unknown) => {
            if (typeof choice === "string") return choice.trim();
            if (choice == null) return "";
            return String(choice).trim();
          }).filter((choice: string) => Boolean(choice));
          return NextResponse.json({ type: "menu", choices });
        }

        if (typeof parsed?.text === "string" && parsed.text.trim()) {
          return NextResponse.json({ type: "menu", text: parsed.text.trim() });
        }

        return NextResponse.json({ error: "Invalid menu response" }, { status: 500 });
      }
      case "pantry": {
        const visionPrompt = `
You are looking at a pantry or fridge photo to suggest meal ideas.
${profileLine}
Respond ONLY as valid JSON with this exact shape:
{"type":"pantry","ideas":[...]}
`;

        const completion = await llm.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 240,
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
        const parsed = parseJson(raw);

        if (parsed?.type !== "pantry" || !Array.isArray(parsed?.ideas)) {
          return NextResponse.json({ error: "Invalid pantry response" }, { status: 500 });
        }

        const ideas = parsed.ideas.map((idea: unknown) => {
          if (typeof idea === "string") return idea.trim();
          if (idea == null) return "";
          return String(idea).trim();
        }).filter((idea: string) => Boolean(idea));

        return NextResponse.json({ type: "pantry", ideas });
      }
      default:
        return NextResponse.json({ error: "mode must be one of: plate, label, label_extract, menu, pantry" }, { status: 400 });
    }

  } catch (error: any) {
    console.error('Insight API error:', error);
    const message = typeof error?.message === "string" ? error.message : "Failed to generate insight";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
