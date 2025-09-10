import type { UUID } from './index';

export type CapabilityKey =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'export'
  | 'import'
  | 'publish'
  | 'comment'
  | 'price';

export interface Capability {
  key: CapabilityKey;
  label: string;
  enabled: boolean;
  description?: string;
}

export interface ServiceCapabilityGroup {
  id: UUID;
  label: string;
  capabilities: Capability[];
}

export interface ServiceDefinition {
  id: UUID;
  name: string;
  version: string;
  capabilityGroups: ServiceCapabilityGroup[];
}

export type DgpServiceMap = Record<string, ServiceDefinition>;
