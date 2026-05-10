// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

// Tests for the pure heuristic getSlopScore() function in classifier.js.
// Heavy dependencies (sharp, @huggingface/transformers) are mocked so this
// runs without downloading models.

jest.mock('sharp');

const { getSlopScore } = require('../classifier');

// The function scores 0–40+. isAiSlop uses heuristic threshold at 16/16 = 1.0
// (full confidence). We test the score directly so the tests are resilient to
// threshold tuning without needing to change the test values.

describe('getSlopScore — AI slop phrases', () => {
  test('scores low for plain human sentence', () => {
    // Genuine human prose with no slop phrases — should score near zero
    const text = 'The server crashed overnight and we lost about three hours of logs. I checked the disk usage and found an old dump file taking up most of the space.';
    expect(getSlopScore(text)).toBeLessThanOrEqual(5);
  });

  test('scores high for dense classic LLM clichés', () => {
    const text = [
      'In this article we will delve into a comprehensive guide on how to',
      'leverage the power of AI. It is worth noting that this represents a',
      'transformative impact on the competitive landscape.',
      'Let\'s dive into the nuanced approach required to navigate the complexities.',
      'This underscores the paramount importance of best practices.',
    ].join(' ');
    expect(getSlopScore(text)).toBeGreaterThanOrEqual(10);
  });

  test('scores high for social-post LLM markers', () => {
    const text = 'Excited to share some actionable insights! Let me know in the comments below. Stay ahead of the curve with these key takeaways. Follow me for more!';
    expect(getSlopScore(text)).toBeGreaterThanOrEqual(8);
  });

  test('citation whitelist reduces score', () => {
    const withCitations = [
      'Language models have shown significant improvements [1, 2, 3, 4].',
      'Previous work (Smith, 2023) demonstrated similar results.',
      'As noted by Jones & Kim (2022), the performance gap narrows.',
      'This aligns with existing literature (Brown et al., 2021).',
      'Further evidence can be found in section 2.1 of the original paper.',
    ].join(' ');
    const withoutCitations = [
      'Language models have shown significant improvements across benchmarks.',
      'Previous work demonstrated similar results in evaluation.',
      'The performance gap narrows with scale.',
      'This aligns with existing literature on the topic.',
      'Further evidence can be found in related studies.',
    ].join(' ');
    expect(getSlopScore(withCitations)).toBeLessThan(getSlopScore(withoutCitations));
  });

  test('human signals (URLs, @mentions) reduce score relative to equivalent text without them', () => {
    // Use text that would score higher without signals, so the reduction is visible after clamping
    const withSignals = 'This comprehensive guide will delve into best practices. Check out https://github.com/example for details or @mention me. In conclusion, this highlights the importance of actionable insights.';
    const withoutSignals = 'This comprehensive guide will delve into best practices. Check out the docs for details. In conclusion, this highlights the importance of actionable insights.';
    expect(getSlopScore(withSignals)).toBeLessThan(getSlopScore(withoutSignals));
  });

  test('does not score short texts with a single cliché phrase', () => {
    // < 200 chars with only one phrase hit — short-text guard prevents false positives
    const text = 'Great question! The answer is simple.';
    expect(getSlopScore(text)).toBeLessThanOrEqual(4);
  });

  test('short LLM opener patterns add score', () => {
    // 2–5 sentences with opener patterns
    const text = 'Let me walk you through how this works. Here\'s why it matters. In today\'s world, digital tools are everywhere.';
    expect(getSlopScore(text)).toBeGreaterThanOrEqual(6);
  });
});
