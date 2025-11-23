import crypto from 'node:crypto';
import Parser from 'tree-sitter';

// Tree-sitter language imports (native Node.js bindings)
// @ts-ignore - No type definitions available for tree-sitter language packages
import JavaScript from 'tree-sitter-javascript';
// @ts-ignore
import TypeScript from 'tree-sitter-typescript';
// @ts-ignore
import Python from 'tree-sitter-python';
// @ts-ignore
import Java from 'tree-sitter-java';
// @ts-ignore
import C from 'tree-sitter-c';
// @ts-ignore
import Cpp from 'tree-sitter-cpp';
// @ts-ignore
import CSharp from 'tree-sitter-c-sharp';
// @ts-ignore
import PHP from 'tree-sitter-php';
// @ts-ignore
import Ruby from 'tree-sitter-ruby';
// @ts-ignore
import Go from 'tree-sitter-go';
// @ts-ignore
import Rust from 'tree-sitter-rust';
// @ts-ignore
import Bash from 'tree-sitter-bash';

// Language map for native tree-sitter
const LANGUAGE_MAP: Record<string, any> = {
  javascript: JavaScript,
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
  java: Java,
  c: C,
  cpp: Cpp,
  csharp: CSharp,
  php: PHP,
  ruby: Ruby,
  go: Go,
  rust: Rust,
  bash: Bash,
};

// Function node types per language
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
  bash: new Set(['function_definition']),
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
};

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
  const languageModule = LANGUAGE_MAP[language];

  if (!languageModule) {
    console.warn(`[Native Parser] Language not supported: ${language}`);
    return [];
  }

  try {
    const parser = new Parser();
    parser.setLanguage(languageModule);
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

    return functions;
  } catch (error: any) {
    console.error(`[Native Parser] Error parsing ${filePath || 'unknown file'}:`, error.message || error);
    return [];
  }
}

// Language detection
function detectLanguage(filePath?: string): string {
  if (!filePath) return 'javascript';

  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'tsx',
    'py': 'python',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'cs': 'csharp',
    'php': 'php',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'sh': 'bash',
    'bash': 'bash',
  };

  return map[ext || ''] || 'javascript';
}

// Function extraction
function collectFunctions(
  node: Parser.SyntaxNode,
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
        const paramsNode = node.childForFieldName('parameters') || node.childForFieldName('parameter');
        if (paramsNode) {
          startLine = paramsNode.startPosition.row + 1;
        }
      }

      const bodyNode = node.childForFieldName('body');
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

function resolveFunctionName(node: Parser.SyntaxNode, code: string): string {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return code.slice(nameNode.startIndex, nameNode.endIndex);
  return `anonymous_${node.startIndex}`;
}

function resolveClassName(node: Parser.SyntaxNode, code: string): string {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    return code.slice(nameNode.startIndex, nameNode.endIndex);
  }

  const identifierNode = node.namedChildren?.find((child: Parser.SyntaxNode) =>
    child.type?.includes('identifier') || child.type === 'type_identifier'
  );
  if (identifierNode) {
    return code.slice(identifierNode.startIndex, identifierNode.endIndex);
  }

  return `anonymous_class_${node.startIndex}`;
}

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
