// api/summary.js — 돌아보기 집계
//   GET /api/summary?planId=
//
// 응답 형식(contracts/pds-schema-v2.json 의 aggregationRules 와 1:1 대응):
//   {
//     planId, today,
//     counts: {
//       plan:      { value, taskIds },  // 딸린, 지우지 않은 할 일 수 (T06-C28)
//       completed: { value, taskIds },  // 그중 완료 상태 (T06-C29)
//       delayed:   { value, taskIds },  // 미완료 + 마감일 < 오늘(서울) (T06-C30)
//       blocked:   { value, taskIds },  // 막힌 이유가 있는 실행기록을 가진 할 일 (T06-C31)
//     },
//     hours: { estimated, actual, diff }  // T06-C32, 대상이 없으면 전부 0
//   }
// 집계 숫자를 눌렀을 때 그 숫자가 나온 기록으로 갈 수 있도록(T06-C83)
// 각 counts 항목에 taskIds 를 함께 내려준다.

import { sql } from '@vercel/postgres';
import { preflight, ok, fail, methodNotAllowed, handle, seoulToday, ValidationError } from '../lib/db.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  return await handle(res, async () => {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    return await getSummary(req, res);
  });
}

async function getSummary(req, res) {
  const planId = req.query.planId;
  if (!planId) throw new ValidationError('planId 가 필요합니다.');

  const { rows: plan } = await sql`SELECT id FROM plans WHERE id = ${planId} AND deleted_at IS NULL`;
  if (plan.length === 0) {
    return fail(res, 404, 'PLAN_NOT_FOUND', '그 계획을 찾을 수 없습니다.');
  }

  const today = seoulToday();

  // 계획에 딸린, 지우지 않은 할 일 전체 + 막힘 여부 + 실제 시간 합계를 한 번에 가져온다.
  const { rows } = await sql`
    SELECT
      t.id,
      t.is_completed,
      t.due_date,
      t.estimated_hours,
      COALESCE(l.actual_sum, 0) AS actual_sum,
      COALESCE(l.blocked, false) AS has_blocker
    FROM tasks t
    LEFT JOIN (
      SELECT task_id,
             SUM(actual_hours) AS actual_sum,
             bool_or(blocker_reason IS NOT NULL AND btrim(blocker_reason) <> '') AS blocked
      FROM task_logs
      GROUP BY task_id
    ) l ON l.task_id = t.id
    WHERE t.plan_id = ${planId} AND t.deleted_at IS NULL
  `;

  const planIds = [];
  const completedIds = [];
  const delayedIds = [];
  const blockedIds = [];
  let estimatedSum = 0;
  let actualSum = 0;

  for (const r of rows) {
    planIds.push(r.id);

    const dueDate = toDateString(r.due_date);
    const isCompleted = r.is_completed === true;
    const isDelayed = !isCompleted && dueDate != null && dueDate < today;
    const hasBlocker = r.has_blocker === true;

    if (isCompleted) completedIds.push(r.id);
    if (isDelayed) delayedIds.push(r.id);
    if (hasBlocker) blockedIds.push(r.id);

    estimatedSum += Number(r.estimated_hours) || 0;
    actualSum += Number(r.actual_sum) || 0;
  }

  const diff = round2(actualSum - estimatedSum);

  return ok(res, {
    planId,
    today,
    counts: {
      plan:      { value: planIds.length,      taskIds: planIds },
      completed: { value: completedIds.length, taskIds: completedIds },
      delayed:   { value: delayedIds.length,    taskIds: delayedIds },
      blocked:   { value: blockedIds.length,    taskIds: blockedIds },
    },
    hours: {
      estimated: round2(estimatedSum),
      actual: round2(actualSum),
      diff,
    },
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toDateString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}
