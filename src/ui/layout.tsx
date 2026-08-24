import type { FC, PropsWithChildren } from 'hono/jsx';
import { html, raw } from 'hono/html';

export interface LayoutProps {
  title: string;
  /** Extra <head> content, e.g. the Turnstile script. */
  head?: unknown;
  /** Deferred script URLs, loaded at the end of <body>. */
  scripts?: string[];
  bodyClass?: string;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title,
  head,
  scripts,
  bodyClass,
  children,
}) => (
  <>
    {raw('<!doctype html>')}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{title}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600&family=Public+Sans:wght@400;500;600;700&display=swap"
        />
        <link rel="stylesheet" href="/styles.css" />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%9B%A0%EF%B8%8F%3C/text%3E%3C/svg%3E"
        />
        {head}
      </head>
      <body class={bodyClass}>
        {children}
        {(scripts ?? []).map((src) => (
          <script src={src} defer></script>
        ))}
      </body>
    </html>
  </>
);

export const AdminNav: FC<{ active: string; email?: string }> = ({ active, email }) => {
  const items: { href: string; label: string; key: string }[] = [
    { href: '/admin', label: 'Dashboard', key: 'dashboard' },
    { href: '/admin/participants', label: 'Participants', key: 'participants' },
    { href: '/admin/invites', label: 'Invite list', key: 'invites' },
    { href: '/admin/runs', label: 'Grouping runs', key: 'runs' },
    { href: '/admin/email', label: 'Email', key: 'email' },
    { href: '/teams', label: 'Published teams', key: 'teams' },
  ];
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <a class="wordmark" href="/admin">
          AI Builder Day
        </a>
        <nav aria-label="Admin sections">
          <ul class="navlist">
            {items.map((it) => (
              <li>
                <a href={it.href} class={it.key === active ? 'nav-current' : ''} aria-current={it.key === active ? 'page' : undefined}>
                  {it.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {email ? <span class="whoami" title="Signed in via Cloudflare Access">{email}</span> : null}
      </div>
    </header>
  );
};

export interface AdminPageProps extends LayoutProps {
  active: string;
  email?: string;
  heading: string;
  lede?: string;
  actions?: unknown;
}

export const AdminPage: FC<PropsWithChildren<AdminPageProps>> = ({
  title,
  head,
  scripts,
  active,
  email,
  heading,
  lede,
  actions,
  children,
}) => (
  <Layout title={title} head={head} scripts={scripts} bodyClass="admin">
    <a class="skip" href="#main">
      Skip to content
    </a>
    <AdminNav active={active} email={email} />
    <main id="main" class="wrap">
      <div class="page-head">
        <div>
          <h1>{heading}</h1>
          {lede ? <p class="lede">{lede}</p> : null}
        </div>
        {actions ? <div class="page-actions">{actions}</div> : null}
      </div>
      {children}
    </main>
  </Layout>
);

export type CalloutTone = 'info' | 'good' | 'warn' | 'bad';

/**
 * Colour is never the only carrier of meaning here — every callout also has a text
 * prefix and an icon glyph.
 */
export const Callout: FC<PropsWithChildren<{ tone?: CalloutTone; title?: string }>> = ({
  tone = 'info',
  title,
  children,
}) => {
  const glyph: Record<CalloutTone, string> = { info: 'ℹ', good: '✓', warn: '!', bad: '✕' };
  const word: Record<CalloutTone, string> = {
    info: 'Note',
    good: 'Done',
    warn: 'Check this',
    bad: 'Problem',
  };
  return (
    <div class={`callout callout-${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <span class="callout-glyph" aria-hidden="true">
        {glyph[tone]}
      </span>
      <div class="callout-body">
        <strong class="callout-title">{title ?? word[tone]}</strong>
        <div>{children}</div>
      </div>
    </div>
  );
};

export const Card: FC<PropsWithChildren<{ title?: string; sub?: string; class?: string }>> = ({
  title,
  sub,
  class: cls,
  children,
}) => (
  <section class={`card ${cls ?? ''}`}>
    {title ? (
      <div class="card-head">
        <h2>{title}</h2>
        {sub ? <p class="muted">{sub}</p> : null}
      </div>
    ) : null}
    {children}
  </section>
);

export const Stat: FC<{ value: string | number; label: string; hint?: string; big?: boolean }> = ({
  value,
  label,
  hint,
  big,
}) => (
  <div class={`stat ${big ? 'stat-big' : ''}`}>
    <div class="stat-value">{value}</div>
    <div class="stat-label">{label}</div>
    {hint ? <div class="stat-hint">{hint}</div> : null}
  </div>
);

/** An empty state is an invitation: it always carries the next action. */
export const EmptyState: FC<{ title: string; body: string; action?: unknown }> = ({ title, body, action }) => (
  <div class="empty">
    <h3>{title}</h3>
    <p>{body}</p>
    {action ? <div class="empty-action">{action}</div> : null}
  </div>
);

/** Inline JSON for a client script, escaped so a "</script>" inside data cannot break out. */
export function jsonScript(id: string, data: unknown) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  return html`<script type="application/json" id="${id}">
    ${raw(payload)}
  </script>`;
}
