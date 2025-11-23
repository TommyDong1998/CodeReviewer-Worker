/* eslint-disable @typescript-eslint/no-var-requires */
'use strict';

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

let ParserModule: any;
let parserModule: any = null;
const languageCache = new Map();

const LOCAL_WASM_DIR = path.join(process.cwd(), 'public', 'tree-sitter');
const CORE_WASM_FILE = path.join(LOCAL_WASM_DIR, 'tree-sitter.wasm');
const require = createRequire(import.meta.url);
let coreWasmReady = false;

// ---------------- Language Definitions ----------------
const LANGUAGE_PACKAGE_MAP: Record<string, { packageName: string; wasmFile: string }> = {
  javascript: { packageName: 'tree-sitter-javascript', wasmFile: 'tree-sitter-javascript.wasm' },
  typescript: { packageName: 'tree-sitter-typescript', wasmFile: 'tree-sitter-typescript.wasm' },
  tsx: { packageName: 'tree-sitter-typescript', wasmFile: 'tree-sitter-tsx.wasm' },
  python: { packageName: 'tree-sitter-python', wasmFile: 'tree-sitter-python.wasm' },
  java: { packageName: 'tree-sitter-java', wasmFile: 'tree-sitter-java.wasm' },
  c: { packageName: 'tree-sitter-c', wasmFile: 'tree-sitter-c.wasm' },
  cpp: { packageName: 'tree-sitter-cpp', wasmFile: 'tree-sitter-cpp.wasm' },
  csharp: { packageName: 'tree-sitter-c-sharp', wasmFile: 'tree-sitter-c-sharp.wasm' },
  php: { packageName: 'tree-sitter-php', wasmFile: 'tree-sitter-php.wasm' },
  ruby: { packageName: 'tree-sitter-ruby', wasmFile: 'tree-sitter-ruby.wasm' },
  go: { packageName: 'tree-sitter-go', wasmFile: 'tree-sitter-go.wasm' },
  rust: { packageName: 'tree-sitter-rust', wasmFile: 'tree-sitter-rust.wasm' },
  kotlin: { packageName: 'tree-sitter-kotlin', wasmFile: 'tree-sitter-kotlin.wasm' },
  swift: { packageName: 'tree-sitter-swift', wasmFile: 'tree-sitter-swift.wasm' },
  bash: { packageName: 'tree-sitter-bash', wasmFile: 'tree-sitter-bash.wasm' },
  dart: { packageName: 'tree-sitter-dart', wasmFile: 'tree-sitter-dart.wasm' },
  scala: { packageName: 'tree-sitter-scala', wasmFile: 'tree-sitter-scala.wasm' },
  lua: { packageName: 'tree-sitter-lua', wasmFile: 'tree-sitter-lua.wasm' },
  sql: { packageName: 'tree-sitter-sql', wasmFile: 'tree-sitter-sql.wasm' },
};

// ---------------- Function Node Types ----------------
const FUNCTION_NODE_TYPES: Record<string, Set<string>> = {
  javascript: new Set(['function_declaration', 'function_expression', 'generator_function', 'generator_function_declaration', 'function', 'method_definition', 'arrow_function']),
  typescript: new Set(['function_declaration', 'function_expression', 'generator_function', 'generator_function_declaration', 'function', 'method_definition', 'arrow_function', 'method_signature']),
  tsx: new Set(['function_declaration', 'function_expression', 'generator_function', 'generator_function_declaration', 'function', 'method_definition', 'arrow_function', 'method_signature']),
  python: new Set(['function_definition', 'lambda']),
  java: new Set(['method_declaration', 'constructor_declaration']),
  c: new Set(['function_definition']),
  cpp: new Set(['function_definition', 'declaration']),
  csharp: new Set(['method_declaration', 'constructor_declaration', 'local_function_statement']),
  php: new Set(['function_definition', 'method_declaration']),
  ruby: new Set(['method', 'singleton_method']),
  go: new Set(['function_declaration', 'method_declaration']),
  rust: new Set(['function_item']),
  kotlin: new Set(['function_declaration', 'anonymous_function', 'lambda_literal']),
  swift: new Set(['function_declaration', 'function_body']),
  bash: new Set(['function_definition']),
  dart: new Set(['function_signature', 'function_body', 'lambda_expression']),
  scala: new Set(['function_definition', 'function_declaration']),
  lua: new Set(['function_declaration', 'function_definition']),
  sql: new Set(['create_function_statement', 'create_or_replace_function_statement', 'create_procedure_statement', 'create_or_replace_procedure_statement']),
};

const CLASS_NODE_TYPES: Record<string, Set<string>> = {
  javascript: new Set(['class_declaration', 'class']),
  typescript: new Set(['class_declaration']),
  tsx: new Set(['class_declaration']),
  python: new Set(['class_definition']),
  java: new Set(['class_declaration']),
  csharp: new Set(['class_declaration']),
  php: new Set(['class_declaration', 'class_declaration_statement']),
  ruby: new Set(['class']),
  kotlin: new Set(['class_declaration']),
  swift: new Set(['class_declaration', 'class_specifier']),
};

// ---------------- Parser Initialization ----------------

async function getParserModule() {
  if (!parserModule) {
    const mod = await import('web-tree-sitter');
    const resolved = resolveParserExports(mod);

    await ensureCoreParserWasm();
    await resolved.Parser.init({
      locateFile(scriptName: string, scriptDirectory: string) {
        if (scriptName === 'tree-sitter.wasm') {
          return path.join(LOCAL_WASM_DIR, 'tree-sitter.wasm');
        }
        return path.join(scriptDirectory, scriptName);
      },
    });

    parserModule = resolved;
  }

  return parserModule;
}

let ensuringCoreWasm: Promise<void> | null = null;
async function ensureCoreParserWasm() {
  if (coreWasmReady) return;
  if (!ensuringCoreWasm) {
    ensuringCoreWasm = (async () => {
      try {
        await fs.access(CORE_WASM_FILE, fsConstants.F_OK);
        coreWasmReady = true;
        return;
      } catch {
        await fs.mkdir(LOCAL_WASM_DIR, { recursive: true });
      }

      const moduleAssetPath = resolveModuleAsset('web-tree-sitter/tree-sitter.wasm');
      await fs.copyFile(moduleAssetPath, CORE_WASM_FILE);
      coreWasmReady = true;
    })().finally(() => {
      ensuringCoreWasm = null;
    });
  }

  return ensuringCoreWasm;
}

function resolveModuleAsset(specifier: string) {
  try {
    return require.resolve(specifier);
  } catch (error) {
    console.error(`Unable to resolve ${specifier}. Make sure dependencies are installed.`, error);
    throw error;
  }
}

function resolveParserExports(mod: any) {
  const parserCandidates = [
    mod?.Parser,
    mod?.default?.Parser,
    typeof mod?.default === 'function' ? mod.default : null,
    typeof mod === 'function' ? mod : null,
  ];

  const ParserCtor = parserCandidates.find(
    (candidate) => candidate && typeof candidate.init === 'function'
  );

  if (!ParserCtor) {
    console.error('web-tree-sitter module keys:', Object.keys(mod ?? {}));
    throw new Error('web-tree-sitter: Parser.init() not found in import.');
  }

  const languageCandidates = [
    mod?.Language,
    mod?.default?.Language,
    mod?.Parser?.Language,
    mod?.default?.Parser?.Language,
    ParserCtor.Language,
  ];
  const LanguageCtor = languageCandidates.find(
    (candidate) => candidate && typeof candidate.load === 'function'
  );

  if (!LanguageCtor) {
    throw new Error('web-tree-sitter: Language.load() not found in import.');
  }

  return { Parser: ParserCtor, Language: LanguageCtor };
}

// ---------------- Grammar Binary Loader ----------------

async function loadLanguageBinary(language: string) {
  const config = LANGUAGE_PACKAGE_MAP[language];
  const wasmFile = config?.wasmFile ?? `tree-sitter-${language}.wasm`;
  const localPath = path.join(LOCAL_WASM_DIR, wasmFile);

  try {
    const data = await fs.readFile(localPath);
    return new Uint8Array(data);
  } catch {
    console.warn(`⚠️ Missing local wasm for ${language}: ${localPath}`);
    return null;
  }
}

// ---------------- Parser per Language ----------------

async function getLanguageParser(language: string) {
  if (languageCache.has(language)) return languageCache.get(language);
  const parserMod = await getParserModule();
  const binary = await loadLanguageBinary(language);
  if (!binary) return null;

  const lang = await parserMod.Language.load(binary);
  languageCache.set(language, lang);
  return lang;
}

// ---------------- Core Parse Function ----------------

/**
 * Hash function content for fingerprinting.
 * Normalizes code to be resilient to whitespace/comment changes.
 */
function hashFunctionContent(code: string): string {
  const normalized = code
    .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove /* */ comments
    .replace(/\/\/.*/g, '')             // Remove // comments
    .replace(/\s+/g, ' ')               // Collapse whitespace
    .trim();

  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

type ContextEntry = { type: 'function' | 'class'; name: string };

export interface ParsedFunction {
  name: string;
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
  nestingLevel: number;
  parentFunction?: string;
  classPath: string[];
  moduleName: string;
  qualifiedName: string | null;
  contentHash: string;
}

export async function parseCodeFunctions(code: string, filePath?: string): Promise<ParsedFunction[]> {
  const language = detectLanguage(filePath);
  const parserMod = await getParserModule();
  const lang = await getLanguageParser(language);
  if (!lang) return [];

  try {
    const parser = new parserMod.Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(code);

    const functions: ParsedFunction[] = [];
    collectFunctions(tree.rootNode, code, language, functions, [], {
      filePath,
      moduleName: normalizeModuleName(filePath),
    });

    // Add content hash to each function
    for (const fn of functions) {
      const fnCode = code.slice(fn.startIndex || 0, fn.endIndex || code.length);
      fn.contentHash = hashFunctionContent(fnCode);
    }

    parser.delete();
    return functions;
  } catch (error: any) {
    console.error(`[Parser] Error parsing ${filePath || 'unknown file'}:`, error.message || error);
    return [];
  }
}

// ---------------- Language Detection ----------------

function detectLanguage(filePath?: string) {
  if (!filePath) return 'javascript';
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.py': 'python',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.sh': 'bash',
    '.dart': 'dart',
    '.scala': 'scala',
    '.lua': 'lua',
    '.sql': 'sql',
  };
  return map[ext] || 'javascript';
}

// ---------------- Function Extraction ----------------

function collectFunctions(
  node: any,
  code: string,
  language: string,
  results: ParsedFunction[],
  stack: ContextEntry[],
  options: { filePath?: string; moduleName: string }
) {
  const functionTypes = FUNCTION_NODE_TYPES[language] ?? FUNCTION_NODE_TYPES.javascript;
  const classTypes = CLASS_NODE_TYPES[language] ?? CLASS_NODE_TYPES.javascript ?? new Set<string>();
  let pushedFunction = false;
  let pushedClass = false;

  if (classTypes.has(node.type)) {
    const className = resolveClassName(node, code);
    if (className) {
      stack.push({ type: 'class', name: className });
      pushedClass = true;
    }
  }

  if (functionTypes.has(node.type)) {
    const name = resolveFunctionName(node, code);
    if (name) {
      let startLine = node.startPosition.row + 1;
      let endLine = node.endPosition.row + 1;

      if (node.type === 'arrow_function') {
        const paramsNode = node.childForFieldName?.('parameters') || node.childForFieldName?.('parameter');
        if (paramsNode) {
          startLine = paramsNode.startPosition.row + 1;
        }
      }

      const bodyNode = node.childForFieldName?.('body');
      if (bodyNode) {
        endLine = bodyNode.endPosition.row + 1;
      }

      const classPath = stack.filter(entry => entry.type === 'class').map(entry => entry.name);
      const enclosingFunction = [...stack].reverse().find(entry => entry.type === 'function');
      const functionDepth = stack.filter(entry => entry.type === 'function').length;
      const qualifiedName = buildQualifiedName({
        filePath: options.filePath,
        classPath,
        functionName: name,
      });

      const fn: ParsedFunction = {
        name,
        startLine,
        endLine,
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        nestingLevel: functionDepth,
        parentFunction: enclosingFunction?.name,
        classPath,
        moduleName: options.moduleName,
        qualifiedName: qualifiedName || null,
        contentHash: '', // Will be filled later
      };

      results.push(fn);
      stack.push({ type: 'function', name });
      pushedFunction = true;
    }
  }

  for (const child of node.namedChildren || []) {
    collectFunctions(child, code, language, results, stack, options);
  }

  if (pushedFunction) stack.pop();
  if (pushedClass) stack.pop();
}

function resolveFunctionName(node: any, code: string) {
  const nameNode = node.childForFieldName?.('name');
  if (nameNode) return code.slice(nameNode.startIndex, nameNode.endIndex);
  return `anonymous_${node.startIndex}`;
}

function resolveClassName(node: any, code: string) {
  const nameNode = node.childForFieldName?.('name');
  if (nameNode) {
    return code.slice(nameNode.startIndex, nameNode.endIndex);
  }

  const identifierNode = node.namedChildren?.find((child: any) =>
    child.type?.includes('identifier') || child.type === 'type_identifier'
  );
  if (identifierNode) {
    return code.slice(identifierNode.startIndex, identifierNode.endIndex);
  }

  return `anonymous_class_${node.startIndex}`;
}

// Simplified versions of helper functions from main app
function normalizeModuleName(filePath?: string): string {
  if (!filePath) return '';
  return filePath.replace(/\.(js|ts|tsx|jsx|py|java|c|cpp|go|rs|kt|swift|rb|php)$/i, '');
}

function buildQualifiedName(options: {
  filePath?: string;
  classPath?: string[];
  functionName: string;
}): string | null {
  const parts: string[] = [];

  if (options.filePath) {
    const moduleName = normalizeModuleName(options.filePath);
    if (moduleName) parts.push(moduleName);
  }

  if (options.classPath && options.classPath.length > 0) {
    parts.push(...options.classPath);
  }

  parts.push(options.functionName);

  return parts.length > 1 ? parts.join('.') : null;
}
