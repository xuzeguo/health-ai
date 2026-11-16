import { z } from 'zod';

export const EvidenceDecision = z.object({ supported: z.boolean(), sourceIds: z.array(z.string()).max(5) }).strict();
export function checkEvidence(input: unknown, allowedIds: Set<string>) {
  const parsed = EvidenceDecision.parse(input);
  if (parsed.sourceIds.some(id => !allowedIds.has(id)) || new Set(parsed.sourceIds).size !== parsed.sourceIds.length
    || parsed.supported !== (parsed.sourceIds.length > 0)) throw new Error('EVIDENCE_DECISION_INVALID');
  return parsed;
}
