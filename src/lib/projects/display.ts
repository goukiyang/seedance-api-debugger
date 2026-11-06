import { displayUserName, type DisplayUser } from '@/lib/users/display';

export type ProjectRemovalAction = 'delete' | 'archive' | null;

export type ProjectDisplayInput = {
  name: string;
  type: string;
  owner?: DisplayUser | null;
  can_manage_project?: boolean;
  _count?: {
    tasks?: number;
    reference_albums?: number;
  } | null;
};

export function defaultPersonalProjectName(owner: DisplayUser | null | undefined) {
  const name = displayUserName(owner);
  return name === '未知用户' ? '个人默认项目' : `${name}的默认项目`;
}

export function projectDisplayName(project: Pick<ProjectDisplayInput, 'name' | 'type' | 'owner'>) {
  return project.type === 'personal' && ['', '我的默认项目', '个人空间', '个人默认项目'].includes(project.name.trim())
    ? defaultPersonalProjectName(project.owner) : project.name;
}

export function projectTypeLabel(type: string) {
  if (type === 'personal') return '个人默认';
  if (type === 'team') return '协作项目';
  if (type === 'company') return '公司级项目';
  if (type === 'public') return '预算记账项目';
  if (type === 'system') return '系统项目';
  return '项目';
}

export function projectMetaLabel(project: ProjectDisplayInput) {
  const taskCount = project._count?.tasks || 0;
  const albumCount = project._count?.reference_albums || 0;
  return `${projectTypeLabel(project.type)} · ${taskCount} 任务 · ${albumCount} 图集`;
}

export function projectHasContent(project: ProjectDisplayInput) {
  return (project._count?.tasks || 0) > 0 || (project._count?.reference_albums || 0) > 0;
}

export function projectRemovalAction(project: ProjectDisplayInput): ProjectRemovalAction {
  if (!project.can_manage_project || project.type === 'personal' || project.type === 'system') return null;
  return projectHasContent(project) ? 'archive' : 'delete';
}

export function projectRemovalReason(project: ProjectDisplayInput) {
  if (project.type === 'personal') return '个人默认项目不能删除或归档';
  if (project.type === 'system') return '系统项目不能删除或归档';
  if (!project.can_manage_project) return '你没有权限管理这个项目';
  return projectHasContent(project) ? '项目已有历史内容，只能归档' : '空项目可以删除';
}
