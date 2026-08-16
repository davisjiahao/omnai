import { z } from 'zod';

export const WORKSET_MEMBER_STATUSES = [
  'CANDIDATE',
  'RESEARCH_ONLY',
  'OBSERVED_ONLY',
  'ACTIVE',
  'INACTIVE',
] as const;

export type WorksetMemberStatus = (typeof WORKSET_MEMBER_STATUSES)[number];

export const registeredProjectSchema = z.object({
  alias: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  path: z.string().min(1),
  registeredAt: z.string().datetime(),
});

export type RegisteredProject = z.infer<typeof registeredProjectSchema>;

export const projectRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(registeredProjectSchema).default([]),
});

export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;

export const personalConfigSchema = z.object({
  schemaVersion: z.literal(1),
  activeWorkset: z.string().regex(/^WKS-\d{4}$/).nullable().default(null),
});

export type PersonalConfig = z.infer<typeof personalConfigSchema>;

export const worksetMemberSchema = z.object({
  project: z.string().min(1),
  status: z.enum(WORKSET_MEMBER_STATUSES),
  changeId: z.string().regex(/^CHG-\d{4}$/).optional(),
  worktree: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  addedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type WorksetMember = z.infer<typeof worksetMemberSchema>;

export const worksetSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^WKS-\d{4}$/),
  slug: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['OPEN', 'ARCHIVED']).default('OPEN'),
  members: z.array(worksetMemberSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Workset = z.infer<typeof worksetSchema>;
