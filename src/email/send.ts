import type { Env } from '../env';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
export interface SendResult {
  ok: boolean;
  providerId: string | null;
  error?: string;
}
export async function sendEmail(_env: Env, _msg: OutboundEmail): Promise<SendResult> {
  throw new Error('not implemented');
}
