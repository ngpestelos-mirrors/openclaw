export type AttachedCronJob = {
  id: string;
  name: string;
  enabled: boolean;
  agentId: string | null;
  ownerAgentId: string | null;
  storeKey: string;
  declarationKey: string | null;
  revision?: string;
};
