/**
 * The only place in the app that talks to the Anthropic API.
 *
 * Two rules hold everywhere downstream: the model never sees anything but free text
 * (§3.2), and a failed call is a warning on the run, never an exception that escapes.
 * `parse()` therefore returns a result union instead of throwing.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type * as z from 'zod/v4';
import type { EventConfig } from '../config';
import type { Env } from '../env';

/** Generous: these are single non-streaming calls and a truncated reply is a wasted run. */
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

export type LlmResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface LlmClient {
  readonly model: string;
  parse<S extends z.ZodType>(args: {
    schema: S;
    system: string;
    messages: Anthropic.MessageParam[];
  }): Promise<LlmResult<z.infer<S>>>;
}

/**
 * Returns null when no API key is configured — callers fall back to their deterministic
 * path rather than treating a missing key as an error.
 *
 * When AI_GATEWAY_URL is set it must already point at the gateway's Anthropic provider
 * path (…/anthropic); the SDK appends `/v1/messages` itself.
 */
export function createLlmClient(env: Env, config: EventConfig): LlmClient | null {
  const apiKey = (env.ANTHROPIC_API_KEY ?? '').trim();
  if (apiKey === '') return null;

  const baseURL = config.aiGatewayUrl?.replace(/\/+$/, '');
  const client = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    maxRetries: MAX_RETRIES,
    timeout: TIMEOUT_MS,
  });

  const model = config.anthropicModel;

  return {
    model,
    async parse<S extends z.ZodType>(args: {
      schema: S;
      system: string;
      messages: Anthropic.MessageParam[];
    }): Promise<LlmResult<z.infer<S>>> {
      try {
        const response = await client.messages.parse({
          model,
          max_tokens: MAX_TOKENS,
          system: args.system,
          messages: args.messages,
          output_config: { format: zodOutputFormat(args.schema) },
        });

        if (response.stop_reason === 'max_tokens') {
          return { ok: false, error: 'The model hit its output limit before finishing the JSON.' };
        }
        if (response.stop_reason === 'refusal') {
          return { ok: false, error: 'The model declined to answer this request.' };
        }
        const parsed = response.parsed_output;
        if (parsed === null || parsed === undefined) {
          return { ok: false, error: 'The reply did not match the required JSON shape.' };
        }
        return { ok: true, value: parsed };
      } catch (err) {
        return { ok: false, error: describeApiError(err) };
      }
    },
  };
}

/** Phrased for an organizer reading a warning on the runs page, not for a log grep. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'The Anthropic API rejected the key (401). Re-set it with `wrangler secret put ANTHROPIC_API_KEY`.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'The Anthropic API is rate limiting this account (429).';
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return `The Anthropic API did not respond within ${Math.round(TIMEOUT_MS / 1000)} seconds.`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API from the Worker.';
  }
  if (err instanceof Anthropic.APIError) {
    return `The Anthropic API returned ${err.status ?? 'an error'}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
