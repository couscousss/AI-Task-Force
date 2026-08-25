import { describe, expect, it } from 'vitest';
import { REMEMBER_COOKIE, forgetCookie, rememberCookie, rememberedToken } from '../src/lib/remember';

const TOKEN = 'd1b9886bda8b431597975b85d4f8c3a3';

describe('rememberedToken', () => {
  it('reads the token from a header containing only our cookie', () => {
    expect(rememberedToken(`${REMEMBER_COOKIE}=${TOKEN}`)).toBe(TOKEN);
  });

  it('finds it among other cookies, in any position', () => {
    expect(rememberedToken(`a=1; ${REMEMBER_COOKIE}=${TOKEN}; z=2`)).toBe(TOKEN);
    expect(rememberedToken(`${REMEMBER_COOKIE}=${TOKEN}; z=2`)).toBe(TOKEN);
    expect(rememberedToken(`a=1; ${REMEMBER_COOKIE}=${TOKEN}`)).toBe(TOKEN);
  });

  it('tolerates the spacing clients actually send', () => {
    expect(rememberedToken(`a=1;${REMEMBER_COOKIE}=${TOKEN}`)).toBe(TOKEN);
    expect(rememberedToken(`a=1;    ${REMEMBER_COOKIE}=${TOKEN}   `)).toBe(TOKEN);
  });

  it('is null when there is no cookie header at all', () => {
    expect(rememberedToken(null)).toBeNull();
    expect(rememberedToken(undefined)).toBeNull();
    expect(rememberedToken('')).toBeNull();
  });

  it('is null when our cookie is absent', () => {
    expect(rememberedToken('session=abc; theme=dark')).toBeNull();
  });

  /**
   * The value goes straight into a URL path, so anything that is not token-shaped has to
   * come back as null rather than be passed along to be looked up or redirected to.
   */
  it('rejects values that are not token-shaped', () => {
    for (const bad of [
      '../../etc/passwd',
      'has spaces',
      'semi;colon',
      '<script>alert(1)</script>',
      'short',
      'a'.repeat(200),
      '',
    ]) {
      expect(rememberedToken(`${REMEMBER_COOKIE}=${encodeURIComponent(bad)}`)).toBeNull();
    }
  });

  it('does not throw on a malformed percent-escape', () => {
    expect(rememberedToken(`${REMEMBER_COOKIE}=%E0%A4%A`)).toBeNull();
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    expect(rememberedToken(`not_${REMEMBER_COOKIE}=${TOKEN}`)).toBeNull();
  });

  it('round-trips what rememberCookie writes', () => {
    const header = rememberCookie(TOKEN, 'https://example.com/join');
    const value = header.split(';')[0] ?? '';
    expect(rememberedToken(value)).toBe(TOKEN);
  });
});

describe('rememberCookie', () => {
  it('is HttpOnly and SameSite=Lax, so no script reads it and it is not sent cross-site', () => {
    const header = rememberCookie(TOKEN, 'https://example.com/join');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
  });

  it('is Secure over https', () => {
    expect(rememberCookie(TOKEN, 'https://example.com/join')).toContain('Secure');
  });

  /** Secure would stop the cookie being set at all on the http that `wrangler dev` serves. */
  it('drops Secure over http, so local development still works', () => {
    expect(rememberCookie(TOKEN, 'http://localhost:8787/join')).not.toContain('Secure');
  });

  it('falls back to Secure when the URL cannot be parsed', () => {
    expect(rememberCookie(TOKEN, 'not a url')).toContain('Secure');
  });

  it('carries an expiry rather than lasting for ever', () => {
    expect(rememberCookie(TOKEN, 'https://example.com/join')).toMatch(/Max-Age=\d+/);
  });
});

describe('forgetCookie', () => {
  it('expires the cookie immediately', () => {
    expect(forgetCookie('https://example.com/join')).toContain('Max-Age=0');
  });

  /** A clear that does not match the original attributes leaves the old cookie in place. */
  it('matches the path the cookie was set on', () => {
    expect(forgetCookie('https://example.com/join')).toContain('Path=/');
  });

  it('mirrors the Secure decision so the clear applies in both environments', () => {
    expect(forgetCookie('https://example.com/join')).toContain('Secure');
    expect(forgetCookie('http://localhost:8787/join')).not.toContain('Secure');
  });
});
