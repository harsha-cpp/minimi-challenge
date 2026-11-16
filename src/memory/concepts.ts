/** Small, inspectable vocabulary for lexical recall. These are topic aliases, not factual equivalences or embeddings. */
export const MEMORY_CONCEPTS = [
  { id: "crm", aliases: ["crm", "crms", "customer relationship management", "customer management", "sales software", "sales tools"] },
  { id: "database-hosting", aliases: ["postgres", "postgresql", "managed database", "database hosting", "hosted database", "database provider"] },
  { id: "pricing", aliases: ["pricing", "price", "prices", "cost", "costs", "subscription fee"] },
  { id: "deployment", aliases: ["deployment", "deploy", "hosting", "host", "cloud infrastructure"] },
  { id: "authentication", aliases: ["authentication", "auth", "login", "sign in", "sign-in"] },
] as const;
export interface MemoryConcept { id: string; aliases: readonly string[] }
export const MEMORY_RETRIEVAL_LIMITS = { concepts: 3, aliasesPerConcept: 6, candidateIds: 200, textChars: 16000 } as const;
const normalize = (text: string) => text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function includesPhrase(text: string, phrase: string): boolean { return (` ${text} `).includes(` ${normalize(phrase)} `); }
export function memoryConcepts(text: string): MemoryConcept[] {
  const normalized = normalize(text.slice(0, 8000));
  return MEMORY_CONCEPTS.filter(concept => concept.aliases.some(alias => includesPhrase(normalized, alias)))
    .slice(0, MEMORY_RETRIEVAL_LIMITS.concepts);
}
export function conceptMatches(text: string, concepts: MemoryConcept[]): number {
  const normalized = normalize(text.slice(0, MEMORY_RETRIEVAL_LIMITS.textChars));
  // Matching several aliases of one concept must not inflate confidence.
  return concepts.filter(concept => concept.aliases.some(alias => includesPhrase(normalized, alias))).length;
}
export function memoryTopicLabels(text: string): string[] {
  return memoryConcepts(text).map(concept => concept.id.replaceAll("-", " "));
}
