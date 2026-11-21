import { createHash } from "node:crypto";
import { caseInputHash, generationInput, type BenchmarkCase } from "../benchmark/score.ts";
import { parseInstant } from "../../src/time/instant.ts";

export const QUALITY_PROTOCOL_VERSION = "search-quality-v1";
export const QUALITY_SLICES = ["simple-fact", "volatile-fact", "direct-source", "comparison", "complete-list",
  "conflicting-sources", "insufficient-evidence", "historical", "conversation-recall", "adversarial-multilingual"] as const;
export type QualitySlice = typeof QUALITY_SLICES[number];
export interface ReferenceEvidence { url: string; capturedAt: string; text: string; sha256: string; relevance: 0 | 1 | 2 | 3 }
export interface QualityCase {
  input: BenchmarkCase;
  slice: QualitySlice;
  split: "development" | "heldout";
  /** Authored topic/entity/time group, shared by paraphrases. Automatic text similarity is not a split guarantee. */
  clusterId: string;
  track: "live-quality" | "injected-failure" | "frozen-conversation";
  labels: { status: "pending" | "adjudicated"; requiredFacets: string[]; acceptableUncertainty: string;
    references: ReferenceEvidence[]; adjudicators: string[]; reconciled: boolean };
}
export interface Annotation {
  caseId: string; sampleHash: string; engine: string;
  scorer: "human" | "automated"; scorerId: string; blinded: boolean;
  materialClaims: number; correctClaims: number; citedClaims: number; supportedCitedClaims: number;
  requiredFacets: number; coveredFacets: number;
  confidentFalseAssertions: number; unnecessaryRefusal: boolean; temporalCorrect: boolean;
  /** Reconciled human reference judgment, distinct from a first-pass label or model judgment. */
  adjudicated?: boolean;
}
export const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const exactTextHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const projectGenerationInput = (item: QualityCase) => generationInput(item.input);
export function validateDataset(cases: QualityCase[]): void {
  if (!Array.isArray(cases) || !cases.length || cases.length > 10_000) throw new Error("Expected a bounded nonempty quality dataset.");
  const ids = new Set<string>(), groups = new Map<string, string>(), questions = new Map<string, string>();
  for (const item of cases) {
    if (!item || !item.input || typeof item.input.id !== "string" || !item.input.id || ids.has(item.input.id)
      || typeof item.input.question !== "string" || !item.input.question.trim() || item.input.question.length > 8000 || !QUALITY_SLICES.includes(item.slice)
      || typeof item.clusterId !== "string" || !item.clusterId.trim() || !["development", "heldout"].includes(item.split)
      || !["live-quality", "injected-failure", "frozen-conversation"].includes(item.track)
      || !item.labels || !["pending", "adjudicated"].includes(item.labels.status)
      || !Array.isArray(item.labels.references) || !Array.isArray(item.labels.requiredFacets) || !Array.isArray(item.labels.adjudicators)
      || item.labels.requiredFacets.some(facet => typeof facet !== "string" || !facet.trim())
      || new Set(item.labels.requiredFacets).size !== item.labels.requiredFacets.length
      || item.labels.adjudicators.some(id => typeof id !== "string" || !id.trim())
      || new Set(item.labels.adjudicators).size !== item.labels.adjudicators.length
      || typeof item.labels.reconciled !== "boolean" || typeof item.labels.acceptableUncertainty !== "string") throw new Error("Invalid quality case or duplicate ID.");
    if (item.input.asOf !== undefined && !validInstant(item.input.asOf)) throw new Error(`Invalid viewpoint for ${item.input.id}`);
    if (item.input.tz !== undefined) {
      try { new Intl.DateTimeFormat("en", { timeZone: item.input.tz }); }
      catch { throw new Error(`Invalid timezone for ${item.input.id}`); }
    }
    if (item.input.history !== undefined && (!Array.isArray(item.input.history) || item.input.history.length > 100
      || item.input.history.some(row => !row || !validInstant(row.at) || typeof row.question !== "string" || typeof row.answer !== "string"))) throw new Error(`Invalid history for ${item.input.id}`);
    ids.add(item.input.id);
    const normalizedQuestion = item.input.question.toLowerCase().replace(/\s+/g, " ").trim();
    for (const [map, key] of [[groups, item.clusterId], [questions, normalizedQuestion]] as const) {
      if (map.has(key) && map.get(key) !== item.split) throw new Error(`Split leakage for ${item.input.id}: topic/entity/time group or duplicate question crosses splits.`);
      map.set(key, item.split);
    }
    const inputKey = caseInputHash({ ...item.input, question: normalizedQuestion });
    if (questions.has(`input:${inputKey}`)) throw new Error(`Duplicate generation input: ${item.input.id}`);
    questions.set(`input:${inputKey}`, item.split);
    if (item.labels.status === "adjudicated" && (!item.labels.references.length || !item.labels.requiredFacets.length || !item.labels.adjudicators.length || !item.labels.reconciled)) {
      throw new Error(`Adjudicated labels require captured reference evidence and reconciled attribution: ${item.input.id}`);
    }
    for (const reference of item.labels.references) {
      if (!reference || typeof reference.text !== "string" || !reference.text.trim() || exactTextHash(reference.text) !== reference.sha256 || !validInstant(reference.capturedAt)
        || !/^https?:$/.test(new URL(reference.url).protocol) || !Number.isInteger(reference.relevance) || reference.relevance < 0 || reference.relevance > 3) {
        throw new Error(`Invalid frozen reference evidence for ${item.input.id}`);
      }
    }
  }
}
const validInstant = (value: unknown): value is string => parseInstant(value) !== null;
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validateAnnotation(annotation: Annotation): void {
  if (!annotation || typeof annotation.caseId !== "string" || !annotation.caseId || !validHash(annotation.sampleHash)
    || typeof annotation.scorerId !== "string" || !annotation.scorerId || typeof annotation.engine !== "string" || !annotation.engine
    || !["human", "automated"].includes(annotation.scorer) || typeof annotation.blinded !== "boolean"
    || typeof annotation.unnecessaryRefusal !== "boolean" || typeof annotation.temporalCorrect !== "boolean"
    || (annotation.adjudicated !== undefined && typeof annotation.adjudicated !== "boolean")) throw new Error("Invalid annotation identity.");
  for (const field of ["materialClaims", "correctClaims", "citedClaims", "supportedCitedClaims", "requiredFacets", "coveredFacets", "confidentFalseAssertions"] as const) {
    if (!Number.isSafeInteger(annotation[field]) || annotation[field] < 0 || annotation[field] > 10000) throw new Error(`Invalid annotation count ${field}`);
  }
  if (annotation.correctClaims > annotation.materialClaims || annotation.citedClaims > annotation.materialClaims
    || annotation.supportedCitedClaims > annotation.citedClaims || annotation.coveredFacets > annotation.requiredFacets
    || annotation.confidentFalseAssertions > annotation.materialClaims) throw new Error("Annotation counts are inconsistent.");
}
const fraction = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
export function annotationMetrics(annotations: Annotation[]) {
  for (const annotation of annotations) validateAnnotation(annotation);
  const sum = (field: keyof Annotation) => annotations.reduce((total, annotation) => total + Number(annotation[field]), 0);
  return { samples: annotations.length, materialClaimCorrectness: fraction(sum("correctClaims"), sum("materialClaims")),
    citationSupport: fraction(sum("supportedCitedClaims"), sum("citedClaims")),
    materialClaimCitationCoverage: fraction(sum("supportedCitedClaims"), sum("materialClaims")),
    requiredFacetCoverage: fraction(sum("coveredFacets"), sum("requiredFacets")), confidentFalseAssertions: sum("confidentFalseAssertions"),
    unnecessaryRefusals: annotations.filter(item => item.unnecessaryRefusal).length,
    temporalCorrectRate: annotations.length ? annotations.filter(item => item.temporalCorrect).length / annotations.length : null };
}
export function calibration(human: Annotation[], automated: Annotation[]) {
  const pairs: Array<{ human: Annotation; automated: Annotation }> = [];
  const seen = new Set<string>();
  for (const candidate of human) {
    validateAnnotation(candidate);
    if (candidate.scorer !== "human" || !candidate.blinded || !candidate.adjudicated) continue;
    const key = `${candidate.caseId}:${candidate.sampleHash}:${candidate.engine}`;
    if (seen.has(key)) continue;
    const match = automated.find(item => item.scorer === "automated" && item.caseId === candidate.caseId && item.sampleHash === candidate.sampleHash && item.engine === candidate.engine);
    if (match) { seen.add(key); validateAnnotation(match); pairs.push({ human: candidate, automated: match }); }
  }
  const metrics = ["materialClaimCorrectness", "citationSupport", "requiredFacetCoverage"] as const;
  return { pairedSamples: pairs.length, pairedCases: new Set(pairs.map(pair => pair.human.caseId)).size,
    errors: Object.fromEntries(metrics.map(key => {
      const errors = pairs.map(pair => [annotationMetrics([pair.human])[key], annotationMetrics([pair.automated])[key]])
        .filter((values): values is [number, number] => values[0] !== null && values[1] !== null)
        .map(([reference, judged]) => Math.abs(reference - judged));
      return [key, { meanAbsoluteError: errors.length ? errors.reduce((sum, error) => sum + error, 0) / errors.length : null, samples: errors.length }];
    })) };
}
export interface PairedObservation { caseId: string; clusterId: string; slice: QualitySlice; baseline: number; candidate: number }
/** Bootstrap the authored question clusters, so repeated queries do not count as independent questions. */
export function pairedReport(observations: PairedObservation[], iterations = 2000, seed = 467) {
  const identities = new Map<string, { clusterId: string; slice: QualitySlice }>();
  for (const row of observations) {
    if (!row.caseId || !row.clusterId || !QUALITY_SLICES.includes(row.slice) || ![row.baseline, row.candidate].every(Number.isFinite)) throw new Error("Invalid paired score.");
    const prior = identities.get(row.caseId);
    if (prior && (prior.clusterId !== row.clusterId || prior.slice !== row.slice)) throw new Error("A repeated case cannot change its cluster or slice.");
    identities.set(row.caseId, row);
  }
  const report = (rows: PairedObservation[]) => {
    // Average repeat observations per question first, then questions per cluster. Repeats cannot
    // inflate effective sample size or dominate a cluster merely because one question ran more often.
    const cases = new Map<string, { clusterId: string; changes: number[] }>();
    for (const row of rows) {
      const item = cases.get(row.caseId) ?? { clusterId: row.clusterId, changes: [] };
      item.changes.push(row.candidate - row.baseline); cases.set(row.caseId, item);
    }
    const groups = new Map<string, number[]>();
    for (const item of cases.values()) {
      const values = groups.get(item.clusterId) ?? []; values.push(item.changes.reduce((sum, value) => sum + value, 0) / item.changes.length); groups.set(item.clusterId, values);
    }
    const clusterMeans = [...groups.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length);
    const change = clusterMeans.length ? clusterMeans.reduce((sum, value) => sum + value, 0) / clusterMeans.length : null;
    if (clusterMeans.length < 2) return { observations: rows.length, questions: cases.size, clusters: clusterMeans.length, absoluteChange: change, interval95: null };
    let state = seed >>> 0;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
    const draws = Array.from({ length: iterations }, () => Array.from({ length: clusterMeans.length }, () => clusterMeans[Math.floor(random() * clusterMeans.length)]!)
      .reduce((sum, value) => sum + value, 0) / clusterMeans.length).sort((a, b) => a - b);
    return { observations: rows.length, questions: cases.size, clusters: clusterMeans.length, absoluteChange: change,
      interval95: [draws[Math.floor(draws.length * 0.025)]!, draws[Math.min(draws.length - 1, Math.floor(draws.length * 0.975))]!] };
  };
  if (!Number.isInteger(iterations) || iterations < 100 || iterations > 10_000) throw new Error("Bootstrap iterations must be 100 to 10000.");
  return { overall: report(observations), slices: Object.fromEntries(QUALITY_SLICES.map(slice => [slice, report(observations.filter(item => item.slice === slice))])) };
}

export interface ReleaseEvidence {
  datasetHash: string;
  annotations: Annotation[];
  /** Include unsuccessful attempts; cost includes generation, search, review, repair and enrichment. */
  liveRuns: Array<{ runId: string; caseId: string; engine: string; inputHash: string; basis: "live";
    sampleHash: string; capturedAt: string; cache: "warm" | "cold"; costDollars: number | null; succeeded: boolean }>;
  frozenRuns?: Array<{ runId: string; caseId: string; engine: string; inputHash: string; basis: "frozen-conversation" | "frozen-evidence";
    sampleHash: string; capturedAt: string }>;
  /** One aggregate per declared workload; duplicates must be combined rather than cherry-picked. */
  loads: Array<{ activeUsers: number; basis: "live" | "mock"; acceptedNonCancelled: number; durableCompleted: number; rejected: number;
    p95WithinDeclaredTarget: boolean; boundedProviderBudget: boolean }>;
  paired?: PairedObservation[];
  drills: Partial<Record<"regressions" | "isolation" | "duplicate" | "crashRestart" | "lostCompletion" | "restore" | "shutdown", boolean>>;
  adjudication: { doubleLabelledCaseIds: string[]; disagreementsReconciled: boolean };
  campaign: { engine: string; generationModel: string; judgeModel: string; costCapDollars: number;
    predeclaredTargets: boolean; primaryObjective: string; judgeIndependent: boolean };
}

export function validateReleaseEvidence(cases: QualityCase[], evidence: ReleaseEvidence): void {
  if (!evidence || evidence.datasetHash !== digest(cases) || !Array.isArray(evidence.annotations) || !Array.isArray(evidence.liveRuns)
    || !Array.isArray(evidence.loads) || !evidence.campaign || !evidence.adjudication || !evidence.drills
    || !Array.isArray(evidence.adjudication.doubleLabelledCaseIds) || typeof evidence.adjudication.disagreementsReconciled !== "boolean"
    || ![evidence.campaign.engine, evidence.campaign.generationModel, evidence.campaign.judgeModel, evidence.campaign.primaryObjective]
      .every(value => typeof value === "string" && value.trim())
    || typeof evidence.campaign.predeclaredTargets !== "boolean" || typeof evidence.campaign.judgeIndependent !== "boolean"
    || !Number.isFinite(evidence.campaign.costCapDollars) || evidence.campaign.costCapDollars <= 0) throw new Error("Invalid release evidence or dataset identity.");
  const byId = new Map(cases.map(item => [item.input.id, item]));
  const runIds = new Set<string>(), identities = new Set<string>(), sampleIds = new Set<string>();
  for (const run of evidence.liveRuns) {
    const item = byId.get(run.caseId);
    const identity = `${run.caseId}:${run.capturedAt}`;
    if (!item || item.split !== "heldout" || item.track !== "live-quality" || !run.runId || runIds.has(run.runId) || identities.has(identity)
      || run.engine !== evidence.campaign.engine || run.basis !== "live" || run.inputHash !== caseInputHash(item.input)
      || !validHash(run.sampleHash) || !validInstant(run.capturedAt) || !["warm", "cold"].includes(run.cache)
      || typeof run.succeeded !== "boolean" || (run.costDollars !== null && (!Number.isFinite(run.costDollars) || run.costDollars < 0))) throw new Error("Invalid, duplicate, foreign or mismatched live run.");
    runIds.add(run.runId); identities.add(identity); sampleIds.add(`${run.caseId}:${run.sampleHash}:${run.engine}`);
  }
  if (evidence.frozenRuns !== undefined && !Array.isArray(evidence.frozenRuns)) throw new Error("Invalid frozen track records.");
  for (const run of evidence.frozenRuns ?? []) {
    const item = byId.get(run.caseId);
    if (!item || item.split !== "heldout" || item.track === "injected-failure" || !run.runId || runIds.has(run.runId)
      || !["frozen-conversation", "frozen-evidence"].includes(run.basis)
      || (run.basis === "frozen-conversation" && item.track !== "frozen-conversation")
      || run.engine !== evidence.campaign.engine || run.inputHash !== caseInputHash(item.input)
      || !validHash(run.sampleHash) || !validInstant(run.capturedAt)) throw new Error("Invalid, duplicate, foreign or mismatched frozen run.");
    runIds.add(run.runId); sampleIds.add(`${run.caseId}:${run.sampleHash}:${run.engine}`);
  }
  const annotationIds = new Set<string>(), finalIds = new Set<string>();
  for (const annotation of evidence.annotations) {
    validateAnnotation(annotation);
    const item = byId.get(annotation.caseId);
    const identity = `${annotation.caseId}:${annotation.sampleHash}:${annotation.engine}`;
    const id = `${identity}:${annotation.scorer}:${annotation.scorerId}`;
    if (!item || item.split !== "heldout" || item.track === "injected-failure" || annotation.engine !== evidence.campaign.engine
      || annotation.requiredFacets !== item.labels.requiredFacets.length || annotationIds.has(id) || !sampleIds.has(identity)
      || (annotation.scorer === "automated" && annotation.scorerId !== evidence.campaign.judgeModel)) throw new Error("Invalid, duplicate, foreign or mismatched annotation.");
    annotationIds.add(id);
    if (annotation.scorer === "human" && annotation.adjudicated) {
      if (!annotation.blinded || !item.labels.adjudicators.includes(annotation.scorerId) || finalIds.has(identity)) throw new Error("A sample requires exactly one reconciled blinded human reference.");
      finalIds.add(identity);
    }
  }
  const doubleLabels = evidence.adjudication.doubleLabelledCaseIds;
  if (new Set(doubleLabels).size !== doubleLabels.length || doubleLabels.some(id => !byId.has(id))) throw new Error("Invalid double-label attribution.");
  for (const id of doubleLabels) {
    const scores = evidence.annotations.filter(annotation => annotation.caseId === id && annotation.scorer === "human" && annotation.blinded);
    // Both initial labels must concern the same output, with two distinct human identities.
    const shared = scores.some(score => new Set(scores.filter(other => other.sampleHash === score.sampleHash && other.engine === score.engine).map(other => other.scorerId)).size >= 2);
    if (!shared) throw new Error("Double-label claims require two distinct blinded human annotations on the same output.");
  }
  const loadIds = new Set<number>();
  for (const load of evidence.loads) {
    if (!Number.isSafeInteger(load.activeUsers) || load.activeUsers < 1 || loadIds.has(load.activeUsers) || !["live", "mock"].includes(load.basis)
      || ![load.acceptedNonCancelled, load.durableCompleted, load.rejected].every(count => Number.isSafeInteger(count) && count >= 0)
      || load.durableCompleted > load.acceptedNonCancelled || typeof load.p95WithinDeclaredTarget !== "boolean"
      || typeof load.boundedProviderBudget !== "boolean") throw new Error("Invalid or duplicate workload aggregate.");
    loadIds.add(load.activeUsers);
  }
  if (evidence.paired !== undefined) {
    if (!Array.isArray(evidence.paired) || evidence.paired.some(row => {
      const item = byId.get(row.caseId);
      return !item || item.split !== "heldout" || item.track === "injected-failure" || item.clusterId !== row.clusterId || item.slice !== row.slice;
    })) throw new Error("Foreign or mismatched paired observations.");
    pairedReport(evidence.paired);
  }
}
/** Unknown, synthetic, or uncalibrated results cannot satisfy a production release gate. */
export function releaseGates(cases: QualityCase[], evidence?: ReleaseEvidence) {
  validateDataset(cases);
  const gates: Array<{ id: string; passed: boolean; detail: string }> = [];
  const add = (id: string, passed: boolean, detail: string) => gates.push({ id, passed, detail });
  let integrityError: string | undefined;
  try { if (evidence) validateReleaseEvidence(cases, evidence); }
  catch (error) { integrityError = error instanceof Error ? error.message : "Invalid release evidence."; evidence = undefined; }
  add("evidence-integrity", Boolean(evidence) && !integrityError, integrityError ?? (evidence ? "Evidence IDs, hashes, counts, provenance and attribution validated" : "No empirical release evidence supplied"));
  const heldout = cases.filter(item => item.split === "heldout" && item.track !== "injected-failure");
  const heldoutIds = new Set(heldout.map(item => item.input.id));
  const human = evidence?.annotations.filter(item => item.scorer === "human" && item.blinded && item.adjudicated
    && heldoutIds.has(item.caseId) && item.engine === evidence.campaign.engine) ?? [];
  const automatic = evidence?.annotations.filter(item => item.scorer === "automated" && heldoutIds.has(item.caseId) && item.engine === evidence.campaign.engine) ?? [];
  const scores = annotationMetrics(human);
  const calibrated = calibration(human, automatic);
  add("declared-slice-coverage", QUALITY_SLICES.every(slice => heldout.some(item => item.slice === slice)
    && human.some(annotation => heldout.some(item => item.input.id === annotation.caseId && item.slice === slice))),
    "Every declared quality slice needs held-out, non-injected cases with reconciled human scores");
  add("adjudicated-heldout", heldout.length >= 20 && heldout.every(item => item.labels.status === "adjudicated" && human.some(score => score.caseId === item.input.id)),
    `${heldout.filter(item => item.labels.status === "adjudicated").length}/${heldout.length} held-out cases have adjudicated references; 20+ required`);
  const errors = Object.values(calibrated.errors) as Array<{ meanAbsoluteError: number | null; samples: number }>;
  add("calibrated-independent-judge", calibrated.pairedCases >= 20 && errors.every(item => item.samples >= 20 && item.meanAbsoluteError !== null && item.meanAbsoluteError <= 0.1)
    && evidence?.campaign.judgeIndependent === true && evidence.campaign.judgeModel !== evidence.campaign.generationModel
    && evidence?.adjudication.disagreementsReconciled === true && evidence.adjudication.doubleLabelledCaseIds.length >= Math.max(5, Math.ceil(heldout.length * 0.1)),
    `${calibrated.pairedSamples} blind human/automated pairs; independent judge, double labels and reconciliation required`);
  add("claim-support-and-facets", (scores.citationSupport ?? -1) >= 0.95 && (scores.requiredFacetCoverage ?? -1) >= 0.90
    && scores.confidentFalseAssertions === 0 && scores.temporalCorrectRate === 1,
    "Require >=95% cited-claim support, >=90% facet coverage, correct temporal perspective and zero critical confident false assertions");
  const liveEligible = heldout.filter(item => item.track === "live-quality");
  add("live-repeat-track", liveEligible.length > 0 && liveEligible.every(item => {
    const runs = evidence?.liveRuns.filter(run => run.caseId === item.input.id) ?? [];
    return runs.length >= 3 && runs.some(run => run.succeeded) && new Set(runs.map(run => run.capturedAt.slice(0, 10))).size >= 2
      && runs.some(run => run.cache === "warm") && runs.some(run => run.cache === "cold");
  }), "Each live held-out case requires >=3 retained runs over >=2 days, declaring warm/cold caches and failures");
  add("declared-workloads", [1, 4, 8].every(users => evidence?.loads.some(load => load.activeUsers === users && load.basis === "live" && load.acceptedNonCancelled >= 100
    && load.durableCompleted / load.acceptedNonCancelled >= 0.99 && load.p95WithinDeclaredTarget && load.boundedProviderBudget)),
    "Require declared 1/4/8-user loads, >=100 accepted turns per load, >=99% durable completion, latency and budget gates");
  const requiredDrills = ["regressions", "isolation", "duplicate", "crashRestart", "lostCompletion", "restore", "shutdown"] as const;
  add("recovery-and-isolation", requiredDrills.every(drill => evidence?.drills[drill] === true), "All correctness, ownership and recovery drills must pass");
  const knownCosts = evidence?.liveRuns.every(run => run.costDollars !== null && Number.isFinite(run.costDollars) && run.costDollars >= 0);
  const cost = evidence?.liveRuns.reduce((sum, run) => sum + (run.costDollars ?? 0), 0) ?? null;
  add("predeclared-cost-and-quality", Boolean(evidence && evidence.liveRuns.length && knownCosts && evidence.campaign.predeclaredTargets
    && evidence.campaign.primaryObjective.trim() && evidence.campaign.costCapDollars > 0 && cost !== null && cost <= evidence.campaign.costCapDollars),
    "Require frozen targets/objective and measured campaign cost inside an explicit cap; unknown usage is not zero");
  const paired = evidence?.paired ? pairedReport(evidence.paired) : null;
  add("paired-regression-margin", Boolean(paired && heldout.every(item => evidence?.paired?.some(row => row.caseId === item.input.id))
    && paired.overall.questions >= 20 && paired.overall.clusters >= 2
    && paired.overall.absoluteChange !== null && paired.overall.absoluteChange >= -0.02
    && Object.values(paired.slices).every(slice => slice.absoluteChange === null || slice.absoluteChange >= -0.02)),
    "Paired held-out quality must retain the declared 2pp margin overall and per measured slice; repeated questions are clustered");
  const supportedCompletedAnswers = evidence?.liveRuns.filter(run => run.succeeded && human.some(annotation => annotation.caseId === run.caseId
    && annotation.sampleHash === run.sampleHash && annotation.materialClaims > 0 && annotation.correctClaims === annotation.materialClaims
    && annotation.citedClaims > 0 && annotation.supportedCitedClaims / annotation.citedClaims >= 0.95
    && annotation.requiredFacets > 0 && annotation.coveredFacets / annotation.requiredFacets >= 0.90 && annotation.confidentFalseAssertions === 0)).length ?? 0;
  return { ready: gates.every(gate => gate.passed), gates, humanMetrics: scores,
    humanSlices: Object.fromEntries(QUALITY_SLICES.map(slice => [slice, annotationMetrics(human.filter(annotation =>
      cases.find(item => item.input.id === annotation.caseId)?.slice === slice))])), calibration: calibrated, paired,
    operationalCostDollars: knownCosts && evidence?.liveRuns.length ? cost : null, supportedCompletedAnswers,
    costPerSupportedCompletedAnswer: knownCosts && evidence?.liveRuns.length && supportedCompletedAnswers ? cost! / supportedCompletedAnswers : null };
}
