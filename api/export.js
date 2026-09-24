// api/export.js — 내 자료 전체를 파일 하나로 내보내기 (T06-C36)
//   GET /api/export
//
// 화면의 "데이터 백업" 버튼이 이 응답을 그대로 .json 파일로 저장한다.
// soft delete 된 행도 포함해 전체 상태를 그대로 내보낸다 (진짜 백업이 되도록).

import { sql } from '@vercel/postgres';
import { preflight, ok, methodNotAllowed, handle } from '../lib/db.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  return await handle(res, async () => {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    return await exportAll(res);
  });
}

async function exportAll(res) {
  const [plans, planHistory, tasks, taskLogs, retrospectives] = await Promise.all([
    sql`SELECT * FROM plans ORDER BY created_at ASC`,
    sql`SELECT * FROM plan_history ORDER BY plan_id ASC, recorded_at ASC`,
    sql`SELECT * FROM tasks ORDER BY created_at ASC`,
    sql`SELECT * FROM task_logs ORDER BY created_at ASC`,
    sql`SELECT * FROM retrospectives ORDER BY created_at ASC`,
  ]);

  return ok(res, {
    exportedAt: new Date().toISOString(),
    schemaVersion: '2.0.0',
    plans: plans.rows.map(mapPlan),
    planHistory: planHistory.rows.map(mapPlanHistory),
    tasks: tasks.rows.map(mapTask),
    taskLogs: taskLogs.rows.map(mapTaskLog),
    retrospectives: retrospectives.rows.map(mapRetro),
  });
}

function toDateString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}

function mapPlan(r) {
  return {
    id: r.id,
    title: r.title,
    content: r.content ?? null,
    startDate: toDateString(r.start_date),
    endDate: toDateString(r.end_date),
    priority: r.priority,
    successCriteria: r.success_criteria,
    estimatedHours: Number(r.estimated_hours),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function mapPlanHistory(r) {
  return {
    historyId: Number(r.history_id),
    planId: r.plan_id,
    title: r.title,
    content: r.content ?? null,
    startDate: toDateString(r.start_date),
    endDate: toDateString(r.end_date),
    priority: r.priority,
    successCriteria: r.success_criteria,
    estimatedHours: Number(r.estimated_hours),
    validFrom: r.valid_from,
    recordedAt: r.recorded_at,
  };
}

function mapTask(r) {
  return {
    id: r.id,
    planId: r.plan_id,
    content: r.content,
    dueDate: toDateString(r.due_date),
    priority: r.priority,
    tags: r.tags ?? [],
    estimatedHours: Number(r.estimated_hours),
    isCompleted: r.is_completed,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

function mapTaskLog(r) {
  return {
    id: r.id,
    taskId: r.task_id,
    content: r.content ?? null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    actualHours: Number(r.actual_hours),
    blockerReason: r.blocker_reason,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}

function mapRetro(r) {
  return {
    id: r.id,
    planId: r.plan_id,
    periodStart: toDateString(r.period_start),
    periodEnd: toDateString(r.period_end),
    status: r.status,
    reflection: r.reflection,
    nextActionItem: r.next_action_item,
    carriedToPlanId: r.carried_to_plan_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
