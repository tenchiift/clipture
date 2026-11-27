export type CodeTokenType =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'type'
  | 'operator';

export interface CodeToken {
  type: CodeTokenType;
  value: string;
}

export const CODE_TOKEN_CLASSES: Record<
  'dark' | 'light',
  Record<CodeTokenType, string>
> = {
  dark: {
    plain: 'text-[#E2E8F0]',
    keyword: 'text-[#C084FC]',
    string: 'text-[#86EFAC]',
    comment: 'text-[#64748B] italic',
    number: 'text-[#FDBA74]',
    function: 'text-[#60A5FA]',
    type: 'text-[#5EEAD4]',
    operator: 'text-[#94A3B8]',
  },
  light: {
    plain: 'text-[#1E293B]',
    keyword: 'text-[#7C3AED]',
    string: 'text-[#15803D]',
    comment: 'text-[#64748B] italic',
    number: 'text-[#C2410C]',
    function: 'text-[#1D4ED8]',
    type: 'text-[#0F766E]',
    operator: 'text-[#475569]',
  },
};

const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'default',
  'import',
  'from',
  'export',
  'as',
  'type',
  'interface',
  'class',
  'extends',
  'implements',
  'new',
  'async',
  'await',
  'try',
  'catch',
  'finally',
  'throw',
  'typeof',
  'keyof',
  'in',
  'of',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'def',
  'elif',
  'pass',
  'None',
  'True',
  'False',
  'lambda',
  'with',
  'SELECT',
  'FROM',
  'WHERE',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'CREATE',
  'TABLE',
  'JOIN',
  'ON',
  'AND',
  'OR',
  'NOT',
  'AS',
  'ORDER',
  'BY',
]);

const TOKEN_REGEX =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b(?=\s*\()|\b[A-Z][A-Za-z0-9_]*\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b|=>|===|!==|==|!=|<=|>=|&&|\|\||[+\-*/%=<>!&|^~?:;,.()[\]{}])/g;

export function tokenizeCodeLine(line: string): CodeToken[] {
  if (!line) return [{ type: 'plain', value: '' }];
  const tokens: CodeToken[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(TOKEN_REGEX)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      tokens.push({ type: 'plain', value: line.slice(lastIndex, idx) });
    }

    const value = match[0];
    let type: CodeTokenType = 'plain';

    if (
      value.startsWith('//') ||
      value.startsWith('/*') ||
      value.startsWith('#')
    ) {
      type = 'comment';
    } else if (
      value.startsWith('"') ||
      value.startsWith("'") ||
      value.startsWith('`')
    ) {
      type = 'string';
    } else if (/^\d/.test(value)) {
      type = 'number';
    } else if (KEYWORDS.has(value)) {
      type = 'keyword';
    } else if (/^[A-Za-z_$]/.test(value)) {
      const nextChar = line.slice(idx + value.length).match(/^\s*\(/);
      if (nextChar) {
        type = 'function';
      } else if (/^[A-Z]/.test(value)) {
        type = 'type';
      }
    } else {
      type = 'operator';
    }

    tokens.push({ type, value });
    lastIndex = idx + value.length;
  }

  if (lastIndex < line.length) {
    tokens.push({ type: 'plain', value: line.slice(lastIndex) });
  }

  return tokens;
}
