import type { Env } from "./types";
export { runChat, streamChat, generateImage, transcribeAudio, chooseModel, chooseReasoning } from "./openai-base";

export async function synthesizeSpeech(env: Env, input: string, voice = "alloy"): Promise<Response> {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input, response_format: "mp3" }),
  });
  if (!response.ok) throw new Error(await response.text());
  return new Response(response.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
