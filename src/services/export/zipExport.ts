/* M4 PHASE A: Real ZIP export from VFS
   Exports the ACTUAL project files from the current VFS state.
   No templates, no mock data, no silent replacements.
   
   Security: Validates all paths against traversal attacks.
   Limits: Enforces file count and total size limits.
   Integrity: Preserves directory structure and file content.
*/

import JSZip from 'jszip';
import { saveAs } from 'file-saver';

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
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-') // Remove invalid characters
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .substring(0, 100); // Limit length
  
  if (!name || name === '_') {
    name = 'lov-devil-project';
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${name}_${timestamp}.zip`;
}

/** Creates a ZIP archive from files and triggers download */
export async function exportToZip(
  files: ExportFile[],
  projectTitle: string,
  model: string
): Promise<{ ok: boolean; error?: string; filename?: string }> {
  // Validate files
  const validation = validateExportFiles(files);
  if (!validation.ok) {
    return { ok: false, error: validation.errors.join('; ') };
  }
  
  if (files.length === 0) {
    return { ok: false, error: 'No files to export' };
  }
  
  // Create ZIP archive
  const zip = new JSZip();
  const generatedAt = new Date().toISOString();
  
  // Add each file to the archive
  for (const f of files) {
    try {
      zip.file(f.path, f.content);
    } catch (e) {
      return { ok: false, error: `Failed to add file ${f.path}: ${String(e)}` };
    }
  }
  
  // Generate and add README
  const readme = generateReadme(projectTitle, model, generatedAt);
  zip.file('README.md', readme);
  
  // Generate filename
  const filename = generateZipFilename(projectTitle);
  
  // Generate ZIP blob
  try {
    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, filename);
    return { ok: true, filename };
  } catch (e) {
    return { ok: false, error: `Failed to generate ZIP: ${String(e)}` };
  }
}

/** Prepares VFS files for export, filtering out non-exportable files */
export function prepareVfsForExport(
  vfs: Record<string, Array<{ name: string; content: string }>>,
  snapId: string | null
): ExportFile[] {
  const files: ExportFile[] = [];
  
  if (!snapId) return files;
  
  const snapFiles = vfs[snapId] ?? [];
  
  for (const f of snapFiles) {
    // Skip files without names or content
    if (!f.name || !f.content) continue;
    
    // Skip if path is unsafe
    if (!isSafeExportPath(f.name)) continue;
    
    // Only include files with allowed extensions (or no extension like README)
    const hasExtension = f.name.includes('.');
    const extension = hasExtension ? f.name.slice(f.name.lastIndexOf('.')) : '';
    
    if (hasExtension && !ALLOWED_EXTENSIONS.has(extension)) {
      continue; // Skip files with disallowed extensions
    }
    
    files.push({ path: f.name, content: f.content });
  }
  
  return files;
}
