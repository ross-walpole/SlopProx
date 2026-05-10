// SPDX-FileCopyrightText: 2026 Ross Walpole <ross.walpole@gmail.com>
// SPDX-License-Identifier: GPL-3.0-only

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  // Mock Electron so tests can require modules that depend on it
  moduleNameMapper: {
    '^electron$': '<rootDir>/__mocks__/electron.js',
  },
};
