/** Default repair model (override with OPENROUTER_MODEL). Use vars for Opus on high-risk only. */
export const DEFAULT_AI_REPAIR_MODEL = 'anthropic/claude-sonnet-4';
export const DEFAULT_PREMIUM_AI_REPAIR_MODEL = 'anthropic/claude-opus-4.1';

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
  finishReason: string | null;
};

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:[\w-]+)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) return fenced[1].trim();
  const inline = trimmed.match(/```(?:[\w-]+)?\s*\n([\s\S]*?)```/);
  if (inline) return inline[1].trim();
  const leadingFence = trimmed.match(/^```(?:[\w-]+)?\s*\n([\s\S]*)$/);
  if (leadingFence) return leadingFence[1].trim();
  return trimmed;
}

export function assertNoConflictMarkers(content: string, filePath: string): void {
  if (/^<<<<<<<|^=======|^>>>>>>>|^\|\|\|\|\|\|\|/m.test(content)) {
    throw new Error(`Resolved file still contains conflict markers: ${filePath}`);
  }
}

const BRACE_BALANCED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** Strip strings, template literals, regex and comments so brace counting is reliable. */
function stripNonCode(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Detect a structurally incomplete (truncated) code file by checking that the
 * three delimiter pairs balance once strings/comments are removed. This is a
 * defensive guard against silently committing a partial LLM resolution.
 * Returns an error message if unbalanced, otherwise null.
 */
export function checkBalancedDelimiters(content: string, filePath: string): string | null {
  if (!BRACE_BALANCED_EXTENSIONS.some((ext) => filePath.endsWith(ext))) {
    return null;
  }
  const code = stripNonCode(content);
  const pairs: Array<[string, string, string]> = [
    ['{', '}', 'braces'],
    ['(', ')', 'parentheses'],
    ['[', ']', 'brackets'],
  ];
  for (const [open, close, label] of pairs) {
    const opened = code.split(open).length - 1;
    const closed = code.split(close).length - 1;
    if (opened !== closed) {
      return `Resolved ${filePath} has unbalanced ${label} (${opened} ${open} vs ${closed} ${close}) — likely a truncated or malformed AI repair.`;
    }
  }
  return null;
}

export function assertBalancedDelimiters(content: string, filePath: string): void {
  const problem = checkBalancedDelimiters(content, filePath);
  if (problem) {
    throw new Error(problem);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestOpenRouterRepair(
  options: OpenRouterRepairOptions,
  maxAttempts = 3,
): Promise<OpenRouterRepairResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL?.trim() || 'https://github.com/mywebmasteruk/ycode-mw-tenant',
          'X-Title': process.env.OPENROUTER_APP_NAME?.trim() || 'MasjidWeb AI Safe Update Repair',
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
        choices?: { message?: { content?: string }; finish_reason?: string }[];
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

      const finishReason = parsed.choices?.[0]?.finish_reason ?? null;
      // A truncated completion (hit max_tokens) yields a partial file with no
      // conflict markers, which would silently pass validation and break the
      // build. Reject it so the caller retries with more tokens or fails loudly.
      if (finishReason === 'length') {
        throw new Error(
          'OpenRouter response was truncated (finish_reason=length). ' +
            'The output hit the token limit; increase maxTokens or resolve this file by hunk.',
        );
      }

      return {
        reply,
        model: parsed.model ?? options.model,
        finishReason,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        console.warn(
          `OpenRouter attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying…`,
        );
        await sleep(attempt * 5000);
      }
    }
  }

  throw lastError ?? new Error('OpenRouter request failed');
}
