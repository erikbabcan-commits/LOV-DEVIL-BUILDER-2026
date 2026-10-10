/* M4 PHASE D: Export unit tests
   Tests for ZIP export and GitHub export functionality
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isSafeExportPath,
  validateExportFiles,
  prepareVfsForExport,
  generateReadme,
  generateZipFilename,
  MAX_FILES,
  MAX_SIZE_BYTES,
  RESERVED_NAMES,
  ALLOWED_EXTENSIONS,
} from '../../src/services/export/zipExport';
import {
  isValidRepoName,
  validateGitHubExport,
} from '../../src/services/export/githubExport';

/* ==================== ZIP Export Tests ==================== */

describe('ZIP Export - Path Validation', () => {
  it('should accept safe relative paths', () => {
    expect(isSafeExportPath('src/main.tsx')).toBe(true);
    expect(isSafeExportPath('src/components/Button.tsx')).toBe(true);
    expect(isSafeExportPath('public/index.html')).toBe(true);
    expect(isSafeExportPath('package.json')).toBe(true);
    expect(isSafeExportPath('README.md')).toBe(true);
  });

  it('should reject absolute paths', () => {
    expect(isSafeExportPath('/src/main.tsx')).toBe(false);
    expect(isSafeExportPath('/etc/passwd')).toBe(false);
  });

  it('should reject path traversal attempts', () => {
    expect(isSafeExportPath('../src/main.tsx')).toBe(false);
    expect(isSafeExportPath('src/../../etc/passwd')).toBe(false);
    expect(isSafeExportPath('src/../main.tsx')).toBe(false);
    expect(isSafeExportPath('a/./b/../c/./d')).toBe(false);
  });

  it('should reject reserved names', () => {
    expect(isSafeExportPath('.env')).toBe(false);
    expect(isSafeExportPath('src/.env.local')).toBe(false);
    expect(isSafeExportPath('node_modules/package.json')).toBe(false);
    expect(isSafeExportPath('.gitignore')).toBe(false);
  });

  it('should reject paths with null bytes', () => {
    expect(isSafeExportPath('src/main.tsx\0')).toBe(false);
    expect(isSafeExportPath('src\0/main.tsx')).toBe(false);
  });

  it('should reject very long paths', () => {
    const longPath = 'a'.repeat(256);
    expect(isSafeExportPath(longPath)).toBe(false);
  });

  it('should accept paths up to 255 characters', () => {
    const path = 'a'.repeat(255);
    expect(isSafeExportPath(path)).toBe(true);
  });
});

describe('ZIP Export - File Validation', () => {
  it('should reject empty file list', () => {
    const result = validateExportFiles([]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('No files to export');
  });

  it('should reject too many files', () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      path: `file${i}.ts`,
      content: 'content',
    }));
    const result = validateExportFiles(files);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(`> ${MAX_FILES}`);
  });

  it('should reject files exceeding total size limit', () => {
    const largeContent = 'x'.repeat(MAX_SIZE_BYTES + 1);
    const files = [{ path: 'large.txt', content: largeContent }];
    const result = validateExportFiles(files);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('50MB');
  });

  it('should reject individual files over 10MB', () => {
    const largeContent = 'x'.repeat(10 * 1024 * 1024 + 1);
    const files = [{ path: 'huge.txt', content: largeContent }];
    const result = validateExportFiles(files);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('10MB');
  });

  it('should accept valid files', () => {
    const files = [
      { path: 'src/main.tsx', content: 'import React from "react";' },
      { path: 'package.json', content: '{ "name": "test" }' },
      { path: 'index.html', content: '<html></html>' },
    ];
    const result = validateExportFiles(files);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should warn about hidden files', () => {
    const files = [
      { path: '.hidden/file.txt', content: 'secret' },
      { path: 'src/main.tsx', content: 'code' },
    ];
    const result = validateExportFiles(files);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('Hidden file: .hidden/file.txt');
  });

  it('should warn when no entry file found', () => {
    const files = [
      { path: 'src/utils.ts', content: 'export const x = 1;' },
    ];
    const result = validateExportFiles(files);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.includes('No entry file'))).toBe(true);
  });

  it('should detect duplicate paths', () => {
    const files = [
      { path: 'src/main.tsx', content: 'file 1' },
      { path: 'src/main.tsx', content: 'file 2' },
    ];
    const result = validateExportFiles(files);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Duplicate path: src/main.tsx');
  });
});

describe('ZIP Export - VFS Preparation', () => {
  it('should filter out files with disallowed extensions', () => {
    const vfs = {
      'snap1': [
        { name: 'src/main.tsx', content: 'valid' },
        { name: 'secret.key', content: 'api key' },
        { name: 'src/App.tsx', content: 'valid' },
      ],
    };
    const { files } = prepareVfsForExport(vfs, 'snap1');
    expect(files).toHaveLength(2);
    expect(files.map(f => f.path)).toContain('src/main.tsx');
    expect(files.map(f => f.path)).toContain('src/App.tsx');
    expect(files.map(f => f.path)).not.toContain('secret.key');
  });

  it('should return empty array for null snapshot', () => {
    const vfs = {};
    const { files } = prepareVfsForExport(vfs, null);
    expect(files).toHaveLength(0);
  });

  it('should return empty array for missing snapshot', () => {
    const vfs = { 'snap1': [{ name: 'file.txt', content: 'content' }] };
    const { files } = prepareVfsForExport(vfs, 'nonexistent');
    expect(files).toHaveLength(0);
  });

  it('should skip files without names or null content', () => {
    const vfs = {
      'snap1': [
        { name: '', content: 'no name' },
        { name: 'valid.txt', content: '' },
        { name: 'also-valid.txt', content: 'content' },
      ],
    };
    const { files, warnings } = prepareVfsForExport(vfs, 'snap1');
    // Empty content strings are allowed (valid empty files)
    // Only null/undefined content is skipped
    expect(files).toHaveLength(2);
    expect(files.map(f => f.path)).toContain('valid.txt');
    expect(files.map(f => f.path)).toContain('also-valid.txt');
    expect(warnings).toContain('Skipping file with empty name');
  });

  it('should skip unsafe paths', () => {
    const vfs = {
      'snap1': [
        { name: 'src/main.tsx', content: 'valid' },
        { name: '../etc/passwd', content: 'hack' },
      ],
    };
    const { files } = prepareVfsForExport(vfs, 'snap1');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/main.tsx');
  });

  it('should detect secrets in file content', () => {
    const vfs = {
      'snap1': [
        { name: 'src/config.ts', content: 'export const MISTRAL_API_KEY = "sk-12345"' },
        { name: 'src/main.tsx', content: 'import React from "react"' },
      ],
    };
    const { files, warnings } = prepareVfsForExport(vfs, 'snap1');
    // File with secret should be skipped
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/main.tsx');
    // Should have warning about secret
    expect(warnings.some(w => w.includes('SECRET'))).toBe(true);
    // config.ts should NOT be in files
    expect(files.map(f => f.path)).not.toContain('src/config.ts');
  });

  it('should detect missing required files', () => {
    const vfs = {
      'snap1': [
        { name: 'src/utils.ts', content: 'export const x = 1' },
      ],
    };
    const { missingRequired } = prepareVfsForExport(vfs, 'snap1');
    expect(missingRequired).toContain('package.json');
    expect(missingRequired).toContain('index.html or src/main.tsx');
  });

  it('should not flag missing required files when they exist', () => {
    const vfs = {
      'snap1': [
        { name: 'package.json', content: '{ "name": "test" }' },
        { name: 'index.html', content: '<html></html>' },
        { name: 'src/main.tsx', content: 'import React from "react"' },
      ],
    };
    const { missingRequired } = prepareVfsForExport(vfs, 'snap1');
    expect(missingRequired).toHaveLength(0);
  });

  it('should warn about empty content', () => {
    const vfs = {
      'snap1': [
        { name: 'src/empty.tsx', content: '' },
        { name: 'src/main.tsx', content: 'import React from "react"' },
      ],
    };
    const { warnings } = prepareVfsForExport(vfs, 'snap1');
    expect(warnings.some(w => w.includes('Empty content'))).toBe(true);
  });
});

describe('ZIP Export - README Generation', () => {
  it('should generate valid README with project info', () => {
    const readme = generateReadme('My Project', 'mock-large', '2024-01-01T00:00:00.000Z');
    expect(readme).toContain('# My Project');
    expect(readme).toContain('LOV-DEVIL AI Builder');
    expect(readme).toContain('mock-large');
    expect(readme).toContain('npm install');
    expect(readme).toContain('npm run dev');
    expect(readme).toContain('npm run build');
  });

  it('should handle special characters in project title', () => {
    const readme = generateReadme('My <Awesome> Project & More!', 'model', '2024-01-01');
    expect(readme).toContain('# My <Awesome> Project & More!');
  });
});

describe('ZIP Export - Filename Generation', () => {
  it('should generate safe filename from project title', () => {
    const filename = generateZipFilename('My Project');
    expect(filename).toMatch(/^my-project_\d{4}-\d{2}-\d{2}.*\.zip$/);
    expect(filename).not.toContain(' ');
  });

  it('should replace invalid filename characters', () => {
    const filename = generateZipFilename('My/Project:Name*With?Invalid|Chars');
    expect(filename).not.toContain('/');
    expect(filename).not.toContain(':');
    expect(filename).not.toContain('*');
    expect(filename).not.toContain('?');
    expect(filename).not.toContain('|');
    expect(filename).toContain('-');
  });

  it('should use default name for empty or invalid title', () => {
    const filename1 = generateZipFilename('');
    expect(filename1).toContain('lov-devil-project');

    const filename2 = generateZipFilename('   ');
    expect(filename2).toContain('lov-devil-project');
  });

  it('should limit filename length', () => {
    const longTitle = 'a'.repeat(200);
    const filename = generateZipFilename(longTitle);
    // Base name is limited to 100 chars + timestamp + .zip
    expect(filename.length).toBeLessThan(150);
  });
});

/* ==================== GitHub Export Tests ==================== */

describe('GitHub Export - Repository Name Validation', () => {
  it('should accept valid repository names', () => {
    expect(isValidRepoName('my-repo')).toBe(true);
    expect(isValidRepoName('my_repo')).toBe(true);
    expect(isValidRepoName('MyRepo123')).toBe(true);
    expect(isValidRepoName('a')).toBe(true);
    expect(isValidRepoName('a'.repeat(100))).toBe(true);
  });

  it('should reject empty names', () => {
    expect(isValidRepoName('')).toBe(false);
    expect(isValidRepoName('   ')).toBe(false);
  });

  it('should reject names that are too long', () => {
    expect(isValidRepoName('a'.repeat(101))).toBe(false);
  });

  it('should reject names starting or ending with hyphen', () => {
    expect(isValidRepoName('-repo')).toBe(false);
    expect(isValidRepoName('repo-')).toBe(false);
  });

  it('should reject names starting or ending with dot', () => {
    expect(isValidRepoName('.repo')).toBe(false);
    expect(isValidRepoName('repo.')).toBe(false);
  });

  it('should reject consecutive hyphens', () => {
    expect(isValidRepoName('my--repo')).toBe(false);
  });

  it('should reject dot and dot-dot', () => {
    expect(isValidRepoName('.')).toBe(false);
    expect(isValidRepoName('..')).toBe(false);
  });

  it('should reject names with invalid characters', () => {
    expect(isValidRepoName('my@repo')).toBe(false);
    expect(isValidRepoName('my repo')).toBe(false);
    expect(isValidRepoName('my/repo')).toBe(false);
    expect(isValidRepoName('my\\repo')).toBe(false);
  });
});

describe('GitHub Export - Request Validation', () => {
  it('should reject empty repo name', () => {
    const result = validateGitHubExport('', []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Repository name is required');
  });

  it('should reject invalid repo name', () => {
    const result = validateGitHubExport('invalid@name', []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid repository name');
  });

  it('should reject empty files', () => {
    const result = validateGitHubExport('my-repo', []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No files to export');
  });

  it('should reject too many files', () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      path: `file${i}.ts`,
      content: 'content',
    }));
    const result = validateGitHubExport('my-repo', files);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('> 100');
  });

  it('should reject reserved paths', () => {
    const files = [
      { path: '.git/config', content: 'git config' },
      { path: 'src/main.tsx', content: 'code' },
    ];
    const result = validateGitHubExport('my-repo', files);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Reserved path');
  });

  it('should accept valid request', () => {
    const files = [
      { path: 'src/main.tsx', content: 'import React from "react";' },
      { path: 'package.json', content: '{ "name": "test" }' },
    ];
    const result = validateGitHubExport('my-repo', files);
    expect(result.ok).toBe(true);
  });
});

describe('Export - Constants', () => {
  it('should have reasonable limits', () => {
    expect(MAX_FILES).toBe(200);
    expect(MAX_SIZE_BYTES).toBe(50 * 1024 * 1024);
  });

  it('should have expected reserved names', () => {
    expect(RESERVED_NAMES).toContain('.env');
    expect(RESERVED_NAMES).toContain('.env.local');
    expect(RESERVED_NAMES).toContain('node_modules');
  });

  it('should have expected allowed extensions', () => {
    expect(ALLOWED_EXTENSIONS).toContain('.tsx');
    expect(ALLOWED_EXTENSIONS).toContain('.ts');
    expect(ALLOWED_EXTENSIONS).toContain('.jsx');
    expect(ALLOWED_EXTENSIONS).toContain('.js');
    expect(ALLOWED_EXTENSIONS).toContain('.css');
    expect(ALLOWED_EXTENSIONS).toContain('.json');
    expect(ALLOWED_EXTENSIONS).toContain('.html');
    expect(ALLOWED_EXTENSIONS).toContain('.md');
  });
});
