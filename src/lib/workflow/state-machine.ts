export const PROJECT_STATUSES = [
  'draft',
  'pending_owner_confirmation',
  'pending_admin_approval',
  'active',
  'budget_insufficient',
  'paused',
  'settling',
  'archived',
  'cancelled',
  'deleted',
] as const;

export const VIDEO_CARD_STATUSES = [
  'draft',
  'pending_confirmation',
  'active',
  'generating',
  'reviewing',
  'resolution_approval_pending',
  'high_resolution_generating',
  'finalized',
  'sealed',
  'merged',
  'archived',
  'discarded',
] as const;

export const VIDEO_BRANCH_STATUSES = [
  'exploring',
  'candidate',
  'primary',
  'closed',
  'merged',
  'promoted',
] as const;

export type ProjectStatus = typeof PROJECT_STATUSES[number];
export type VideoCardWorkflowStatus = typeof VIDEO_CARD_STATUSES[number];
export type VideoBranchWorkflowStatus = typeof VIDEO_BRANCH_STATUSES[number];

const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ['pending_owner_confirmation', 'pending_admin_approval', 'active', 'cancelled'],
  pending_owner_confirmation: ['pending_admin_approval', 'active', 'cancelled'],
  pending_admin_approval: ['active', 'cancelled'],
  active: ['budget_insufficient', 'paused', 'settling', 'archived', 'cancelled'],
  budget_insufficient: ['active', 'paused', 'settling', 'archived'],
  paused: ['active', 'archived', 'cancelled'],
  settling: ['archived', 'active'],
  archived: [],
  cancelled: [],
  deleted: [],
};

const VIDEO_CARD_TRANSITIONS: Record<VideoCardWorkflowStatus, VideoCardWorkflowStatus[]> = {
  draft: ['pending_confirmation', 'active', 'discarded'],
  pending_confirmation: ['active', 'discarded'],
  active: ['generating', 'reviewing', 'resolution_approval_pending', 'finalized', 'sealed', 'merged', 'archived', 'discarded'],
  generating: ['active', 'reviewing', 'high_resolution_generating', 'finalized', 'discarded'],
  reviewing: ['active', 'resolution_approval_pending', 'finalized', 'sealed', 'discarded'],
  resolution_approval_pending: ['reviewing', 'high_resolution_generating', 'active'],
  high_resolution_generating: ['reviewing', 'finalized', 'active'],
  finalized: ['reviewing', 'sealed', 'archived'],
  sealed: ['active', 'archived'],
  merged: [],
  archived: ['active'],
  discarded: [],
};

const VIDEO_BRANCH_TRANSITIONS: Record<VideoBranchWorkflowStatus, VideoBranchWorkflowStatus[]> = {
  exploring: ['candidate', 'primary', 'closed', 'merged', 'promoted'],
  candidate: ['exploring', 'primary', 'closed', 'merged', 'promoted'],
  primary: ['candidate', 'closed', 'merged', 'promoted'],
  closed: ['exploring'],
  merged: [],
  promoted: [],
};

export function canTransitionProjectStatus(from: string, to: string) {
  return PROJECT_STATUSES.includes(from as ProjectStatus)
    && PROJECT_STATUSES.includes(to as ProjectStatus)
    && PROJECT_TRANSITIONS[from as ProjectStatus].includes(to as ProjectStatus);
}

export function canTransitionVideoCardStatus(from: string, to: string) {
  return VIDEO_CARD_STATUSES.includes(from as VideoCardWorkflowStatus)
    && VIDEO_CARD_STATUSES.includes(to as VideoCardWorkflowStatus)
    && VIDEO_CARD_TRANSITIONS[from as VideoCardWorkflowStatus].includes(to as VideoCardWorkflowStatus);
}

export function canTransitionVideoBranchStatus(from: string, to: string) {
  return VIDEO_BRANCH_STATUSES.includes(from as VideoBranchWorkflowStatus)
    && VIDEO_BRANCH_STATUSES.includes(to as VideoBranchWorkflowStatus)
    && VIDEO_BRANCH_TRANSITIONS[from as VideoBranchWorkflowStatus].includes(to as VideoBranchWorkflowStatus);
}
