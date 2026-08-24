/**
 * The three messages this app sends. No DB access and no side effects: everything a
 * message needs arrives as a parameter, so a template can be eyeballed in isolation.
 *
 * Email clients do not load our stylesheet, so the HTML part is a plain single-column
 * document with inline styles, and the text part is written to be read on its own.
 */

import type { EventConfig } from '../config';
import { formatLocalDate, formatLocalDateTime } from '../lib/dates';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Only the fields a message needs. Deliberately not the whole participant row. */
export interface EmailRecipient {
  name: string | null;
  email: string;
  token: string;
}

export interface TeamAnnouncement {
  teamName: string;
  memberNames: string[];
  projectBrief: string;
}

export function participantLink(cfg: EventConfig, token: string): string {
  return `${cfg.publicOrigin}/r/${token}`;
}

/* ------------------------------------------------------------------ invite */

export function inviteEmail(recipient: EmailRecipient, cfg: EventConfig): RenderedEmail {
  const link = participantLink(cfg, recipient.token);
  const eventDay = formatLocalDate(cfg.eventDate, cfg.localUtcOffsetHours);
  const deadline = formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours);

  const opening = `${cfg.eventName} is on ${eventDay}, and this short form is how we build the teams — what you would like to work on, and roughly where you are with AI.`;
  const closing = `It takes about five minutes, and you can change your answers any time before ${deadline}. The link is yours alone, so please do not forward it.`;

  return {
    subject: `Your place at ${cfg.eventName}, ${eventDay}`,
    text: [
      greeting(recipient),
      opening,
      link,
      closing,
      signOff(cfg),
    ].join('\n\n'),
    html: shell(
      `Your place at ${cfg.eventName}`,
      [
        para(greeting(recipient)),
        para(opening),
        linkBlock(link, 'Open your form'),
        para(closing),
        para(signOff(cfg)),
      ].join('\n'),
      cfg,
    ),
  };
}

/* ------------------------------------------------------------------ reminder */

export function reminderEmail(recipient: EmailRecipient, cfg: EventConfig): RenderedEmail {
  const link = participantLink(cfg, recipient.token);
  const eventDay = formatLocalDate(cfg.eventDate, cfg.localUtcOffsetHours);
  const deadline = formatLocalDateTime(cfg.formDeadline, cfg.localUtcOffsetHours);

  const opening = `One more nudge about ${cfg.eventName} on ${eventDay} — your form is still open, and we cannot put you in a team until it is in.`;
  const closing = `It closes ${deadline}. If you cannot make the day, say so on the form and we will stop asking.`;

  return {
    subject: `Your ${cfg.eventName} form closes ${formatLocalDate(cfg.formDeadline, cfg.localUtcOffsetHours)}`,
    text: [greeting(recipient), opening, link, closing, signOff(cfg)].join('\n\n'),
    html: shell(
      `Your ${cfg.eventName} form is still open`,
      [
        para(greeting(recipient)),
        para(opening),
        linkBlock(link, 'Open your form'),
        para(closing),
        para(signOff(cfg)),
      ].join('\n'),
      cfg,
    ),
  };
}

/* ------------------------------------------------------------------ announcement */

export function teamAnnouncementEmail(
  recipient: EmailRecipient,
  team: TeamAnnouncement,
  cfg: EventConfig,
): RenderedEmail {
  const eventDay = formatLocalDate(cfg.eventDate, cfg.localUtcOffsetHours);
  const opening = `You are on ${team.teamName} for ${cfg.eventName} on ${eventDay}.`;
  const brief = team.projectBrief.trim() || 'Your team will agree the brief together on the day.';
  const closing = `Bring your laptop if you told us you could — it is what lets your team actually build something. See you on ${eventDay}.`;

  return {
    subject: `Your ${cfg.eventName} team: ${team.teamName}`,
    text: [
      greeting(recipient),
      opening,
      ['Your team:', ...team.memberNames.map((n) => `  - ${n}`)].join('\n'),
      `What you will be working on:\n${brief}`,
      closing,
      signOff(cfg),
    ].join('\n\n'),
    html: shell(
      `Your ${cfg.eventName} team`,
      [
        para(greeting(recipient)),
        para(opening),
        `<h2 style="margin:28px 0 8px;font-size:17px;font-weight:600;color:#181d1c;">${esc(team.teamName)}</h2>`,
        `<ul style="margin:0 0 20px;padding-left:22px;color:#181d1c;">${team.memberNames
          .map((n) => `<li style="margin:0 0 4px;">${esc(n)}</li>`)
          .join('')}</ul>`,
        `<h2 style="margin:24px 0 8px;font-size:17px;font-weight:600;color:#181d1c;">What you will be working on</h2>`,
        para(brief),
        para(closing),
        para(signOff(cfg)),
      ].join('\n'),
      cfg,
    ),
  };
}

/* ------------------------------------------------------------------ shared pieces */

function greeting(recipient: EmailRecipient): string {
  const first = (recipient.name ?? '').trim().split(/\s+/)[0] ?? '';
  return first ? `Hi ${first},` : 'Hi,';
}

function signOff(cfg: EventConfig): string {
  return `— the ${cfg.eventName} organizers`;
}

function para(textContent: string): string {
  return `<p style="margin:0 0 16px;">${esc(textContent).replace(/\n/g, '<br>')}</p>`;
}

/**
 * The URL is repeated as visible text underneath the button: plenty of clients strip
 * the styling, and people on locked-down machines copy links rather than click them.
 */
function linkBlock(link: string, label: string): string {
  return [
    `<p style="margin:0 0 12px;"><a href="${esc(link)}" style="display:inline-block;background:#0e5a5f;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;">${esc(label)}</a></p>`,
    `<p style="margin:0 0 20px;font-size:13px;color:#55605e;word-break:break-all;"><a href="${esc(link)}" style="color:#0e5a5f;">${esc(link)}</a></p>`,
  ].join('\n');
}

function shell(title: string, bodyHtml: string, cfg: EventConfig): string {
  const footer = cfg.organizerEmails[0]
    ? `You are on the invite list for ${cfg.eventName}. Questions: ${cfg.organizerEmails[0]}`
    : `You are on the invite list for ${cfg.eventName}.`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(title)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f7f5f1;">',
    '<div style="max-width:560px;margin:0 auto;padding:24px 20px 40px;background:#ffffff;',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
    'font-size:16px;line-height:1.6;color:#181d1c;">',
    bodyHtml,
    `<p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e4dfd7;font-size:13px;color:#55605e;">${esc(footer)}</p>`,
    '</div></body></html>',
  ].join('\n');
}

/**
 * Email HTML cannot go through JSX, so every interpolation is escaped by hand here.
 * Nothing in this file may concatenate an unescaped value into markup.
 */
function esc(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
