import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getVideoTaskStatus, mapProviderStatus } from '@/lib/provider/jimeng';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;

    const task = await prisma.videoTask.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      return NextResponse.json(
        { error: 'Task not found', message: `Task ${taskId} not found` },
        { status: 404 }
      );
    }

    // 如果有 provider_task_id，查询 provider 状态
    if (task.provider_task_id) {
      try {
        const statusResult = await getVideoTaskStatus(task.provider_task_id);

        // 构建更新数据
        const updateData: Record<string, unknown> = {
          provider_status: statusResult.provider_status,
          local_status: statusResult.local_status,
          raw_status_response: JSON.stringify(statusResult.raw),
        };

        // 如果成功，保存视频地址
        if (statusResult.result_video_url) {
          updateData.result_video_url = statusResult.result_video_url;
        }
        if (statusResult.result_last_frame_url) {
          updateData.result_last_frame_url = statusResult.result_last_frame_url;
        }

        // 扩展字段
        if (statusResult.provider_model) {
          updateData.model = statusResult.provider_model;
        }
        if (statusResult.seed !== undefined) {
          updateData.seed = statusResult.seed;
        }
        if (statusResult.resolution) {
          updateData.resolution = statusResult.resolution;
        }
        if (statusResult.ratio) {
          updateData.ratio = statusResult.ratio;
        }
        if (statusResult.duration !== undefined) {
          updateData.duration = statusResult.duration;
        }

        // 保存错误信息
        if (statusResult.error_message) {
          updateData.error_message = statusResult.error_message;
        }

        // 终态时设置 completed_at
        const isTerminal = ['succeeded', 'failed', 'cancelled'].includes(statusResult.local_status);
        if (isTerminal && !task.completed_at) {
          updateData.completed_at = new Date();
        }

        const updatedTask = await prisma.videoTask.update({
          where: { id: taskId },
          data: updateData,
        });

        return NextResponse.json(updatedTask);
      } catch (apiError) {
        console.error('Provider status query error:', apiError);

        // API 错误时返回当前状态
        return NextResponse.json({
          ...task,
          error_message: task.error_message || (apiError instanceof Error ? apiError.message : 'Failed to query status'),
        });
      }
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Get task status error:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
