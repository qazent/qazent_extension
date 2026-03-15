import * as path from 'path';
import * as realFs from 'fs';

describe('loadSystemPrompt', () => {
  const promptPath = path.join(process.cwd(), 'system-prompt.txt');
  const realPrompt = realFs.readFileSync(promptPath, 'utf-8');

  beforeEach(() => {
    jest.resetModules();
  });

  it('returns a shorter retry prompt for the current system prompt file', async () => {
    jest.doMock('fs', () => ({
      readFileSync: jest.fn().mockReturnValue(realPrompt),
    }));

    jest.doMock('../src/backend/utils/logger', () => ({
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    }));

    jest.doMock('@google/genai', () => ({
      GoogleGenAI: jest.fn(),
    }));

    const { loadSystemPrompt } = await import('../src/backend/ai');

    const fullPrompt = loadSystemPrompt(false);
    const shortPrompt = loadSystemPrompt(true);

    expect(fullPrompt).toContain('REPOSITORY CONTEXT (IF PROVIDED)');
    expect(fullPrompt).toContain('PURPOSE & SCOPE OF CHANGE (DEPTH REQUIREMENTS)');
    expect(fullPrompt).toContain('Before producing the final answer, think privately');

    expect(shortPrompt.length).toBeLessThan(fullPrompt.length);
    expect(shortPrompt).not.toContain('REPOSITORY CONTEXT (IF PROVIDED)');
    expect(shortPrompt).not.toContain('PURPOSE & SCOPE OF CHANGE (DEPTH REQUIREMENTS)');
    expect(shortPrompt).not.toContain('Before producing the final answer, think privately');
    expect(shortPrompt).toContain('HTML STRUCTURE REQUIREMENT');
    expect(shortPrompt).toContain('OUTPUT FORMAT & CONSTRAINTS');
  });
});
