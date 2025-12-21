import { NextResponse } from "next/server";
import OpenAI from "openai";
import { LENS_PROMPTS } from "@/lib/lenses";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { question, lens = "strategic", birthDate, birthTime, birthPlace } = body;

    if (!question?.trim()) {
      return NextResponse.json({ error: "Question required" }, { status: 400 });
    }

    // Calculate Sun sign accurately
    let astroContext = "";
    if (birthDate && birthDate.trim()) {
      const date = new Date(birthDate.trim() + "T12:00:00");
      if (isNaN(date.getTime())) {
        astroContext = "\nInvalid birth date provided — keep response general.";
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

        astroContext = `\nThe user has a ${sunSign} Sun${
          birthTime || birthPlace ? " (with additional birth details provided)" : ""
        }. Weave in relevant ${sunSign.split(" ")[1]} traits naturally and insightfully — keep it light, fun, affirming, and never preachy or deterministic. Tie it directly to their question when it adds depth.`;
      }
    } else {
      astroContext = "\nNo birth date was provided. Keep all insights general and universal — do not reference any zodiac signs or astrological traits.";
    }

    const lensPrompt = LENS_PROMPTS[lens as keyof typeof LENS_PROMPTS] || LENS_PROMPTS.strategic;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: lensPrompt + astroContext },
        { role: "user", content: question },
      ],
      temperature: 0.8,
      max_tokens: 1000,
    });

    const insight = completion.choices[0]?.message?.content?.trim() || "No insight generated.";

    return NextResponse.json({ insight });
  } catch (error: any) {
    console.error("API Error:", error);
    return NextResponse.json({ error: "Failed to generate insight" }, { status: 500 });
  }
}