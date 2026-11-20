import { createRequire } from 'node:module';
import type * as TS from 'typescript';
import { redactSecrets } from '../security/secrets';
import type { BuildResult, SandboxFile } from './policy';
import type { SandboxErrorCode } from './errors';

/* Agent 4 — static AST guard for generated sources (defence in depth before esbuild).
   Parser: TypeScript compiler API (already in the repo; parses TS/TSX/JS/JSX without
   plugins). The guard never executes input, it only walks the syntax tree.
   Known limits (documented, not hidden): a static guard cannot prove absence of
   obfuscated access (e.g. `({}).constructor.constructor('…')`). It is one layer
   above the existing Docker isolation and esbuild import allow-list, not a replacement. */

export type AstGuardRule =
  | 'forbidden_module' | 'dynamic_require' | 'dynamic_import' | 'eval' | 'function_constructor'
  | 'process_env' | 'import_meta_env' | 'syntax_error' | 'parse_error';

export interface AstGuardFinding { file: string; line: number; column: number; rule: AstGuardRule; message: string; }
export interface AstGuardResult { ok: boolean; findings: AstGuardFinding[]; }

/** Prefix used in BuildResult diagnostics so clients/autofix can recognise a policy block. */
export const AST_GUARD_CODE: SandboxErrorCode = 'sandbox_policy_blocked';
export const AST_GUARD_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_FINDINGS = 50;

/* Lazy, synchronous load on the first scan: server boot and /api/health never pay for the
   parser. createRequire loads the prebuilt CommonJS bundle natively (measured under tsx:
   ~69 MB RSS / ~0.45 s once, vs ~135 MB through the ESM import hook). */
let ts: typeof TS;
function loadTypescript(): typeof TS {
  ts ??= createRequire(import.meta.url)('typescript') as typeof TS;
  return ts;
}

/** Node built-ins that generated browser code must never reach (bare or `node:` prefixed). */
const FORBIDDEN_MODULES = new Set([
  'child_process', 'fs', 'worker_threads', 'vm', 'net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns',
  'cluster', 'inspector', 'module', 'process', 'v8', 'os', 'repl', 'perf_hooks', 'async_hooks', 'trace_events', 'wasi',
]);
const SAFE_IMPORT_META_ENV = new Set(['MODE', 'DEV', 'PROD', 'BASE_URL', 'SSR']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);

export function isForbiddenModule(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  const base = specifier.startsWith('@') ? specifier : specifier.split('/')[0];
  return FORBIDDEN_MODULES.has(base);
}

function scriptKind(path: string): TS.ScriptKind {
  const p = path.toLowerCase();
  if (p.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (p.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(p)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function staticString(node: TS.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  return undefined;
}

function unwrap(node: TS.Expression): TS.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
         ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

/** `name` or `globalThis.name` / `window['name']` style references. */
function isGlobalRef(node: TS.Expression, name: string): boolean {
  const n = unwrap(node);
  if (ts.isIdentifier(n)) return n.text === name;
  if (ts.isPropertyAccessExpression(n)) return n.name.text === name && isGlobalObject(n.expression);
  if (ts.isElementAccessExpression(n)) return staticString(n.argumentExpression) === name && isGlobalObject(n.expression);
  return false;
}
function isGlobalObject(node: TS.Expression): boolean {
  const n = unwrap(node);
  return ts.isIdentifier(n) && GLOBAL_OBJECTS.has(n.text);
}

function memberName(node: TS.Expression): string | undefined {
  const n = unwrap(node);
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n)) return staticString(n.argumentExpression) ?? '\0dynamic';
  return undefined;
}
function memberObject(node: TS.Expression): TS.Expression | undefined {
  const n = unwrap(node);
  return ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) ? n.expression : undefined;
}
function isImportMeta(node: TS.Expression): boolean {
  const n = unwrap(node);
  return ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword && n.name.text === 'meta';
}

/** True for identifiers used as a value reference (not a declaration name or property key). */
function isValueReference(id: TS.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if ((ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isPropertyAssignment(p) && p.name === id) ||
      (ts.isMethodDeclaration(p) && p.name === id) || (ts.isPropertyDeclaration(p) && p.name === id) ||
      (ts.isPropertySignature(p) && p.name === id) || (ts.isMethodSignature(p) && p.name === id) ||
      (ts.isBindingElement(p) && p.propertyName === id) || (ts.isGetAccessor(p) && p.name === id) ||
      (ts.isSetAccessor(p) && p.name === id) || (ts.isEnumMember(p) && p.name === id) ||
      (ts.isJsxAttribute(p) && p.name === id) || ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) ||
      ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isLabeledStatement(p) ||
      ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

export function scanSource(path: string, content: string): AstGuardFinding[] {
  const findings: AstGuardFinding[] = [];
  loadTypescript();
  let source: TS.SourceFile;
  try {
    source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  } catch {
    return [{ file: path, line: 1, column: 1, rule: 'parse_error', message: 'súbor sa nepodarilo spracovať parserom' }];
  }
  const report = (node: TS.Node, rule: AstGuardRule, message: string) => {
    if (findings.length >= MAX_FINDINGS) return;
    const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file: path, line: pos.line + 1, column: pos.character + 1, rule, message });
  };
  // parseDiagnostics is the parser's own syntax error list (stable across TS 4.x/5.x, not in public d.ts).
  // The parser is error-tolerant, so the recovered tree is still scanned for dangerous constructs.
  const syntax = (source as unknown as { parseDiagnostics?: readonly TS.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  if (syntax.length) {
    const first = syntax[0];
    const pos = source.getLineAndCharacterOfPosition(first.start ?? 0);
    findings.push({ file: path, line: pos.line + 1, column: pos.character + 1, rule: 'syntax_error',
      message: 'syntaktická chyba: ' + ts.flattenDiagnosticMessageText(first.messageText, ' ').slice(0, 200) });
  }
  const checkModule = (node: TS.Node, specifier: string | undefined) => {
    if (specifier !== undefined && isForbiddenModule(specifier))
      report(node, 'forbidden_module', `zakázaný modul: ${specifier}`);
  };
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      checkModule(node, staticString(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkModule(node, staticString(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node)) {
      return; // type-only `import('x').T` is erased at compile time
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = staticString(node.arguments[0]);
        if (spec === undefined) report(node, 'dynamic_import', 'dynamický import() s nekonštantným argumentom');
        else checkModule(node, spec);
      } else if (isGlobalRef(callee, 'require') || (memberName(callee) === 'require' && ts.isIdentifier(unwrap(memberObject(callee)!)) &&
                 (unwrap(memberObject(callee)!) as TS.Identifier).text === 'module')) {
        const spec = staticString(node.arguments[0]);
        if (spec === undefined) report(node, 'dynamic_require', 'require() s nekonštantným argumentom');
        else checkModule(node, spec);
      } else if (isGlobalRef(callee, 'Function')) {
        report(node, 'function_constructor', 'Function(...) vytvára kód za behu');
      }
    } else if (ts.isNewExpression(node) && isGlobalRef(node.expression, 'Function')) {
      report(node, 'function_constructor', 'new Function(...) vytvára kód za behu');
    } else if (ts.isIdentifier(node) && node.text === 'eval' && isValueReference(node)) {
      report(node, 'eval', 'eval je zakázaný');
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const name = memberName(node);
      const object = memberObject(node)!;
      if (name === 'eval' && isGlobalObject(object)) report(node, 'eval', 'eval je zakázaný');
      if ((name === 'env' || name === '\0dynamic') && isGlobalRef(object, 'process')) {
        // `process.env.NODE_ENV` is statically replaced by esbuild `define`; anything else leaks host env.
        const parent = node.parent;
        const allowedNodeEnv = name === 'env' && parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          memberObject(parent) === node && memberName(parent) === 'NODE_ENV';
        if (!allowedNodeEnv) report(node, 'process_env', 'prístup k process.env je zakázaný');
      }
      if (name === 'env' && isImportMeta(object)) {
        const parent = node.parent;
        const key = parent && (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && memberObject(parent) === node
          ? memberName(parent) : undefined;
        if (!key || !(key.startsWith('VITE_') || SAFE_IMPORT_META_ENV.has(key)))
          report(node, 'import_meta_env', 'povolené sú len import.meta.env.VITE_* a štandardné Vite kľúče');
      }
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer &&
               isGlobalRef(node.initializer, 'process')) {
      for (const element of node.name.elements) {
        const key = element.propertyName ? (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
          ? element.propertyName.text : '\0computed') : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (key === 'env' || key === '\0computed' || element.dotDotDotToken)
          report(element, 'process_env', 'destructuring process.env je zakázaný');
      }
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer &&
               isImportMeta(node.initializer)) {
      for (const element of node.name.elements) {
        const key = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (key === 'env' || element.dotDotDotToken) report(element, 'import_meta_env', 'destructuring import.meta.env je zakázaný');
      }
    }
    ts.forEachChild(node, visit);
  };
  try { visit(source); }
  catch { return [{ file: path, line: 1, column: 1, rule: 'parse_error', message: 'súbor sa nepodarilo analyzovať' }]; }
  return findings;
}

export interface AstGuardOptions {
  /** Executor mode: a pure syntax error is left to esbuild (strict parser, never emits a bundle for it)
      so autofix receives the precise compiler diagnostic. Security findings and parser failures still block. */
  deferSyntaxErrors?: boolean;
}

/** Scans every script file (TS/TSX/JS/JSX/MJS/CJS). CSS/JSON/HTML/MD are not code and are skipped. */
export function scanFiles(files: readonly SandboxFile[], options: AstGuardOptions = {}): AstGuardResult {
  const findings: AstGuardFinding[] = [];
  for (const file of files) {
    if (!AST_GUARD_EXTENSIONS.test(file.path)) continue;
    for (const finding of scanSource(file.path, file.content)) {
      if (options.deferSyntaxErrors && finding.rule === 'syntax_error') continue;
      if (findings.length >= MAX_FINDINGS) break;
      findings.push(finding);
    }
  }
  return { ok: findings.length === 0, findings };
}

/** BuildResult in the same shape as policy validation failures, so autofix can repair the code. */
export function astGuardFailure(files: readonly SandboxFile[], options: AstGuardOptions = {}): BuildResult | null {
  const { ok, findings } = scanFiles(files, options);
  if (ok) return null;
  return {
    ok: false, html: null, durationMs: 0, moduleCount: 0,
    errors: findings.map(f => ({
      file: redactSecrets(f.file).slice(0, 200),
      message: redactCompilerOutput(`[${AST_GUARD_CODE}:${f.rule}] ${f.line}:${f.column} ${f.message}`).slice(0, 800),
    })),
  };
}

/* Extra masking for compiler/runner diagnostics on top of redactSecrets
   (server/security/secrets.ts is outside this epic, so the rules are additive here). */
const diagnosticPatterns: Array<[RegExp, string]> = [
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[REDACTED]'],
  [/\bwhsec_[A-Za-z0-9]{8,}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b([A-Za-z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_PASS))(\s*[:=]\s*)["']?[^\s"',;]{4,}["']?/gi, '$1$2[REDACTED]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
];
export function redactCompilerOutput(value: string): string {
  let result = redactSecrets(value);
  for (const [pattern, replacement] of diagnosticPatterns) result = result.replace(pattern, replacement);
  return result;
}
export function redactBuildDiagnostics(result: BuildResult): BuildResult {
  return { ...result, errors: result.errors.map(error => ({
    file: redactCompilerOutput(error.file), message: redactCompilerOutput(error.message),
  })) };
}
