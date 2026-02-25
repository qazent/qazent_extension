#!/bin/bash

# Test execution script for Custom Context feature
# This script runs tests in phases based on dependencies

echo "=========================================="
echo "Custom Context Feature - Test Suite"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Phase 1: Tests that work immediately (no additional dependencies)
echo -e "${GREEN}Phase 1: Core Module Tests (No Extra Dependencies)${NC}"
echo "Running AI module custom context tests..."
npm run test:jest -- ai.customContext.test.ts
AI_RESULT=$?

echo ""
echo "Running integration tests..."
npm run test:jest -- customContext.integration.test.ts
INTEGRATION_RESULT=$?

# Phase 2: Backend client tests (need fetch mock - already available)
echo ""
echo -e "${GREEN}Phase 2: Backend Client Tests${NC}"
echo "Running backend client tests..."
npm run test:jest -- src/services/backendClient.test.ts
BACKEND_RESULT=$?

# Phase 3: Check if React Testing Library is installed
echo ""
echo -e "${YELLOW}Phase 3: React Component Tests${NC}"
if npm list @testing-library/react > /dev/null 2>&1; then
    echo "React Testing Library found - running component tests..."
    npm run test:jest -- src/hub/PRAssistantHub.customContext.test.tsx
    PRHUB_RESULT=$?
    
    npm run test:jest -- src/settings/SettingsHub.test.tsx
    SETTINGS_RESULT=$?
else
    echo -e "${RED}React Testing Library not installed.${NC}"
    echo "To run React component tests, install dependencies:"
    echo ""
    echo "  npm install --save-dev @testing-library/react @testing-library/jest-dom jest-environment-jsdom"
    echo ""
    echo "Then update jest.config.ts (see TEST_SETUP.md for details)"
    PRHUB_RESULT=0
    SETTINGS_RESULT=0
fi

# Summary
echo ""
echo "=========================================="
echo "Test Results Summary"
echo "=========================================="
echo ""

if [ $AI_RESULT -eq 0 ]; then
    echo -e "${GREEN}✓${NC} AI Module Tests: PASSED"
else
    echo -e "${RED}✗${NC} AI Module Tests: FAILED"
fi

if [ $INTEGRATION_RESULT -eq 0 ]; then
    echo -e "${GREEN}✓${NC} Integration Tests: PASSED"
else
    echo -e "${RED}✗${NC} Integration Tests: FAILED"
fi

if [ $BACKEND_RESULT -eq 0 ]; then
    echo -e "${GREEN}✓${NC} Backend Client Tests: PASSED"
else
    echo -e "${RED}✗${NC} Backend Client Tests: FAILED"
fi

if npm list @testing-library/react > /dev/null 2>&1; then
    if [ $PRHUB_RESULT -eq 0 ]; then
        echo -e "${GREEN}✓${NC} PRAssistantHub Tests: PASSED"
    else
        echo -e "${RED}✗${NC} PRAssistantHub Tests: FAILED"
    fi
    
    if [ $SETTINGS_RESULT -eq 0 ]; then
        echo -e "${GREEN}✓${NC} SettingsHub Tests: PASSED"
    else
        echo -e "${RED}✗${NC} SettingsHub Tests: FAILED"
    fi
else
    echo -e "${YELLOW}○${NC} PRAssistantHub Tests: SKIPPED (install dependencies)"
    echo -e "${YELLOW}○${NC} SettingsHub Tests: SKIPPED (install dependencies)"
fi

echo ""
echo "=========================================="

# Exit with error if any required tests failed
if [ $AI_RESULT -ne 0 ] || [ $INTEGRATION_RESULT -ne 0 ] || [ $BACKEND_RESULT -ne 0 ]; then
    exit 1
fi

exit 0
