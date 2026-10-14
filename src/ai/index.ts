import type { StoryDrafter, TopicClassifier } from '../shared/contracts';
import { list, str, type Row, type StoryDraftResult, type TopicClassification } from '../shared/types';

const STOP = new Set(['a', 'an', 'and', 'for', 'how', 'in', 'into', 'of', 'our', 'the', 'to', 'with']);
const EXPANSIONS: Record<string, string[]> = {
  ae: ['sales', 'salesperson'], salesperson: ['sales', 'hire'], compensation: ['comp', 'commission'], comp: ['compensation', 'commission'],
  enterprise: ['security', 'pilot'], soc2: ['soc', 'security', 'compliance'], usa: ['us', 'united', 'states'],
  fundraising: ['fundraise', 'round'], customers: ['customer', 'sales'], procurement: ['government', 'public'],
};
const clean = (value: string) => value.toLowerCase().replace(/soc\s*2/g, 'soc2').replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (value: string): Set<string> => {
  const result = new Set(clean(value).split(/\s+/).filter(token => token && !STOP.has(token)));
  for (const token of [...result]) for (const extra of EXPANSIONS[token] || []) result.add(extra);
  return result;
};
const title = (value: string) => value.trim().replace(/\s+/g, ' ').replace(/(^|\s)\S/g, letter => letter.toUpperCase()).slice(0, 100);
const overlap = (left: Set<string>, right: Set<string>): number => {
  if (!left.size || !right.size) return 0;
  const common = [...left].filter(token => right.has(token)).length;
  return common / Math.min(left.size, right.size);
};

/** Structured deterministic provider for DEMO/TEST. A live LLM gateway remains a launch gate. */
export class DemoTopicClassifier implements TopicClassifier {
  classify(originalText: string, topics: Row[]): TopicClassification {
    const source = originalText.trim().replace(/\s+/g, ' '), sourceTokens = tokens(source);
    const ranked = topics.filter(topic => str(topic, 'topic_id') !== 'OTHER' && topic.active !== false).map(topic => {
      const aliases = Array.isArray(topic.synonyms) ? topic.synonyms.map(String) : str(topic, 'synonyms').split(/[;|]/).filter(Boolean);
      const candidate = [str(topic, 'topic_label'), ...aliases].join(' ');
      let score = overlap(sourceTokens, tokens(candidate));
      if (clean(candidate).includes(clean(source)) || clean(source).includes(clean(str(topic, 'topic_label')))) score = Math.max(score, .92);
      return { topic, score };
    }).sort((a, b) => b.score - a.score || str(a.topic, 'topic_id').localeCompare(str(b.topic, 'topic_id')));
    const best = ranked[0], confidence = Number(Math.min(.98, best?.score || 0).toFixed(2));
    const decision: TopicClassification['decision'] = confidence >= .66 ? 'map_existing' : confidence >= .34 ? 'needs_review' : 'propose_new';
    const mapped = decision === 'propose_new' ? null : best?.topic ?? null;
    return {
      original_text: source,
      normalized_label: decision === 'map_existing' && mapped ? str(mapped, 'topic_label') : title(source),
      recommended_existing_topic_id: mapped ? str(mapped, 'topic_id') : null,
      recommended_existing_topic_label: mapped ? str(mapped, 'topic_label') : null,
      match_confidence: confidence,
      decision,
      aliases: [...sourceTokens].slice(0, 6),
      reason_short: mapped ? `Founder wording overlaps with ${str(mapped, 'topic_label')}.` : 'No existing topic is a strong enough semantic match.',
    };
  }
}

const sentence = (value: string) => {
  const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, 300);
  return trimmed && !/[.!?]$/.test(trimmed) ? `${trimmed}.` : trimmed;
};

export class DemoStoryDrafter implements StoryDrafter {
  draft(input: { topic_label: string; helped_boolean: boolean; feedback_text: string; sharing_permission: 'anonymous_story' | 'named_story'; permitted_named_companies: string[] }): StoryDraftResult {
    const named = input.sharing_permission === 'named_story' ? input.permitted_named_companies[0] : '';
    const subject = named || 'A Volta founder';
    const detail = sentence(input.feedback_text);
    const draft = detail
      ? `${subject} reported that a founder conversation about ${input.topic_label.toLowerCase()} ${input.helped_boolean ? 'helped: ' : 'did not fully meet what they needed: '}${detail}`
      : `${subject} reported that a Volta conversation about ${input.topic_label.toLowerCase()} ${input.helped_boolean ? 'was useful.' : 'did not help them make progress.'}`;
    return { draft_story: draft, detail_level: detail ? 'HIGH' : 'LOW', source_facts_used: detail ? ['topic', 'helped_boolean', 'feedback_text', ...(named ? ['permitted_company_name'] : [])] : ['topic', 'helped_boolean', ...(named ? ['permitted_company_name'] : [])] };
  }
}
