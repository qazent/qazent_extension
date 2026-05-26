import { DiffChange, DiffChangeType } from './types';

export const GEMINI_MODEL_NAME = 'gemini-3.1-pro-preview';
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const TARGET_USER_PROMPT_TOKENS = 12000;

export const MAX_PR_DESCRIPTION_CHARS = 1600;
export const MAX_REPOSITORY_CONTEXT_CHARS = 4000;
export const MAX_DIFF_LINES_PER_FILE = 80;
export const MAX_FILES_WITH_DIFF = 32;
export const MAX_COMMITS = 20;
export const MAX_COMMIT_MESSAGE_CHARS = 240;

export const MAX_PR_DESCRIPTION_CHARS_STRICT = 900;
export const MAX_REPOSITORY_CONTEXT_CHARS_STRICT = 2500;
export const MAX_DIFF_LINES_PER_FILE_STRICT = 24;
export const MAX_FILES_WITH_DIFF_STRICT = 20;
export const MAX_COMMITS_STRICT = 10;
export const MAX_COMMIT_MESSAGE_CHARS_STRICT = 120;

export const DIFF_MAX_CHARS_PER_FILE = 6000;
export const DIFF_CONTEXT_LINES = 12;
export const MAX_SYNTHETIC_DIFF_LINES = 120;
export const MAX_FILES_FOR_AI = 120;
export const ITERATION_CHANGES_PAGE_SIZE = 200;

const SOURCE_FILE_EXTENSIONS = new Set([
  // JavaScript / TypeScript
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',

  // JSON / Data
  '.json', '.jsonc', '.ndjson',

  // .NET / C# / XAML
  '.cs', '.csx', '.xaml', '.resx', '.config',

  // Java / Kotlin
  '.java', '.kt', '.kts',

  // Go / Rust
  '.go', '.rs',

  // Python / Ruby / PHP
  '.py', '.rb', '.php',

  // Swift / Scala
  '.swift', '.scala',

  // SQL / Database
  '.sql', '.psql', '.ddl',

  // YAML / XML
  '.yml', '.yaml', '.xml',

  // Web / UI
  '.html', '.htm', '.css', '.scss', '.sass', '.less',

  // Markdown / Docs
  '.md', '.mdx', '.rst', '.adoc',

  // Shell / Scripts
  '.sh', '.bash', '.zsh', '.ps1', '.psm1',

  // Docker / Containers
  '.dockerfile', '.containerfile',

  // Infrastructure as Code
  '.tf', '.tfvars', '.hcl',

  // Config formats
  '.ini', '.cfg', '.toml', '.env', '.properties',

  // C / C++ / Headers
  '.c', '.h', '.cpp', '.hpp', '.cc',

  // Misc build / tooling
  '.gradle', '.groovy', '.make', '.mk'
]);

const HIGH_SIGNAL_FILE_NAMES = new Set([
  // JavaScript / Node ecosystem
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',

  // TypeScript / JS config
  'tsconfig.json',
  'tsconfig.base.json',
  'jsconfig.json',

  // Build systems
  'webpack.config.js',
  'webpack.config.ts',
  'vite.config.js',
  'vite.config.ts',
  'rollup.config.js',
  'rollup.config.ts',
  'esbuild.config.js',
  'esbuild.config.ts',

  // Linting / formatting
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.editorconfig',

  // ---------------------------
  // .NET / C# HIGH-SIGNAL FILES
  // ---------------------------

  // Entry points
  'Program.cs',
  'Startup.cs',
  'Global.asax.cs',
  'Main.cs',
  'App.cs',

  // Project & solution structure
  'appsettings.json',
  'appsettings.Development.json',
  'appsettings.Production.json',
  'appsettings.Staging.json',
  'launchSettings.json',
  'Directory.Build.props',
  'Directory.Build.targets',
  'nuget.config',

  // Solution & project files
  '*.sln',
  '*.csproj',
  '*.fsproj',
  '*.vbproj',

  // Dependency injection / hosting
  'ServiceCollectionExtensions.cs',
  'DependencyInjection.cs',
  'HostBuilderExtensions.cs',

  // Routing / middleware
  'Routes.cs',
  'Endpoints.cs',
  'Middleware.cs',

  // Controllers / API entrypoints
  'WeatherForecastController.cs',
  'HomeController.cs',
  'ApiController.cs',

  // Razor / Blazor
  '_ViewImports.cshtml',
  '_ViewStart.cshtml',
  '_Host.cshtml',
  'App.razor',
  'MainLayout.razor',

  // ---------------------------
  // XAML / UI HIGH-SIGNAL FILES
  // ---------------------------

  // WPF / WinUI / MAUI / Xamarin
  'App.xaml',
  'App.xaml.cs',
  'MainWindow.xaml',
  'MainWindow.xaml.cs',
  'MainPage.xaml',
  'MainPage.xaml.cs',
  'Shell.xaml',
  'Shell.xaml.cs',

  // Resource dictionaries
  'Themes.xaml',
  'Colors.xaml',
  'Styles.xaml',
  'Resources.xaml',

  // UI configuration
  'Manifest.xml',
  'AndroidManifest.xml',
  'Info.plist',

  // ---------------------------
  // DevOps / CI / Containers
  // ---------------------------

  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.gitlab-ci.yml',
  '.github/workflows',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',

  // Environment files
  '.env',
  '.env.example'
]);

export function classifyChangeType(changeType: unknown): DiffChangeType {
  const changeTypeStr = String(changeType ?? '').toLowerCase();
  if (changeTypeStr.includes('add')) {
    return 'add';
  }
  if (changeTypeStr.includes('delete')) {
    return 'delete';
  }
  return 'edit';
}

export function normalizeDiffPath(filePath: string): string {
  return filePath.replace(/^\/+/, '');
}

export function countContentLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split('\n').length;
}

export function getFallbackLineMetrics(changeType: DiffChangeType): { linesAdded: number; linesDeleted: number } {
  if (changeType === 'add') {
    return { linesAdded: 10, linesDeleted: 0 };
  }
  if (changeType === 'delete') {
    return { linesAdded: 0, linesDeleted: 10 };
  }
  return { linesAdded: 5, linesDeleted: 5 };
}

export function rankDiffChange(change: DiffChange): number {
  const normalizedPath = normalizeDiffPath(change.filePath).toLowerCase();
  const baseName = normalizedPath.split('/').pop() ?? normalizedPath;
  const extension = baseName.includes('.') ? `.${baseName.split('.').pop()}` : '';
  const totalTouchedLines = change.linesAdded + change.linesDeleted;

  let score = Math.min(totalTouchedLines, 400);

  // Base scoring
  if (change.changeType === 'add') {
    score += 45;
  } else if (change.changeType === 'edit') {
    score += 30;
  } else {
    score += 18;
  }

  if (SOURCE_FILE_EXTENSIONS.has(extension)) {
    score += 30;
  }

  if (HIGH_SIGNAL_FILE_NAMES.has(baseName)) {
    score += 30;
  }

  if (/\/tests?\//.test(normalizedPath) || /\.(spec|test)\./.test(baseName)) {
    score += 10;
  }

  if (/\/migrations?\//.test(normalizedPath) || extension === '.sql') {
    score += 8;
  }
  
  // 1. Critical architecture directories
  if (/\/(core|domain|infrastructure|services|application|src\/core)\//.test(normalizedPath)) {
    score += 35;
  }

  // 2. Security-sensitive files
  if (/auth|security|crypto|token|jwt|permissions|roles|certificate|secrets?/i.test(baseName)) {
    score += 45;
  }

  // 3. Configuration files
  if (
    /\.(config|props|targets)$/.test(extension) ||
    /(appsettings|launchsettings|nuget\.config)/i.test(baseName)
  ) {
    score += 25;
  }

  // 4. XAML UI entrypoints
  if (/app\.xaml$|mainwindow\.xaml$|shell\.xaml$/i.test(baseName)) {
    score += 35;
  }

  // 5. Project/solution structure
  if (extension === '.csproj' || extension === '.sln') {
    score += 45;
  }

  // 6. Dependency changes
  if (
    /package\.json|packages\.config|\.csproj$|\.fsproj$|\.vbproj$/.test(baseName) ||
    /<PackageReference/i.test(change.diffContent ?? '')
  ) {
    score += 30;
  }

  // 7. CI/CD pipeline changes
  if (
    /\.github\/workflows/.test(normalizedPath) ||
    /azure-pipelines/.test(normalizedPath) ||
    /\.gitlab-ci/.test(normalizedPath)
  ) {
    score += 35;
  }

  // 8. Backend high-signal patterns
  if (/controller|service|repository|handler|manager|provider/i.test(baseName)) {
    score += 25;
  }

  // 9. Large refactors
  if (totalTouchedLines > 500) score += 40;
  if (totalTouchedLines > 1000) score += 60;

  // 11. Monorepo high-signal directories
  if (/\/(apps|packages|libs|modules)\//.test(normalizedPath)) {
    score += 20;
  }

  // 12. Environment files
  if (/\.env$|\.env\.example$|\.env\.local$/.test(baseName)) {
    score += 40;
  }

  // 13. Build files
  if (/Dockerfile|docker-compose|Makefile|build\.gradle|pom\.xml/i.test(baseName)) {
    score += 35;
  }

  // 14. Razor / Blazor
  if (/\.(razor|cshtml)$/.test(extension)) {
    score += 20;
  }

  return score;
}

