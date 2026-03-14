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

  coverageThreshold: {
    './src/backend/server.ts': {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
    './src/backend/fetchPRdiff.ts': {
      statements: 80,
      branches: 70,
      functions: 85,
      lines: 80,
    },
    './src/backend/middleware/authenticate.ts': {
      statements: 65,
      branches: 50,
      functions: 100,
      lines: 65,
    },
    './src/backend/middleware/rateLimiter.ts': {
      statements: 75,
      branches: 60,
      functions: 60,
      lines: 75,
    },
    './src/backend/utils/tokenValidator.ts': {
      statements: 70,
      branches: 60,
      functions: 65,
      lines: 70,
    },
    './src/backend/license/routes.ts': {
      statements: 55,
      branches: 50,
      functions: 100,
      lines: 55,
    },
  },

  testTimeout: 30000,
};

export default config;
