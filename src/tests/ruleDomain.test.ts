import { describe, expect, it } from 'vitest';
import { evaluateSample } from '../domain/conditionEvaluator';
import { validateField, validateProject } from '../domain/fieldValidation';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { BusinessRule, PredicateCondition, RuleField, RuleProject } from '../models/ruleModel';

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

describe('out-of-range condition warnings', () => {
  const narrowedAmount = (max: number): RuleField => ({ ...amount, max });
  const withAmount = (rules: BusinessRule[], max = 1200): RuleProject => project(rules, [narrowedAmount(max), tier, active]);

  it('warns on the field and rule once a threshold falls outside the narrowed range, and clears after adjustment', () => {
    const issues = validateProject(withAmount([makeRule('vip', amountAtLeast(1500))]));
    const warning = issues.find((issue) => issue.code === 'condition-out-of-range');
    expect(warning).toMatchObject({ severity: 'warning', fieldId: 'amount', ruleId: 'vip' });
    expect(warning?.message).toContain('金额');
    expect(warning?.message).toContain('0 ~ 1200');
    expect(issues.some((issue) => issue.severity === 'error')).toBe(false);
    expect(validateProject(withAmount([makeRule('vip', amountAtLeast(1200))]))).toEqual([]);
  });

  it('flags exactly the operators and ranges that can no longer be satisfied', () => {
    const cases: Array<[PredicateCondition, boolean]> = [
      [{ kind: 'predicate', fieldId: 'amount', operator: 'gt', value: 1200 }, true],
      [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 1200 }, false],
      [{ kind: 'predicate', fieldId: 'amount', operator: 'eq', value: 1201 }, true],
      [{ kind: 'predicate', fieldId: 'amount', operator: 'eq', value: 1200 }, false],
      [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 0 }, true],
      [{ kind: 'predicate', fieldId: 'amount', operator: 'lte', value: 0 }, false],
      [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 1300, max: 2000 } }, true],
      [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 1000, max: 2000 } }, false],
    ];
    for (const [condition, shouldWarn] of cases) {
      const issues = validateProject(withAmount([makeRule('r', { kind: 'group', operator: 'and', conditions: [condition] })]));
      expect(issues.some((issue) => issue.code === 'condition-out-of-range')).toBe(shouldWarn);
    }
  });

  it('keeps existing validation problems as errors', () => {
    const issues = validateProject(project([makeRule('bad', amountAtLeast(10))], [{ ...amount, min: 10, max: 0 }, tier, active]));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.severity === 'error')).toBe(true);
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
