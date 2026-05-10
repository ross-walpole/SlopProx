// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// Tests for pac.js — evaluates the generated PAC function string directly
// to verify routing decisions without running the full proxy.

const { generatePAC } = require('../pac');

const PORT = 8081;

function evalPAC(port, bypassDomains) {
  const pacStr = generatePAC(port, bypassDomains);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${pacStr})`)();
}

describe('PAC routing — always DIRECT', () => {
  let FindProxyForURL;

  beforeAll(() => {
    FindProxyForURL = evalPAC(PORT, []);
  });

  test('static JS assets go DIRECT', () => {
    expect(FindProxyForURL('https://example.com/app.min.js', 'example.com')).toBe('DIRECT');
    expect(FindProxyForURL('https://example.com/styles.css', 'example.com')).toBe('DIRECT');
    expect(FindProxyForURL('https://cdn.example.com/logo.png', 'cdn.example.com')).toBe('DIRECT');
    expect(FindProxyForURL('https://example.com/font.woff2', 'example.com')).toBe('DIRECT');
  });

  test('API path segments go DIRECT', () => {
    expect(FindProxyForURL('https://example.com/api/v1/posts', 'example.com')).toBe('DIRECT');
    expect(FindProxyForURL('https://example.com/api/graphql/query', 'example.com')).toBe('DIRECT');
    expect(FindProxyForURL('https://example.com/auth/token', 'example.com')).toBe('DIRECT');
  });

  test('API query parameters go DIRECT', () => {
    expect(FindProxyForURL('https://example.com/search?q=hello', 'example.com')).toBe('DIRECT');
    expect(FindProxyForURL('https://example.com/posts?page=2', 'example.com')).toBe('DIRECT');
  });

  test('huggingface model downloads go DIRECT', () => {
    expect(FindProxyForURL('https://huggingface.co/model.onnx', 'huggingface.co')).toBe('DIRECT');
    expect(FindProxyForURL('https://cdn-lfs.huggingface.co/model', 'cdn-lfs.huggingface.co')).toBe('DIRECT');
  });

  test('websocket URLs go DIRECT', () => {
    expect(FindProxyForURL('wss://example.com/socket', 'example.com')).toBe('DIRECT');
    expect(FindProxyForURL('ws://example.com/socket', 'example.com')).toBe('DIRECT');
  });

  test('Windows system services go DIRECT', () => {
    expect(FindProxyForURL('https://bing.com/', 'bing.com')).toBe('DIRECT');
    expect(FindProxyForURL('https://discord.com/channels/123', 'discord.com')).toBe('DIRECT');
  });

  test('non-HTTP schemes go DIRECT', () => {
    expect(FindProxyForURL('ftp://example.com/file', 'example.com')).toBe('DIRECT');
  });
});

describe('PAC routing — through proxy', () => {
  let FindProxyForURL;

  beforeAll(() => {
    FindProxyForURL = evalPAC(PORT, []);
  });

  const PROXY = `PROXY 127.0.0.1:${PORT}`;

  test('plain HTML page navigations go through proxy', () => {
    expect(FindProxyForURL('https://example.com/', 'example.com')).toBe(PROXY);
    expect(FindProxyForURL('https://news.ycombinator.com/', 'news.ycombinator.com')).toBe(PROXY);
    expect(FindProxyForURL('https://reddit.com/r/programming', 'reddit.com')).toBe(PROXY);
  });

  test('YouTube watch pages go through proxy', () => {
    expect(FindProxyForURL('https://www.youtube.com/watch?v=abc123', 'www.youtube.com')).toBe(PROXY);
    expect(FindProxyForURL('https://www.youtube.com/shorts/abc', 'www.youtube.com')).toBe(PROXY);
  });
});

describe('PAC routing — user bypass list', () => {
  test('bypassed domain goes DIRECT even for HTML pages', () => {
    const FindProxyForURL = evalPAC(PORT, ['app.example.com']);
    expect(FindProxyForURL('https://app.example.com/', 'app.example.com')).toBe('DIRECT');
  });

  test('non-bypassed sibling domain still goes through proxy', () => {
    const FindProxyForURL = evalPAC(PORT, ['app.example.com']);
    const result = FindProxyForURL('https://www.example.com/', 'www.example.com');
    expect(result).toBe(`PROXY 127.0.0.1:${PORT}`);
  });

  test('localhost and 127.0.0.1 are excluded from bypass lines (handled by OS)', () => {
    const pacStr = generatePAC(PORT, ['localhost', '127.0.0.1', 'app.example.com']);
    // The PAC string should NOT contain bypass lines for localhost/127.0.0.1
    // (they match IP literals and would conflict with the server's own port)
    expect(pacStr).not.toMatch(/if \(lh === 'localhost'\)/);
    expect(pacStr).not.toMatch(/if \(lh === '127\.0\.0\.1'\)/);
    // But the user domain should be present
    expect(pacStr).toContain("if (lh === 'app.example.com') return 'DIRECT'");
  });
});
