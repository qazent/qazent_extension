import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',

  testEnvironment: 'jsdom',

  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],

  setupFilesAfterEnv: ['tests/jest.setup.ts'],

  clearMocks: true,

  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json'
      }
    ]
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

  testTimeout: 30000,
};

export default config;