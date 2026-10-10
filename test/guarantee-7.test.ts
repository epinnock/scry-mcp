/**
 * log-core-hardening G7 (S6 coverage), mcp half.
 *   guarantee-7a  an error event keeps only the SAFE_HEADERS allow-list of request headers;
 *                 X-Scry-Caller, X-Api-Key, Cookie and any custom header never leave the Worker
 *                 (flutter-capture F44: error events used a deny-list).
 */
import { describe, expect, it } from 'vitest';
import { scrubEvent } from '../src/lib/sentry-scrub';

const SECRETS = ['SECRETCALLER', 'SECRETAPIKEY', 'SECRETCOOKIE', 'SECRETCUSTOM', 'SECRETFORWARD'];
const REQUEST_ID = '01M3EQG44Y0J8F2K6ZP9RX1T7C';

function requestHeaders(): Record<string, string> {
  return {
    'X-Scry-Caller': 'SECRETCALLER',
    'X-Api-Key': 'SECRETAPIKEY',
    Cookie: 'session=SECRETCOOKIE',
    'X-Foo': 'SECRETCUSTOM',
    'X-Forwarded-For': 'SECRETFORWARD',
    'Content-Type': 'application/json',
    'User-Agent': 'scry-client/1.0',
    Host: 'mcp.example',
    Accept: 'application/json',
    'Content-Length': '12',
    'x-scry-request-id': REQUEST_ID,
  };
}

const SAFE = ['accept', 'content-length', 'content-type', 'host', 'user-agent', 'x-scry-request-id'];

describe('guarantee-7a: only SAFE_HEADERS survive on error events', () => {
  it('keeps none of X-Scry-Caller, X-Api-Key, Cookie, a custom header', () => {
    const event = scrubEvent({ request: { url: 'https://mcp.example/x', headers: requestHeaders() } });
    expect(Object.keys(event.request.headers).map((h) => h.toLowerCase()).sort()).toEqual(SAFE);
    expect(JSON.stringify(event)).not.toMatch(new RegExp(SECRETS.join('|')));
    // The request id is the join key and survives.
    expect(event.request.headers['x-scry-request-id']).toBe(REQUEST_ID);
  });

  it('header names match case-insensitively, whatever the casing', () => {
    const event = scrubEvent({ request: { headers: { 'x-scry-caller': 'SECRETCALLER', 'X-FOO': 'SECRETCUSTOM', 'CONTENT-TYPE': 'text/plain' } } });
    expect(event.request.headers).toEqual({ 'CONTENT-TYPE': 'text/plain' });
  });

  it('an event with no request block, or no headers, still scrubs without throwing', () => {
    expect(scrubEvent({ message: 'boom' }).message).toBe('boom');
    expect(scrubEvent({ request: {} }).request).toEqual({});
  });
});
