import { z } from 'zod';
import {
  evidenceTemplateSchema,
  humanGateSchema,
  type EvidenceRequirementTemplate,
  type HumanGateTemplate,
} from '../catalog-schema.js';
import {
  evidenceRequirementSchema,
  humanGateContractSchema,
  type EvidenceRequirementContract,
  type HumanGateContract,
} from '../../domain/run.js';
import { hashStrictObject } from '../catalog-schema.js';
import {
  cloneStrictJson,
  instantiateEvidenceTemplate,
  parseCompilerInput,
  requireCodeUnitOrder,
  requireSingleRow,
} from '../compiler-runtime.js';
import type { Sha256 } from '../../domain/scalars.js';

const inputSchema = z.strictObject({
  mode: z.literal('PREPARE'),
  evidenceRequirementIds: z.tuple([
    z.literal('delivery-contract'), z.literal('delivery-rollback'), z.literal('delivery-runtime'),
  ]),
  humanGateIds: z.tuple([z.literal('delivery-approval')]),
  evidenceTemplates: z.array(evidenceTemplateSchema).length(74),
  humanGateTemplates: z.tuple([humanGateSchema]),
});

export interface DeliveryPolicyCompileInputV1 {
  readonly mode: 'PREPARE';
  readonly evidenceRequirementIds: readonly ['delivery-contract', 'delivery-rollback', 'delivery-runtime'];
  readonly humanGateIds: readonly ['delivery-approval'];
  readonly evidenceTemplates: readonly EvidenceRequirementTemplate[];
  readonly humanGateTemplates: readonly HumanGateTemplate[];
}

export interface DeliveryTerminalFragmentV1 {
  readonly evidenceRequirements: readonly EvidenceRequirementContract[];
  readonly evidenceRequirementsHash: Sha256;
  readonly requiredHumanGates: readonly HumanGateContract[];
}

export interface DeliveryPolicyCompileResultV1 {
  readonly mode: 'PREPARE';
  readonly fragment: DeliveryTerminalFragmentV1;
}

export const deliveryTerminalFragmentSchema = z.strictObject({
  evidenceRequirements: z.array(evidenceRequirementSchema),
  evidenceRequirementsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  requiredHumanGates: z.array(humanGateContractSchema),
});

// 背景：Delivery 的三项 Evidence 与唯一 approval gate 是完整目录权限，不是 CLI 可选参数。
// 目的：从完整 74-row registry 精确解析三个 NONE contract，并绑定唯一 DELIVERY gate。
// 上下文：输入 tuple 顺序属于 ABI；重排即 strict reject，不会静默排序或猜测缺失项。
export function compileDeliveryPolicy(value: unknown): DeliveryPolicyCompileResultV1 {
  const input = parseCompilerInput(inputSchema, value);
  requireCodeUnitOrder(input.evidenceTemplates.map((template) => template.requirementId), 'Evidence template registry');
  const evidenceRequirements = input.evidenceRequirementIds.map((requirementId) => (
    instantiateEvidenceTemplate(requireSingleRow(
      input.evidenceTemplates,
      (template) => template.requirementId === requirementId,
      `Evidence template '${requirementId}'`,
    ), 'NONE')
  ));
  const requiredHumanGates = input.humanGateIds.map((gateId) => humanGateContractSchema.parse(
    requireSingleRow(input.humanGateTemplates, (gate) => gate.gateId === gateId, `Human gate '${gateId}'`),
  ));
  const parsedRequirements = evidenceRequirements.map((row) => evidenceRequirementSchema.parse(row));
  return cloneStrictJson({
    mode: 'PREPARE',
    fragment: {
      evidenceRequirements: parsedRequirements,
      evidenceRequirementsHash: hashStrictObject(parsedRequirements),
      requiredHumanGates,
    },
  });
}
