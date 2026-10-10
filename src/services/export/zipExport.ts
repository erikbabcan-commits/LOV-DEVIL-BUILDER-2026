/* M4 PHASE A: Real ZIP export from VFS
   Exports the ACTUAL project files from the current VFS state.
   No templates, no mock data, no silent replacements.
   
   Security: Validates all paths against traversal attacks.
   Limits: Enforces file count and total size limits.
   Integrity: Preserves directory structure and file content.
*/

import { saveAs } from 'file-saver';
import { buildZipBlob } from './zipArchive';

/** Maximum files in a single export */
export const MAX_FILES = 200;

/** Maximum total uncompressed size in bytes (50MB) */
export const MAX_SIZE_BYTES = 50 * 1024 * 1024;

/** Reserved filenames that cannot be exported */
export const RESERVED_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.gitignore',
  'node_modules',
]);

/** Valid file extensions for export */
export const ALLOWED_EXTENSIONS = new Set([
  '.tsx', '.ts', '.jsx', '.js', '.css', '.scss', '.sass', '.less',
  '.json', '.html', '.md', '.txt', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot',
  '.yaml', '.yml', '.xml', '.toml', '.config.js', '.config.ts',
]);

/** Path traversal validation - reject any path that tries to escape */
export function isSafeExportPath(path: string): boolean {
  // Reject empty paths
  if (!path || path.length === 0) return false;

  // Normalize path
  const normalized = path.replace(/\\/g, '/');
  
  // Reject absolute paths
  if (normalized.startsWith('/')) return false;
  
  // Reject paths containing parent directory references
  if (normalized.includes('/../') || normalized.startsWith('../')) return false;
  
  // Reject paths that would escape via ..
  const parts = normalized.split('/');
  let depth = 0;
  for (const part of parts) {
    if (part === '..') depth--;
    else if (part && !part.startsWith('.')) depth++;
    if (depth < 0) return false;
  }
  
  // Reject reserved names at any level
  for (const part of parts) {
    if (RESERVED_NAMES.has(part)) return false;
  }
  
  // Reject paths that are too long
  if (normalized.length > 255) return false;
  
  // Reject paths with null bytes
  if (normalized.includes('\0')) return false;
  
  return true;
}

/** File validation for export */
export interface ExportFile {
  path: string;
  content: string;
}

/** Validation result */
export interface ExportValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Validates a set of files for export */
export function validateExportFiles(files: ExportFile[]): ExportValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check file count
  if (files.length === 0) {
    errors.push('No files to export');
    return { ok: false, errors, warnings };
  }
  
  if (files.length > MAX_FILES) {
    errors.push(`Too many files (${files.length} > ${MAX_FILES})`);
    return { ok: false, errors, warnings };
  }
  
  // Check total size
  let totalSize = 0;
  for (const f of files) {
    totalSize += f.content.length;
  }
  
  if (totalSize > MAX_SIZE_BYTES) {
    errors.push(`Total size too large (${Math.round(totalSize / 1024 / 1024)}MB > 50MB)`);
    return { ok: false, errors, warnings };
  }
  
  // Check individual file sizes
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
  for (const f of files) {
    if (f.content.length > MAX_FILE_SIZE) {
      errors.push(`File too large: ${f.path} (${Math.round(f.content.length / 1024 / 1024)}MB > 10MB)`);
    }
  }
  
  // Validate each path
  const seenPaths = new Set<string>();
  for (const f of files) {
    if (!isSafeExportPath(f.path)) {
      errors.push(`Unsafe path: ${f.path}`);
    }
    
    if (seenPaths.has(f.path)) {
      errors.push(`Duplicate path: ${f.path}`);
    }
    seenPaths.add(f.path);
    
    // Check for hidden files starting with . (except .gitignore which is reserved)
    const parts = f.path.split('/');
    for (const part of parts) {
      if (part.startsWith('.') && part !== '.gitignore') {
        warnings.push(`Hidden file: ${f.path}`);
      }
    }
  }
  
  // Check for required files
  const hasEntry = files.some(f => f.path === 'index.html' || f.path === 'src/main.tsx' || f.path === 'src/main.jsx');
  if (!hasEntry && files.length > 0) {
    warnings.push('No entry file (index.html or src/main.tsx) found');
  }
  
  return { ok: errors.length === 0, errors, warnings };
}

/** Generates a README for the exported project */
export function generateReadme(projectTitle: string, model: string, generatedAt: string): string {
  return `# ${projectTitle}

Generated with [LOV-DEVIL AI Builder](https://github.com/erikbabcan-commits/LOV-DEVIL-BUILDER-2026) using ${model}.

## Project Structure

This is a complete, standalone React application. All dependencies are listed in package.json.

## Getting Started

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

\`\`\`bash
npm install
\`\`\`

### Development

\`\`\`bash
npm run dev
\`\`\`

### Build

\`\`\`bash
npm run build
\`\`\`

### Preview

\`\`\`bash
npm run preview
\`\`\`

## Generated

${generatedAt}
`;
}

/** Generates a safe filename for the ZIP archive */
export function generateZipFilename(projectTitle: string): string {
  // Sanitize the project title for use in a filename
  let name = projectTitle
    .trim()
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-') // eslint-disable-line no-control-regex
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100); // Limit length
  
  if (!name) {
    name = 'lov-devil-project';
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${name}_${timestamp}.zip`;
}

/** Creates a ZIP archive from files and triggers download */
export async function createZipBlob(
  files: ExportFile[],
  projectTitle: string,
  model: string
): Promise<{ ok: boolean; error?: string; filename?: string; blob?: Blob }> {
  // Validate files
  const validation = validateExportFiles(files);
  if (!validation.ok) {
    return { ok: false, error: validation.errors.join('; ') };
  }
  
  if (files.length === 0) {
    return { ok: false, error: 'No files to export' };
  }
  
  const generatedAt = new Date().toISOString();
  const readme = generateReadme(projectTitle, model, generatedAt);
  
  // Generate filename
  const filename = generateZipFilename(projectTitle);
  
  // Generate ZIP blob
  try {
    const blob = await buildZipBlob(files, readme);
    return { ok: true, filename, blob };
  } catch (e) {
    return { ok: false, error: `Failed to generate ZIP: ${String(e)}` };
  }
}

/** Creates a ZIP archive from files and triggers download. */
export async function exportToZip(
  files: ExportFile[],
  projectTitle: string,
  model: string
): Promise<{ ok: boolean; error?: string; filename?: string }> {
  const result = await createZipBlob(files, projectTitle, model);
  if (!result.ok || !result.blob || !result.filename) return { ok: false, error: result.error || 'Failed to generate ZIP' };
  saveAs(result.blob, result.filename);
  return { ok: true, filename: result.filename };
}

/**
 * Prepares VFS files for export, filtering out non-exportable files
 * 
 * Security: Checks for secrets before including files
 * Completeness: Ensures required files are present
 * Integrity: Preserves all valid project files
 */
export function prepareVfsForExport(
  vfs: Record<string, Array<{ name: string; content: string }>>,
  snapId: string | null
): { files: ExportFile[]; warnings: string[]; missingRequired: string[] } {
  const files: ExportFile[] = [];
  const warnings: string[] = [];
  const missingRequired: string[] = [];
  
  if (!snapId) {
    return { files, warnings: ['No snapshot ID provided'], missingRequired };
  }
  
  const snapFiles = vfs[snapId] ?? [];
  
  // Required files for a valid React project
  let hasPackageJson = false;
  let hasEntry = false;
  
  // Secret patterns to check - allow optional whitespace
  const secretPatterns = [
    /MISTRAL_API_KEY\s*[=:]/,
    /GITHUB_TOKEN\s*[=:]/,
    /NPM_TOKEN\s*[=:]/,
    /aws_access_key_id\s*[=:]/,
    /aws_secret_access_key\s*[=:]/,
    /private[_-]?key\s*[=:]/i,
    /password\s*[=:]/i,
    /api[_-]?key\s*[=:]/i,
    /secret\s*[=:]/i,
  ];
  
  for (const f of snapFiles) {
    // Skip files without names
    if (!f.name) {
      warnings.push('Skipping file with empty name');
      continue;
    }
    
    // Skip if content is null/undefined, but allow empty strings (valid empty files)
    if (f.content == null) {
      warnings.push(`Skipping ${f.name} with null/undefined content`);
      continue;
    }
    
    // Skip if path is unsafe
    if (!isSafeExportPath(f.name)) {
      warnings.push(`Skipping unsafe path: ${f.name}`);
      continue;
    }
    
    // Check for secrets in content
    let hasSecret = false;
    for (const pattern of secretPatterns) {
      if (pattern.test(f.content)) {
        warnings.push(`POTENTIAL SECRET in ${f.name} - export blocked`);
        hasSecret = true;
        break;
      }
    }
    if (hasSecret) continue;
    
    // Only include files with allowed extensions (or no extension like README, Makefile)
    const hasExtension = f.name.includes('.');
    const extension = hasExtension ? f.name.slice(f.name.lastIndexOf('.')) : '';
    
    if (hasExtension && !ALLOWED_EXTENSIONS.has(extension)) {
      warnings.push(`Skipping disallowed extension: ${f.name} (${extension})`);
      continue;
    }
    
    // Track required files
    if (f.name === 'package.json') hasPackageJson = true;
    if (f.name === 'index.html' || f.name === 'src/main.tsx' || f.name === 'src/main.jsx') hasEntry = true;
    
    files.push({ path: f.name, content: f.content });
  }
  
  // Check for missing required files
  if (!hasPackageJson) {
    missingRequired.push('package.json');
  }
  if (!hasEntry) {
    missingRequired.push('index.html or src/main.tsx');
  }
  
  // Check for empty content in critical files
  for (const f of files) {
    if (f.content === '' || f.content === '\n' || f.content === '\n\n') {
      warnings.push(`Empty content in ${f.path}`);
    }
  }
  
  return { files, warnings, missingRequired };
}
