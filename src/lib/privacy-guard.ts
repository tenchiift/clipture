import type { PrivacyScanResult } from '../types/clip';

interface SecretPattern {
  name: string;
  regex: RegExp;
  riskLevel: 'medium' | 'high';
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'OpenAI API Key',
    regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
    riskLevel: 'high',
  },
  {
    name: 'Google / Gemini API Key',
    regex: /\bAIza[0-9A-Za-z_-]{30,}\b/,
    riskLevel: 'high',
  },
  {
    name: 'GitHub Token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/,
    riskLevel: 'high',
  },
  {
    name: 'AWS Access Key ID',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    riskLevel: 'high',
  },
  {
    name: 'Slack Token',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
    riskLevel: 'high',
  },
  {
    name: 'Stripe Secret Key',
    regex: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}\b/,
    riskLevel: 'high',
  },
  {
    name: 'Private Key Block',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    riskLevel: 'high',
  },
  {
    name: 'JWT Token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    riskLevel: 'high',
  },
  {
    name: '.env Secret Assignment',
    regex:
      /^(?:[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|DATABASE_URL|SUPABASE_SERVICE)[A-Z0-9_]*)\s*=\s*\S+/m,
    riskLevel: 'high',
  },
  {
    name: 'Bearer / Auth Header',
    regex: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/i,
    riskLevel: 'medium',
  },
];

function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number.parseInt(digits[i], 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function containsCreditCard(text: string): boolean {
  const candidates = text.match(/(?:\d[ -]*?){13,19}/g);
  if (!candidates) return false;

  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    return (
      digits.length >= 13 && digits.length <= 19 && passesLuhnCheck(digits)
    );
  });
}

function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksLikeHighEntropySecret(text: string): boolean {
  const trimmed = text.trim();
  // Only flag single-token strings without spaces (not URLs or normal prose)
  if (
    trimmed.length < 24 ||
    trimmed.length > 160 ||
    /\s/.test(trimmed) ||
    /^https?:\/\//i.test(trimmed)
  ) {
    return false;
  }
  return shannonEntropy(trimmed) >= 3.9;
}

export function maskNonApiSecretText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 3) {
    return '••••••••••••';
  }
  return `${trimmed.slice(0, 3)}••••••••••••`;
}

export function maskSecretText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 10) {
    return '••••••••••••';
  }
  if (trimmed.includes('\n')) {
    return trimmed
      .split('\n')
      .map((line) => {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          const key = line.slice(0, eqIdx + 1);
          const val = line.slice(eqIdx + 1).trim();
          return val.length > 4
            ? `${key}••••••••${val.slice(-4)}`
            : `${key}••••••••`;
        }
        return `${line.slice(0, 4)}••••••••••••`;
      })
      .join('\n');
  }
  const prefix = trimmed.slice(0, Math.min(6, Math.floor(trimmed.length / 4)));
  const suffix = trimmed.slice(-4);
  return `${prefix}••••••••••••${suffix}`;
}

/**
 * Privacy Guard: runs 100% locally in the browser/Electron renderer
 * before any clip is persisted to a cloud DB or sent to an LLM API.
 */
export function scanWithPrivacyGuard(text: string): PrivacyScanResult {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(text)) {
      return {
        isSensitive: true,
        reason: pattern.name,
        maskedPreview: maskSecretText(text),
        riskLevel: pattern.riskLevel,
      };
    }
  }

  if (containsCreditCard(text)) {
    return {
      isSensitive: true,
      reason: 'Payment Card Number',
      maskedPreview: maskSecretText(text),
      riskLevel: 'high',
    };
  }

  if (looksLikeHighEntropySecret(text)) {
    return {
      isSensitive: true,
      reason: 'High-Entropy Secret / Token',
      maskedPreview: maskSecretText(text),
      riskLevel: 'medium',
    };
  }

  return {
    isSensitive: false,
    reason: null,
    maskedPreview: text,
    riskLevel: 'none',
  };
}
