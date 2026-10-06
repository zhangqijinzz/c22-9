import type { PredicateCondition, RuleCondition, RuleField, RuleProject, ValidationIssue } from '../models/ruleModel';

export function validateField(field: RuleField): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!field.name.trim()) issues.push({ code: 'field-name', severity: 'error', fieldId: field.id, message: '字段名称不能为空' });
  if (field.type === 'number') {
    if (!Number.isFinite(field.min) || !Number.isFinite(field.max)) {
      issues.push({ code: 'number-range-required', severity: 'error', fieldId: field.id, message: `${field.name || '数值字段'}需要设置起点和终点` });
    } else if ((field.min as number) > (field.max as number)) {
      issues.push({ code: 'number-range-order', severity: 'error', fieldId: field.id, message: `${field.name}的起点不能大于终点` });
    }
  }
  if (field.type === 'enum') {
    const values = (field.enumValues ?? []).map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) issues.push({ code: 'enum-values-required', severity: 'error', fieldId: field.id, message: `${field.name || '枚举字段'}至少需要一个选项` });
    if (new Set(values).size !== values.length) issues.push({ code: 'enum-values-duplicate', severity: 'error', fieldId: field.id, message: `${field.name}的枚举值不能重复` });
  }
  return issues;
}

export function validateProject(project: RuleProject): ValidationIssue[] {
  const issues = project.fields.flatMap(validateField);
  const fieldIds = new Set(project.fields.map((field) => field.id));
  const fieldById = new Map(project.fields.map((field) => [field.id, field]));
  if (!project.title.trim()) issues.push({ code: 'project-title', severity: 'error', message: '项目名称不能为空' });
  if (project.rules.length === 0) issues.push({ code: 'no-rules', severity: 'error', message: '还没有规则，添加规则后才能执行完整性检查' });
  const ruleNames = new Set<string>();
  for (const rule of project.rules) {
    if (!rule.name.trim()) issues.push({ code: 'rule-name', severity: 'error', ruleId: rule.id, message: '规则名称不能为空' });
    if (ruleNames.has(rule.name.trim())) issues.push({ code: 'duplicate-rule-name', severity: 'error', ruleId: rule.id, message: `规则名称“${rule.name}”重复` });
    ruleNames.add(rule.name.trim());
    if (!Number.isFinite(rule.priority)) issues.push({ code: 'rule-priority', severity: 'error', ruleId: rule.id, message: `${rule.name}的优先级无效` });
    if (!rule.result.trim()) issues.push({ code: 'rule-result', severity: 'error', ruleId: rule.id, message: `${rule.name}需要填写结果` });
    validateCondition(rule.conditions, rule.id, fieldById, fieldIds, issues);
  }
  return issues;
}

function validateCondition(
  condition: RuleCondition,
  ruleId: string,
  fieldById: Map<string, RuleField>,
  fieldIds: Set<string>,
  issues: ValidationIssue[],
): void {
  if (condition.kind === 'group') {
    if (condition.conditions.length === 0) issues.push({ code: 'empty-condition', severity: 'error', ruleId, message: `规则 ${ruleId} 至少需要一个条件` });
    for (const child of condition.conditions) validateCondition(child, ruleId, fieldById, fieldIds, issues);
    return;
  }
  const field = fieldById.get(condition.fieldId);
  if (!fieldIds.has(condition.fieldId) || !field) {
    issues.push({ code: 'missing-field', severity: 'error', ruleId, message: `规则 ${ruleId} 引用了已删除的字段` });
    return;
  }
  if (field.type === 'number') {
    const numericOperator = ['eq', 'gt', 'gte', 'lt', 'lte'].includes(condition.operator);
    const isRange = typeof condition.value === 'object' && condition.value !== null && 'min' in condition.value && 'max' in condition.value;
    if (condition.operator === 'between' && isRange) {
      if (typeof condition.value.min !== 'number' || typeof condition.value.max !== 'number') issues.push({ code: 'condition-type', severity: 'error', ruleId, fieldId: field.id, message: `${ruleId}的数值区间无效` });
      else if (condition.value.min > condition.value.max) issues.push({ code: 'condition-range-order', severity: 'error', ruleId, fieldId: field.id, message: `${ruleId}的区间起点大于终点` });
      else warnIfUnreachable(ruleId, field, condition, issues);
    } else if (!numericOperator || typeof condition.value !== 'number') {
      issues.push({ code: 'condition-type', severity: 'error', ruleId, fieldId: field.id, message: `${ruleId}的数值条件类型不匹配` });
    } else {
      warnIfUnreachable(ruleId, field, condition, issues);
    }
    return;
  }
  if (field.type === 'enum') {
    if ((condition.operator !== 'eq' && condition.operator !== 'notEq') || typeof condition.value !== 'string') {
      issues.push({ code: 'condition-type', severity: 'error', ruleId, fieldId: field.id, message: `${ruleId}的枚举条件类型不匹配` });
    } else if (!(field.enumValues ?? []).includes(condition.value)) {
      issues.push({ code: 'condition-enum', severity: 'error', ruleId, fieldId: field.id, message: `${ruleId}的条件值不在${field.name}的枚举选项中` });
    }
    return;
  }
  if ((condition.operator !== 'isTrue' && condition.operator !== 'isFalse') || typeof condition.value !== 'boolean') {
    issues.push({ code: 'condition-type', severity: 'error', ruleId, fieldId: field.id, message: `${ruleId}的布尔条件类型不匹配` });
  }
}

function warnIfUnreachable(
  ruleId: string,
  field: RuleField,
  condition: PredicateCondition,
  issues: ValidationIssue[],
): void {
  if (!Number.isFinite(field.min) || !Number.isFinite(field.max)) return;
  const min = field.min as number;
  const max = field.max as number;
  if (min > max) return;
  const value = condition.value;
  const reachable = typeof value === 'number'
    ? thresholdReachable(condition.operator, value, min, max)
    : typeof value === 'object' && value !== null && 'min' in value && 'max' in value
      ? value.min <= max && value.max >= min
      : true;
  if (!reachable) {
    issues.push({
      code: 'condition-out-of-range',
      severity: 'warning',
      ruleId,
      fieldId: field.id,
      message: `${ruleId}的条件不在${field.name}的有效范围（${min} ~ ${max}）内，永远不会命中`,
    });
  }
}

function thresholdReachable(operator: PredicateCondition['operator'], value: number, min: number, max: number): boolean {
  switch (operator) {
    case 'eq': return value >= min && value <= max;
    case 'gt': return value < max;
    case 'gte': return value <= max;
    case 'lt': return value > min;
    case 'lte': return value >= min;
    default: return true;
  }
}
