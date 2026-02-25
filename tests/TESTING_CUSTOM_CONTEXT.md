# Custom Context Feature - Test Suite Documentation

## Overview

This document describes the comprehensive test suite for the Custom Context feature in the Azure DevOps PR Assistant extension.

## Test Files

### 1. `ai.customContext.test.ts`
**Purpose:** Tests AI module integration with custom context

**Coverage:**
- ✅ Custom context inclusion in AI prompts
- ✅ Correct positioning of context in prompt (after PR data, before output format)
- ✅ Multi-line context handling
- ✅ Special characters in context
- ✅ Whitespace trimming
- ✅ Backward compatibility (works without context)
- ✅ Empty/undefined/whitespace-only context handling
- ✅ Context persists through retry logic
- ✅ Error propagation with context present

**Key Test Scenarios:**
```typescript
// Context is included in prompt
it('should include custom context in the prompt sent to AI')

// Context positioned correctly
it('should place custom context after PR details but before output format instructions')

// Backward compatibility
it('should work without custom context (backward compatibility)')

// Edge cases
it('should not include custom context when only whitespace')
```

### 2. `src/services/backendClient.test.ts`
**Purpose:** Tests backend client API calls with custom context

**Coverage:**
- ✅ Custom context included in POST request body
- ✅ Custom context as optional parameter
- ✅ Empty string context handling
- ✅ Multi-line context in JSON body
- ✅ Special characters in request body
- ✅ Error handling with context (400, 500, timeout, network)
- ✅ Backward compatibility (4-parameter call)

**Key Test Scenarios:**
```typescript
// Context in request
it('should include customContext in request body when provided')

// Optional parameter
it('should include customContext as undefined when not provided')

// Error handling
it('should handle 500 error with customContext')
it('should handle timeout with customContext')
```

### 3. `src/hub/PRAssistantHub.customContext.test.tsx`
**Purpose:** Tests context loading in PR Assistant component

**Coverage:**
- ✅ Loading project default context
- ✅ Loading repository-specific context
- ✅ Combining project + repo contexts
- ✅ Missing project default handling
- ✅ Missing repo context handling
- ✅ Both contexts missing
- ✅ Empty contextText handling
- ✅ Whitespace-only context handling
- ✅ Context loading failure doesn't break PR loading
- ✅ Correct Extension Data Service calls
- ✅ Context combination with double newline separator
- ✅ Trimming individual context parts

**Key Test Scenarios:**
```typescript
// Context combination
it('should load and combine project default and repo-specific context')

// Graceful degradation
it('should not fail PR loading if context loading fails')

// Empty context handling
it('should handle both contexts missing')
it('should handle whitespace-only contextText')
```

### 4. `src/settings/SettingsHub.test.tsx`
**Purpose:** Tests Settings Hub UI component

**Coverage:**
- ✅ Component initialization
- ✅ Project information loading
- ✅ Repository dropdown population
- ✅ Context loading (existing/empty)
- ✅ Save functionality with validation
- ✅ Success/error message display
- ✅ Clear button functionality
- ✅ Loading states
- ✅ Disabled states during operations
- ✅ Timestamp inclusion in saved documents
- ✅ Extension Data Service integration
- ✅ Error handling (network, API failures)

**Key Test Scenarios:**
```typescript
// Initialization
it('should load repositories on mount')
it('should load project default context on mount')

// Save
it('should save project default context')
it('should show success message after saving')
it('should show error message on save failure')

// UI states
it('should disable save button while saving')
it('should show loading state initially')
```

### 5. `customContext.integration.test.ts`
**Purpose:** End-to-end integration tests

**Coverage:**
- ✅ Full pipeline: Frontend → Backend → AI
- ✅ Context preservation through entire flow
- ✅ Combined context scenarios
- ✅ Very long context handling
- ✅ Special characters across layers
- ✅ Error propagation through layers
- ✅ Context positioning in final prompt
- ✅ Retry logic with context
- ✅ Backward compatibility throughout

**Key Test Scenarios:**
```typescript
// E2E flow
it('should pass custom context through entire pipeline')

// Combined contexts
it('should handle project default + repo-specific context combination')

// Error propagation
it('should propagate AI errors to frontend')
it('should propagate backend errors to frontend')

// Context positioning
it('should place custom context after PR metadata and before output instructions')
```

## Running Tests

### Run All Tests
```bash
npm run test:jest
```

### Run Custom Context Tests Only
```bash
npm run test:jest -- --testPathPattern="customContext"
```

### Run Specific Test File
```bash
npm run test:jest ai.customContext.test.ts
npm run test:jest src/services/backendClient.test.ts
npm run test:jest src/hub/PRAssistantHub.customContext.test.tsx
npm run test:jest src/settings/SettingsHub.test.tsx
npm run test:jest customContext.integration.test.ts
```

### Run with Coverage
```bash
npm run test:jest -- --coverage --collectCoverageFrom='["ai.ts","src/services/backendClient.ts","src/hub/PRAssistantHub.tsx","src/settings/SettingsHub.tsx"]'
```

## Test Coverage Summary

| Module | Coverage Area | Test Count |
|--------|---------------|------------|
| AI Module | Custom context in prompts | 14 tests |
| Backend Client | API integration | 11 tests |
| PRAssistantHub | Context loading | 12 tests |
| SettingsHub | UI & save operations | 20+ tests |
| Integration | End-to-end flows | 10 tests |

**Total: 67+ test cases**

## Key Testing Principles

### 1. Graceful Degradation
- Custom context is optional throughout
- Missing context doesn't break existing functionality
- Empty/whitespace context handled correctly

### 2. Error Isolation
- Context loading errors don't prevent PR loading
- Backend errors properly propagated to frontend
- Clear error messages for users

### 3. Data Integrity
- Context trimmed and combined correctly
- Special characters preserved
- Whitespace normalized

### 4. Backward Compatibility
- All functions work without custom context parameter
- Existing tests continue to pass
- No breaking changes to API contracts

## Mock Patterns Used

### Azure DevOps SDK
```typescript
jest.mock('azure-devops-extension-sdk');
(SDK.init as jest.Mock).mockResolvedValue(undefined);
(SDK.getService as jest.Mock).mockImplementation(...);
```

### Extension Data Service
```typescript
const mockGetDocument = jest.fn();
const mockSetDocument = jest.fn();
mockGetExtensionDataManager.mockResolvedValue({
  getDocument: mockGetDocument,
  setDocument: mockSetDocument
});
```

### Google GenAI
```typescript
const mockGenerateContent = jest.fn();
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent }
  }))
}));
```

### Fetch API
```typescript
global.fetch = jest.fn();
(global.fetch as jest.Mock).mockResolvedValue({
  ok: true,
  json: async () => mockResponse
});
```

## Expected Test Results

When all tests pass, you should see:
```
PASS  ai.customContext.test.ts
PASS  src/services/backendClient.test.ts
PASS  src/hub/PRAssistantHub.customContext.test.tsx
PASS  src/settings/SettingsHub.test.tsx
PASS  customContext.integration.test.ts

Test Suites: 5 passed, 5 total
Tests:       67 passed, 67 total
Snapshots:   0 total
Time:        X.XXXs
```

## Troubleshooting

### Tests Timing Out
If tests timeout, increase Jest timeout:
```typescript
jest.setTimeout(10000); // 10 seconds
```

### Module Not Found Errors
Ensure tsconfig.json includes test files:
```json
{
  "include": ["src/**/*", "*.ts", "*.tsx"]
}
```

### Mock Not Working
Clear mocks between tests:
```typescript
beforeEach(() => {
  jest.clearAllMocks();
});
```

## Future Test Enhancements

1. **Visual regression tests** for SettingsHub UI
2. **Performance tests** for large context handling (10KB+)
3. **Accessibility tests** for Settings page
4. **E2E tests** with real Azure DevOps Extension Data Service (integration environment)
5. **Load tests** for concurrent context loading

## Related Documentation

- [Planning Document](planning.md) - Feature specification
- [Research Document](research.md) - Implementation research
- [Jest Configuration](jest.config.ts) - Test runner setup
