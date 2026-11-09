import 'server-only';
import type { SessionUser } from '@/lib/auth/session';
import type { SystemAlert } from './display';

// A live projection, not a persisted notification or a write in the HD worker.
export async function readHdSystemAlerts(role: SessionUser['role']): Promise<SystemAlert[]> {
  if (role !== 'admin') return [];
  const href = '/admin/image-studio#hd-management-title';
  try {
    const { hdControl } = await import('@/lib/media/hd-derivatives');
    const control = await hdControl();
    return control.state === 'hard_pause' && control.reason !== 'load_guard'
      ? [{ id: 'hd_hard_pause', title: '高清图准备已暂停',
        body: '后台遇到异常，需要维护人员核对恢复。原图仍可查看和下载。', href }]
      : [];
  } catch {
    return [{ id: 'hd_control_unavailable', title: '高清图准备状态待确认',
      body: '暂时无法读取后台状态，请核对；当前不能确认高清准备正常。', href }];
  }
}
