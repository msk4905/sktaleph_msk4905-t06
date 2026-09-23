// api/retrospectives.js — 돌아보기(See)
//   GET  /api/retrospectives?planId=   그 계획의 돌아보기 목록
//   POST /api/retrospectives           돌아보기 저장

import { sql } from '@vercel/postgres';
import {
  preflight, ok, fail, methodNotAllowed, handle,
  newId, isDateString, requireText, readBody, ValidationError,
} from '../lib/db.js';

const STATUSES = ['SUCCESS', 'PARTIAL', 'FAIL'];

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  return await handle(res, async () => {
    switch (req.method) {
      case 'GET':  return await getRetros(req, res);
      case 'POST': return await createRetro(req, res);
      default:     return methodNotAllowed(res, ['GET', 'POST']);
    }
  });
}

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------
async function getRetros(req, res) {
  const planId = req.query.planId;
  if (!planId) throw new ValidationError('planId 가 필요합니다.');

  const { rows } = await sql`
    SELECT * FROM retrospectives
    WHERE plan_id = ${planId}
    ORDER BY created_at DESC
  `;
  return ok(res, { planId, retrospectives: rows.map(mapRetroRow) });
}

// ------------------------------------------------------------
// POST — 생성
// ------------------------------------------------------------
async function createRetro(req, res) {
  const body = readBody(req);

  const planId = requireText(body.planId, '계획 id', 100);
  const { rows: plan } = await sql`
    SELECT id FROM plans WHERE id = ${planId} AND deleted_at IS NULL
  `;
  if (plan.length === 0) {
    return fail(res, 404, 'PLAN_NOT_FOUND', '그 계획을 찾을 수 없습니다.');
  }

  if (!isDateString(body.periodStart)) throw new ValidationError('돌아보는 기간의 시작일이 올바르지 않습니다.');
  if (!isDateString(body.periodEnd))   throw new ValidationError('돌아보는 기간의 끝일이 올바르지 않습니다.');
  if (body.periodEnd < body.periodStart) throw new ValidationError('기간의 끝은 시작과 같거나 그 뒤여야 합니다.');

  const status = body.status;
  if (status != null && !STATUSES.includes(status)) {
    throw new ValidationError('달성 평가는 SUCCESS, PARTIAL, FAIL 중 하나여야 합니다.');
  }

  // 다음 계획으로 넘길 고칠 점은 필수. (T06-C33 — 이 값이 있어야 다음 계획으로 넘길 수 있다)
  const nextActionItem = requireText(body.nextActionItem, '다음 계획으로 넘길 고칠 점', 500);

  const reflectionRaw = body.reflection;
  const reflection =
    typeof reflectionRaw === 'string' && reflectionRaw.trim() !== ''
      ? reflectionRaw.trim().slice(0, 2000)
      : null;

  const id = newId('retro');
  await sql`
    INSERT INTO retrospectives (id, plan_id, period_start, period_end, status, reflection, next_action_item)
    VALUES (${id}, ${planId}, ${body.periodStart}, ${body.periodEnd}, ${status ?? null}, ${reflection}, ${nextActionItem})
  `;

  const { rows } = await sql`SELECT * FROM retrospectives WHERE id = ${id}`;
  return ok(res, { retrospective: mapRetroRow(rows[0]) }, 201);
}

// ------------------------------------------------------------
// 매핑
// ------------------------------------------------------------
function mapRetroRow(r) {
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

function toDateString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}
