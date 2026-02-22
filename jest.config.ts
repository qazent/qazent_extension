import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',

  testEnvironment: 'jsdom',

  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],

  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  clearMocks: true,

  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      },
    ],
  },

  modulePathIgnorePatterns: ['<rootDir>/dist/'],

  collectCoverageFrom: [
    'ai.ts',
    'server.ts',
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/index.tsx',
    '!src/settings/index.tsx',
  ],

  // ⭐ Add this:
  testTimeout: 30000,
};

export default config;