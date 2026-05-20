/** Default frontier model for automated safe-update repair (override with OPENROUTER_MODEL). */
export const DEFAULT_AI_REPAIR_MODEL = 'anthropic/claude-opus-4';

export type OpenRouterRepairMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type OpenRouterRepairOptions = {
  apiKey: string;
  model: string;
  messages: OpenRouterRepairMessage[];
  maxTokens?: number;
};

export type OpenRouterRepairResult = {
  reply: string;
  model: string;
};

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:[\w-]+)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) return fenced[1].trim();
  const inline = trimmed.match(/```(?:[\w-]+)?\s*\n([\s\S]*?)```/);
  if (inline) return inline[1].trim();
  return trimmed;
}

export function assertNoConflictMarkers(content: string, filePath: string): void {
  if (/^<<<<<<<|^=======|^>>>>>>>/m.test(content)) {
    throw new Error(`Resolved file still contains conflict markers: ${filePath}`);
  }
}

export async function requestOpenRouterRepair(
  options: OpenRouterRepairOptions,
): Promise<OpenRouterRepairResult> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/mywebmasteruk/ycode-masjidweb',
      'X-Title': 'MasjidWeb AI Safe Update Repair',
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 16_000,
      temperature: 0.1,
    }),
  });

  const raw = await res.text();
  let parsed: {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
    model?: string;
  } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(
      res.ok ? 'OpenRouter returned invalid JSON' : `OpenRouter error (${res.status})`,
    );
  }

  if (!res.ok) {
    const message =
      parsed.error?.message ||
      (raw.trim().slice(0, 300) || `OpenRouter request failed (${res.status})`);
    throw new Error(message);
  }

  const reply = parsed.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    throw new Error('OpenRouter returned an empty response');
  }

  return {
    reply,
    model: parsed.model ?? options.model,
  };
}
