import { describe, expect, it } from 'vitest';
import { evaluateSample } from '../domain/conditionEvaluator';
import { findRangeWarnings, validateField, validateProject } from '../domain/fieldValidation';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { BusinessRule, RuleField, RuleProject } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };
const active: RuleField = { id: 'active', name: '启用', type: 'boolean' };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id): BusinessRule {
  return { id, name: id, conditions, priority, result };
}

function project(rules: BusinessRule[], fields: RuleField[] = [amount, tier, active]): RuleProject {
  return { id: 'p', title: '测试项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const amountAtLeast = (value: number): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value }] });

describe('field and project validation', () => {
  it('accepts inclusive boundary ranges and rejects reversed or empty definitions', () => {
    expect(validateField({ ...amount, min: 5, max: 5 })).toEqual([]);
    expect(validateField({ ...amount, min: 11, max: 10 }).map((issue) => issue.code)).toContain('number-range-order');
    expect(validateField({ id: 'tier', name: '等级', type: 'enum', enumValues: [] }).map((issue) => issue.code)).toContain('enum-values-required');
  });

  it('checks enum and boolean predicate types without depending on React', () => {
    const rules = [
      makeRule('gold', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' }] }),
      makeRule('active', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true }] }),
    ];
    expect(validateProject(project(rules))).toEqual([]);
    expect(evaluateSample(project(rules), { amount: 12, tier: 'gold', active: true }).matchedRules.map((rule) => rule.id)).toEqual(['gold', 'active']);
  });
});

describe('range warnings for narrowed fields', () => {
  const narrowed: RuleField = { ...amount, min: 0, max: 1200 };

  it('warns when a numeric condition falls entirely outside the field range', () => {
    const rules = [
      makeRule('too-high', amountAtLeast(1500)),
      makeRule('too-low', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 0 }] }),
      makeRule('eq-out', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'eq', value: 1300 }] }),
      makeRule('between-out', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 1300, max: 1400 } }] }),
      makeRule('fine', amountAtLeast(1000)),
    ];
    const warnings = findRangeWarnings(project(rules, [narrowed, tier, active]));
    expect(warnings.map((warning) => warning.ruleId).sort()).toEqual(['between-out', 'eq-out', 'too-high', 'too-low']);
    expect(warnings.every((warning) => warning.code === 'condition-out-of-range' && warning.fieldId === 'amount')).toBe(true);
    const tooHigh = warnings.find((warning) => warning.ruleId === 'too-high');
    expect(tooHigh?.message).toContain('金额');
    expect(tooHigh?.message).toContain('0–1200');
  });

  it('stays silent for partially overlapping ranges and invalid field definitions, but still inspects nested groups', () => {
    const rules = [
      makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 1000, max: 1500 } }] }),
      makeRule('nested', { kind: 'group', operator: 'or', conditions: [
        { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 2000 }] },
      ] }),
    ];
    const warnings = findRangeWarnings(project(rules, [narrowed]));
    expect(warnings.map((warning) => warning.ruleId)).toEqual(['nested']);
    expect(findRangeWarnings(project(rules, [{ ...amount, min: 10, max: 0 }]))).toEqual([]);
  });
});

describe('rule consistency analysis', () => {
  it('finds partial overlap, same-priority conflicts, lower-priority shadowing, unreachable rules, and gaps', () => {
    const rules = [
      makeRule('base', amountAtLeast(500), 10, 'standard'),
      makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 300, max: 800 } }] }, 20, 'special'),
      makeRule('conflict', amountAtLeast(700), 20, 'different'),
      makeRule('hidden', amountAtLeast(750), 5, 'hidden'),
      makeRule('impossible', amountAtLeast(1001), 50, 'out of range'),
      makeRule('no-overlap', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 250 }] }, 1, 'separate'),
    ];
    const analysis = analyzeRules(project(rules));
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'partial' && overlap.ruleBId === 'conflict' && overlap.conflict)).toBe(true);
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'base' && overlap.ruleBId === 'no-overlap')).toBe(false);
    expect(analysis.unreachableRuleIds).toContain('impossible');
    expect(analysis.shadowedRuleIds).toContain('hidden');
    expect(analysis.uncoveredExamples.length).toBeGreaterThan(0);
    expect(analysis.checkedCases).toBeGreaterThan(0);
  });

  it('evaluates OR groups and validates missing sample inputs precisely', () => {
    const rule = makeRule('either', { kind: 'group', operator: 'or', conditions: [
      { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' },
      { kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true },
    ] });
    const result = evaluateSample(project([rule]), { amount: 10, tier: 'basic', active: true });
    expect(result.valid).toBe(true);
    expect(result.winner?.id).toBe('either');
    const missing = evaluateSample(project([rule]), { amount: 10, tier: 'gold' });
    expect(missing.errors).toEqual(['请填写“启用”']);
  });
});
