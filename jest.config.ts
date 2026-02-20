import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Look for test files
  testMatch: ['**/?(*.)+(spec|test).ts'],

  // Clear mocks between tests
  clearMocks: true,

  // Support ESM if your project uses it
  extensionsToTreatAsEsm: ['.ts'],

  // ts-jest config
  globals: {
    'ts-jest': {
      useESM: true, // set to false if your project is CommonJS
    },
  },

  // Optional: ignore build output
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
};

export default config;