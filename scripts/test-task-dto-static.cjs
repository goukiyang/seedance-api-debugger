const assert = require('node:assert/strict');
const { inspectTaskDto } = require('./check-task-dto.cjs');
const file = 'src/app/api/synthetic/route.ts';
for (const source of [
  'const task = await prisma.videoTask.findUnique({where:{id}, include:{owner:true}}); return Response.json(task);',
  'return NextResponse.json({...task});',
  'const row = await db.videoTask.findFirst({select:{id:true}}); return Response.json({task:row});',
  'return Response.json({raw_create_response: task.raw_create_response});',
]) assert.ok(inspectTaskDto(file, source).length, source);
for (const source of [
  'const task = await prisma.videoTask.findUnique({select:videoTaskViewSelect}); return Response.json(toVideoTaskView(task,user));',
  'const tasks = await prisma.videoTask.findMany({select:videoTaskViewSelect}); return Response.json({tasks:tasks.map(task=>toVideoTaskView(task,user))});',
  'const payload={...task,provider_task_id:id}; await submitToProvider(payload); return Response.json({id});',
  'const task=await db.videoTask.findUnique({select:{id:true}}); return Response.json({task:task ? {id:task.id} : null});',
  'const updated=await tx.project.findUnique({where:{id}}); return Response.json({project:{...updated}});',
]) assert.deepEqual(inspectTaskDto(file, source), [], source);
console.log('PASS task DTO static guard rejects raw rows/spreads/fields and permits projected or internal execution data');
