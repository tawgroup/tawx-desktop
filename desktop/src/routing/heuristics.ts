/** Heuristic rule matching. Ported from routing/heuristics.go. */

import type { HeuristicRule } from './config.js';
import type { RequestInfo } from './routing.js';

interface CompiledRule {
  rule: HeuristicRule;
  patterns: RegExp[];
  exclusions: RegExp[];
}

/** Evaluates heuristic rules against a request. */
export class HeuristicMatcher {
  private readonly compiled: CompiledRule[];

  /**
   * Keyword patterns are compiled with word boundary anchors for accurate
   * matching.
   */
  constructor(rules: HeuristicRule[]) {
    this.compiled = rules.map((rule) => ({
      rule,
      patterns: (rule.match.keywords ?? []).map((kw) => keywordPattern(kw)),
      exclusions: (rule.match.exclude ?? []).map((ex) => keywordPattern(ex)),
    }));
  }

  /** Returns the route name of the first matching rule, or '' if no rules match. */
  match(info: RequestInfo): string {
    for (const cr of this.compiled) {
      if (this.matchRule(cr, info)) return cr.rule.route;
    }
    return '';
  }

  private matchRule(cr: CompiledRule, info: RequestInfo): boolean {
    const cond = cr.rule.match;

    if (cr.patterns.length > 0) {
      if (!this.matchKeywords(cr.patterns, cr.exclusions, info)) return false;
    }

    if (cond.systemPromptContains) {
      if (!this.matchSystemPrompt(cond.systemPromptContains, info)) return false;
    }

    if (cond.maxTokensLt !== undefined) {
      if (info.maxTokens === undefined || info.maxTokens >= cond.maxTokensLt) return false;
    }

    if (cond.messageLengthLt !== undefined) {
      // Go measures len(msg.Content) in bytes; match that with byteLength, not
      // the UTF-16 code-unit count .length would give.
      let totalLen = 0;
      for (const msg of info.messages) totalLen += Buffer.byteLength(msg.content, 'utf8');
      if (totalLen >= cond.messageLengthLt) return false;
    }

    if (cond.hasTools !== undefined) {
      if (info.hasTools !== cond.hasTools) return false;
    }

    return true;
  }

  private matchKeywords(patterns: RegExp[], exclusions: RegExp[], info: RequestInfo): boolean {
    // build combined text from user messages only; system prompts are matched
    // separately via the system_prompt_contains condition
    let text = '';
    for (const msg of info.messages) {
      if (msg.role.toLowerCase() === 'user') text += msg.content + ' ';
    }

    // check exclusions first; if any exclusion phrase is present, skip keywords
    for (const ex of exclusions) {
      if (ex.test(text)) return false;
    }

    for (const p of patterns) {
      if (p.test(text)) return true;
    }
    return false;
  }

  private matchSystemPrompt(substr: string, info: RequestInfo): boolean {
    for (const msg of info.messages) {
      if (msg.role === 'system') {
        if (msg.content.toLowerCase().includes(substr.toLowerCase())) return true;
      }
    }
    return false;
  }
}

/**
 * Builds a case-insensitive regex for a keyword with word boundary anchors.
 * Boundaries are only added at edges that touch a word character, so
 * keywords like "c++" work correctly.
 */
function keywordPattern(kw: string): RegExp {
  const quoted = escapeRegExp(kw);
  const prefix = kw.length > 0 && isWordChar(kw.charAt(0)) ? '\\b' : '';
  const suffix = kw.length > 0 && isWordChar(kw.charAt(kw.length - 1)) ? '\\b' : '';
  return new RegExp(prefix + quoted + suffix, 'i');
}

function isWordChar(c: string): boolean {
  return /[a-zA-Z0-9_]/.test(c);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
