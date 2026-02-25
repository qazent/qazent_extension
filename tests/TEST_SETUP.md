# Test Setup Guide for Custom Context Feature

## Required Dependencies

The custom context test suite requires additional testing libraries for React component testing.

### Install Testing Libraries

```bash
npm install --save-dev @testing-library/react @testing-library/jest-dom @testing-library/user-event jest-environment-jsdom
```

### Dependencies Explanation

- **@testing-library/react** - React component testing utilities
- **@testing-library/jest-dom** - Custom Jest matchers for DOM assertions
- **@testing-library/user-event** - Simulate user interactions
- **jest-environment-jsdom** - DOM environment for React tests

## Jest Configuration Updates

Update `jest.config.ts` to support React component testing:

```typescript
import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  
  // Use jsdom for React component tests, node for others
  testEnvironment: 'jsdom',

  // Look for test files (including .tsx)
  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],

  // Setup files
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  // Clear mocks between tests
  clearMocks: true,

  // Module name mapping for CSS/assets
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
  },

  // Transform files
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      }
    }]
  },

  // Optional: ignore build output
  modulePathIgnorePatterns: ['<rootDir>/dist/'],

  // Coverage configuration
  collectCoverageFrom: [
    'ai.ts',
    'server.ts',
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/index.tsx',
    '!src/settings/index.tsx'
  ]
};

export default config;
```

## Create Jest Setup File

Create `jest.setup.ts` in the root directory:

```typescript
import '@testing-library/jest-dom';

// Mock window.matchMedia (required for FluentUI components)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock IntersectionObserver (sometimes needed for UI components)
global.IntersectionObserver = class IntersectionObserver {
  constructor() {}
  disconnect() {}
  observe() {}
  takeRecords() { return []; }
  unobserve() {}
} as any;
```

## TypeScript Configuration

Ensure `tsconfig.json` includes test files:

```json
{
  "compilerOptions": {
    "jsx": "react",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "types": ["jest", "@testing-library/jest-dom", "node"]
  },
  "include": [
    "src/**/*",
    "*.ts",
    "*.tsx",
    "**/*.test.ts",
    "**/*.test.tsx"
  ]
}
```

## Running Tests

### All Tests
```bash
npm run test:jest
```

### Watch Mode
```bash
npm run test:jest -- --watch
```

### Specific Test File
```bash
npm run test:jest ai.customContext.test.ts
```

### With Coverage
```bash
npm run test:jest -- --coverage
```

### Only Custom Context Tests
```bash
npm run test:jest -- --testPathPattern="customContext|SettingsHub"
```

## Test Categories

### Unit Tests (No React)
These tests work with the current setup:
- ✅ `ai.customContext.test.ts` - AI module tests
- ✅ `customContext.integration.test.ts` - Integration tests

### React Component Tests (Require Setup)
These tests need React Testing Library:
- ⚠️ `src/services/backendClient.test.ts` - Backend client (no React, but needs fetch mock)
- ⚠️ `src/hub/PRAssistantHub.customContext.test.tsx` - React component tests
- ⚠️ `src/settings/SettingsHub.test.tsx` - React component tests

## Quick Start Without React Tests

If you want to run tests immediately without installing React Testing Library:

1. **Run non-React tests only:**
   ```bash
   npm run test:jest ai.customContext.test.ts
   npm run test:jest customContext.integration.test.ts
   ```

2. **Skip React component tests:**
   ```bash
   npm run test:jest -- --testPathIgnorePatterns="tsx"
   ```

## Troubleshooting

### Issue: "Cannot find module '@testing-library/react'"
**Solution:** Install testing libraries:
```bash
npm install --save-dev @testing-library/react @testing-library/jest-dom jest-environment-jsdom
```

### Issue: "ReferenceError: document is not defined"
**Solution:** Change testEnvironment to 'jsdom' in jest.config.ts

### Issue: "Unexpected token '<'" when importing JSX
**Solution:** Configure ts-jest transform with jsx: 'react'

### Issue: Tests timeout
**Solution:** Increase timeout in specific tests:
```typescript
jest.setTimeout(10000);
```

### Issue: "matchMedia is not a function"
**Solution:** Add matchMedia mock in jest.setup.ts (see above)

## Recommended Test Execution Order

1. **Phase 1: AI Module Tests** (No dependencies)
   ```bash
   npm run test:jest ai.customContext.test.ts
   ```

2. **Phase 2: Backend Client Tests** (Minimal dependencies)
   ```bash
   npm run test:jest src/services/backendClient.test.ts
   ```

3. **Phase 3: Integration Tests** (Combines AI + Backend)
   ```bash
   npm run test:jest customContext.integration.test.ts
   ```

4. **Phase 4: React Component Tests** (After installing libraries)
   ```bash
   npm install --save-dev @testing-library/react @testing-library/jest-dom jest-environment-jsdom
   npm run test:jest src/hub/PRAssistantHub.customContext.test.tsx
   npm run test:jest src/settings/SettingsHub.test.tsx
   ```

## CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/test.yml
- name: Install dependencies
  run: npm ci

- name: Run unit tests
  run: npm run test:jest -- --coverage

- name: Upload coverage
  uses: codecov/codecov-action@v3
```

## Expected Test Output

When fully set up and passing:

```
 PASS  ai.customContext.test.ts (6.234 s)
   AI Custom Context Integration
     with customContext parameter
       ✓ should include custom context in the prompt sent to AI (45 ms)
       ✓ should place custom context after PR details but before output format (12 ms)
       ...
     without customContext parameter
       ✓ should work without custom context (backward compatibility) (8 ms)
       ...

 PASS  src/services/backendClient.test.ts (2.156 s)
   Backend Client - Custom Context
     generateTestCases with customContext
       ✓ should include customContext in request body when provided (15 ms)
       ...

 PASS  src/hub/PRAssistantHub.customContext.test.tsx (3.421 s)
   PRAssistantHub - Custom Context Loading
     loadCustomContext function
       ✓ should load and combine project default and repo-specific context (89 ms)
       ...

 PASS  src/settings/SettingsHub.test.tsx (4.123 s)
   SettingsHub Component
     initialization
       ✓ should render without crashing (125 ms)
       ...

 PASS  customContext.integration.test.ts (5.678 s)
   Custom Context - End-to-End Integration
     Frontend to Backend to AI flow
       ✓ should pass custom context through entire pipeline (67 ms)
       ...

Test Suites: 5 passed, 5 total
Tests:       67 passed, 67 total
Snapshots:   0 total
Time:        22.145 s
```
