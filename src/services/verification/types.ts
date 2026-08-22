export type VerificationRole = "implementation-worker" | "verifier";

export type VerificationIsolation = {
  workspaceRoot: string;
  snapshotRoot: string;
  tempRoot: string;
};

export type VerificationContextFields = {
  agentId?: unknown;
  verificationContractId?: string;
  verificationRole?: VerificationRole;
  verificationIsolation?: VerificationIsolation;
  recordVerificationFileMutation?: (filePath: string) => void;
  recordVerificationOpaqueMutation?: (reason: string) => void;
};
