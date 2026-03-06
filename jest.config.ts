import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  rootDir: '.',

  testEnvironment: 'jsdom',

  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],

  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.ts'],

  clearMocks: true,

  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    '^@logger$': '<rootDir>/src/backend/utils/logger',
    '^azure-devops-extension-sdk$': '<rootDir>/tests/utils/azure-devops-mock.ts',
    '^azure-devops-extension-api$': '<rootDir>/tests/utils/azure-devops-api-mock.ts',
    '^azure-devops-extension-api/Git$': '<rootDir>/tests/utils/azure-devops-api-git-mock.ts',
  },

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tests/tsconfig.test.json',
      },
    ],
  },

  modulePathIgnorePatterns: ['<rootDir>/dist/'],

  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/index.tsx',
    '!src/settings/index.tsx',
  ],

  testTimeout: 30000,
};

export default config;
