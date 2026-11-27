import type { ClipCategory, QuickAction } from '../types/clip';

interface ClassificationResult {
  category: ClipCategory;
  tags: string[];
}

export function classifyLocally(
  text: string,
  isSensitive: boolean,
): ClassificationResult {
  if (isSensitive) {
    return {
      category: 'secret',
      tags: ['privacy-guard', 'masked', 'no-ai'],
    };
  }

  const trimmed = text.trim();

  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    try {
      const host = new URL(trimmed).hostname.replace(/^www\./, '');
      return { category: 'url', tags: ['link', host] };
    } catch {
      return { category: 'url', tags: ['link'] };
    }
  }

  if (
    /(TypeError|ReferenceError|SyntaxError|Unhandled|Exception|Traceback|ENOENT|ERR_|at\s+\S+\s+\(.*:\d+:\d+\)|npm error)/i.test(
      trimmed,
    )
  ) {
    return { category: 'error', tags: ['debug', 'stack-trace'] };
  }

  if (
    /(\b(?:const|let|var|function|import|export|interface|type|class|async|await|SELECT|INSERT|CREATE TABLE)\b|=>|\{\s*\n|;\s*$)/m.test(
      trimmed,
    )
  ) {
    return { category: 'code', tags: ['snippet'] };
  }

  return {
    category: 'note',
    tags: trimmed.length > 180 ? ['long-text'] : ['quick-note'],
  };
}

export function getQuickActionsForCategory(
  category: ClipCategory,
  isSensitive: boolean,
): QuickAction[] {
  if (isSensitive || category === 'secret') {
    return [];
  }

  switch (category) {
    case 'error':
      return [
        {
          id: 'explain-error',
          label: 'Explain Error',
          description: 'Diagnose root cause and suggest a fix',
        },
        {
          id: 'summarize',
          label: 'Extract Key Line',
          description: 'Pull the exact failing file and message',
        },
      ];
    case 'code':
      return [
        {
          id: 'explain-error',
          label: 'Explain Code',
          description: 'Break down what this snippet does',
        },
        {
          id: 'format-code',
          label: 'Refactor / Clean',
          description: 'Improve readability and edge cases',
        },
      ];
    case 'url':
      return [
        {
          id: 'open-url',
          label: 'Open in Browser',
          description: 'Launch this URL in your default browser',
        },
        {
          id: 'summarize',
          label: 'Summarize Link',
          description: 'Fetch and summarize page content (Phase 3)',
        },
      ];
    case 'note':
    default:
      return [
        {
          id: 'summarize',
          label: 'Summarize',
          description: 'Condense into bullet-point takeaways',
        },
        {
          id: 'translate',
          label: 'Translate',
          description: 'Translate to English or another language',
        },
      ];
  }
}
