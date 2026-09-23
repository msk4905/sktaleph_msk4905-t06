// api/tasks.js — 할 일(Task)
//   GET    /api/tasks?planId=&q=&status=&priority=&tag=&sort=   목록 (검색·거르기·정렬)
//   GET    /api/tasks?ids=a,b,c                                 집계에서 넘어온 id 목록 조회 (드릴다운)
//   POST   /api/tasks                                           생성
//   PATCH  /api/tasks?id=                                       수정 / 완료 / 되돌리기
//   DELETE /api/tasks?id=                                       삭제 (soft delete)
//
// 정렬(T06-C20): 화면에 밝혀 둔 기준대로 정렬한다. 값이 같을 때의 순서까지 고정하려고
// 모든 정렬에 created_at DESC, id ASC 를 마지막 결정자로 덧붙인다.
// 그래서 같은 조건으로 다시 불러도 순서가 달라지지 않는다.
//
// 동적 SQL 주의: @vercel/postgres 의 sql 태그드 템플릿은 sql 조각을 중첩할 수 없다.
// 정렬·조인처럼 구조가 바뀌는 부분은 sql.query(text, params) 로 조립하고,
// 사용자 입력은 전부 $n 파라미터로만 넣는다. ORDER BY 에 들어가는 문자열은
// 아래 SORT_OPTIONS 허용 목록에서만 나오므로 외부 입력이 SQL 에 직접 닿지 않는다.

import { sql } from '@vercel/postgres';
import {
  preflight, ok, fail, methodNotAllowed, handle,
  newId, isDateString, isPriority, requireText, requireNonNegativeNumber,
  normalizeTags, readBody, seoulToday, ValidationError,
} from '../lib/db.js';

// 화면에 그대로 표시하는 정렬 기준 정의. 키는 프론트가 보내는 sort 값과 같다.
export const SORT_OPTIONS = {
  created_desc:   { label: '만든 날짜 최신순',           expr: 't.created_at DESC' },
  created_asc:    { label: '만든 날짜 오래된순',         expr: 't.created_at ASC' },
  due_asc:        { label: '마감일 빠른순 (없음은 뒤)',   expr: 't.due_date ASC NULLS LAST' },
  due_desc:       { label: '마감일 늦은순 (없음은 뒤)',   expr: 't.due_date DESC NULLS LAST' },
  priority_desc:  { label: '우선순위 높은순',             expr: "CASE t.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END ASC" },
  priority_asc:   { label: '우선순위 낮은순',             expr: "CASE t.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END DESC" },
  estimated_desc: { label: '예상 시간 많은순',            expr: 't.estimated_hours DESC' },
  estimated_asc:  { label: '예상 시간 적은순',            expr: 't.estimated_hours ASC' },
};

const DEFAULT_SORT = 'created_desc';

// 할 일별 실행 기록 요약(건수·실제 시간 합계·막힘 여부). 사용자 입력이 없는 고정 SQL.
const LOG_SUMMARY = `(
  SELECT task_id,
         COUNT(*)          AS log_count,
         SUM(actual_hours) AS actual_sum,
         bool_or(blocker_reason IS NOT NULL AND btrim(blocker_reason) <> '') AS blocked
  FROM task_logs
  GROUP BY task_id
)`;

const TASK_SELECT = `
  SELECT t.*,
         COALESCE(l.log_count, 0)   AS log_count,
         COALESCE(l.actual_sum, 0)  AS actual_sum,
         COALESCE(l.blocked, false) AS has_blocker
  FROM tasks t
  LEFT JOIN ${LOG_SUMMARY} l ON l.task_id = t.id
`;

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  return await handle(res, async () => {
    switch (req.method) {
      case 'GET':    return await getTasks(req, res);
      case 'POST':   return await createTask(req, res);
      case 'PATCH':  return await updateTask(req, res);
      case 'DELETE': return await deleteTask(req, res);
      default:       return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
    }
  });
}

// ------------------------------------------------------------
// GET — 검색 · 거르기 · 정렬 (모두 서버에서 처리한다)
// ------------------------------------------------------------
async function getTasks(req, res) {
  const { id, planId, q, status, priority, tag, ids } = req.query;
  const sortKey = SORT_OPTIONS[req.query.sort] ? req.query.sort : DEFAULT_SORT;
  const sortExpr = SORT_OPTIONS[sortKey].expr;
  const today = seoulToday();

  // 단건 조회
  if (id) {
    const { rows } = await sql.query(
      `${TASK_SELECT} WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [id]
    );
    if (rows.length === 0) {
      return fail(res, 404, 'TASK_NOT_FOUND', '그 할 일을 찾을 수 없습니다.');
    }
    return ok(res, { task: mapTaskRow(rows[0], today) });
  }

  // 집계 숫자에서 넘어온 id 목록으로 조회 (T06-C83 드릴다운)
  if (ids) {
    const idList = String(ids).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
    if (idList.length === 0) {
      return ok(res, { tasks: [], sort: sortKey, sortLabel: SORT_OPTIONS[sortKey].label, today });
    }
    const { rows } = await sql.query(
      `${TASK_SELECT}
       WHERE t.id = ANY($1) AND t.deleted_at IS NULL
       ORDER BY ${sortExpr}, t.created_at DESC, t.id ASC`,
      [idList]
    );
    return ok(res, {
      tasks: rows.map((r) => mapTaskRow(r, today)),
      sort: sortKey,
      sortLabel: SORT_OPTIONS[sortKey].label,
      today,
    });
  }

  // 목록 조회 — 조건을 배열로 모아 AND 로 잇는다. 값은 전부 $n 파라미터.
  const where = ['t.deleted_at IS NULL'];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  if (planId) where.push(`t.plan_id = ${p(planId)}`);

  const searchTerm = typeof q === 'string' && q.trim() !== '' ? q.trim() : null;
  if (searchTerm) {
    const ph = p(`%${searchTerm}%`);
    // 내용과 태그 양쪽에서 찾는다. (T06-C18)
    where.push(`(t.content ILIKE ${ph} OR EXISTS (SELECT 1 FROM unnest(t.tags) tg WHERE tg ILIKE ${ph}))`);
  }

  const priorityFilter = isPriority(priority) ? priority : null;
  if (priorityFilter) where.push(`t.priority = ${p(priorityFilter)}`);

  const tagFilter = typeof tag === 'string' && tag.trim() !== '' ? tag.trim() : null;
  if (tagFilter) where.push(`${p(tagFilter)} = ANY(t.tags)`);

  // 거르기 (T06-C19)
  const statusFilter = ['todo', 'done', 'delayed', 'blocked'].includes(status) ? status : null;
  if (statusFilter === 'todo')    where.push('t.is_completed = false');
  if (statusFilter === 'done')    where.push('t.is_completed = true');
  if (statusFilter === 'delayed') {
    where.push(`t.is_completed = false AND t.due_date IS NOT NULL AND t.due_date < ${p(today)}::date`);
  }
  if (statusFilter === 'blocked') where.push('COALESCE(l.blocked, false) = true');

  const { rows } = await sql.query(
    `${TASK_SELECT}
     WHERE ${where.join(' AND ')}
     ORDER BY ${sortExpr}, t.created_at DESC, t.id ASC`,
    params
  );

  return ok(res, {
    tasks: rows.map((r) => mapTaskRow(r, today)),
    sort: sortKey,
    sortLabel: SORT_OPTIONS[sortKey].label,
    sortOptions: Object.entries(SORT_OPTIONS).map(([k, v]) => ({ key: k, label: v.label })),
    today,
    appliedFilters: {
      planId: planId ?? null,
      q: searchTerm,
      status: statusFilter,
      priority: priorityFilter,
      tag: tagFilter,
    },
  });
}

// ------------------------------------------------------------
// POST — 생성 (T06-C09)
// ------------------------------------------------------------
async function createTask(req, res) {
  const body = readBody(req);
  const planId = requireText(body.planId, '계획 id', 100);

  const { rows: plan } = await sql`
    SELECT id FROM plans WHERE id = ${planId} AND deleted_at IS NULL
  `;
  if (plan.length === 0) {
    return fail(res, 404, 'PLAN_NOT_FOUND', '그 계획을 찾을 수 없습니다. 먼저 계획을 만들어 주세요.');
  }

  const f = validateTaskFields(body);
  const id = newId('task');

  await sql`
    INSERT INTO tasks (id, plan_id, content, due_date, priority, tags, estimated_hours)
    VALUES (${id}, ${planId}, ${f.content}, ${f.dueDate},
            ${f.priority}, ${f.tags}, ${f.estimatedHours})
  `;

  const { rows } = await sql`SELECT * FROM tasks WHERE id = ${id}`;
  return ok(res, { task: mapTaskRow(rows[0], seoulToday()) }, 201);
}

// ------------------------------------------------------------
// PATCH — 수정(T06-C10) / 완료(T06-C11) / 되돌리기(T06-C12)
// ------------------------------------------------------------
async function updateTask(req, res) {
  const id = req.query.id;
  if (!id) throw new ValidationError('수정할 할 일의 id 가 필요합니다.');

  const body = readBody(req);
  const action = body.action;

  const { rows: current } = await sql`
    SELECT * FROM tasks WHERE id = ${id} AND deleted_at IS NULL
  `;
  if (current.length === 0) {
    return fail(res, 404, 'TASK_NOT_FOUND', '그 할 일을 찾을 수 없습니다.');
  }

  if (action === 'complete') {
    // 이미 완료면 다시 쓰지 않는다 — 연달아 눌러도 완료 시각이 바뀌지 않는다.
    // 실행 기록의 중복 방지는 task-logs 의 idempotency_key(UNIQUE)가 담당한다.
    if (current[0].is_completed) {
      return ok(res, { task: mapTaskRow(current[0], seoulToday()), alreadyCompleted: true });
    }
    await sql`
      UPDATE tasks SET is_completed = true, completed_at = now(), updated_at = now()
      WHERE id = ${id} AND is_completed = false
    `;
  } else if (action === 'reopen') {
    await sql`
      UPDATE tasks SET is_completed = false, completed_at = NULL, updated_at = now()
      WHERE id = ${id}
    `;
  } else {
    const f = validateTaskFields(body);
    await sql`
      UPDATE tasks
      SET content = ${f.content},
          due_date = ${f.dueDate},
          priority = ${f.priority},
          tags = ${f.tags},
          estimated_hours = ${f.estimatedHours},
          updated_at = now()
      WHERE id = ${id}
    `;
  }

  const { rows } = await sql`SELECT * FROM tasks WHERE id = ${id}`;
  return ok(res, { task: mapTaskRow(rows[0], seoulToday()) });
}

// ------------------------------------------------------------
// DELETE — soft delete (T06-C13)
// ------------------------------------------------------------
async function deleteTask(req, res) {
  const id = req.query.id;
  if (!id) throw new ValidationError('삭제할 할 일의 id 가 필요합니다.');

  const { rowCount } = await sql`
    UPDATE tasks SET deleted_at = now(), updated_at = now()
    WHERE id = ${id} AND deleted_at IS NULL
  `;
  if (rowCount === 0) {
    return fail(res, 404, 'TASK_NOT_FOUND', '그 할 일을 찾을 수 없거나 이미 지워졌습니다.');
  }
  return ok(res, { deleted: true, id });
}

// ------------------------------------------------------------
// 검증 / 매핑
// ------------------------------------------------------------
function validateTaskFields(body) {
  const content = requireText(body.content, '할 일 내용', 500);

  let dueDate = body.dueDate;
  if (dueDate === '' || dueDate == null) dueDate = null;
  else if (!isDateString(dueDate)) throw new ValidationError('마감일을 YYYY-MM-DD 형식으로 입력해 주세요.');

  const priority = body.priority ?? 'MEDIUM';
  if (!isPriority(priority)) throw new ValidationError('우선순위는 HIGH, MEDIUM, LOW 중 하나여야 합니다.');

  const tags = normalizeTags(body.tags);
  const estimatedHours = requireNonNegativeNumber(body.estimatedHours ?? 0, '예상 시간');

  return { content, dueDate, priority, tags, estimatedHours };
}

function mapTaskRow(r, today) {
  const dueDate = toDateString(r.due_date);
  return {
    id: r.id,
    planId: r.plan_id,
    content: r.content,
    dueDate,
    priority: r.priority,
    tags: r.tags ?? [],
    estimatedHours: Number(r.estimated_hours),
    isCompleted: r.is_completed,
    completedAt: r.completed_at,
    // 지연 여부는 저장하지 않고 조회 시점의 서울 기준 오늘로 판정한다. (T06-C30)
    isDelayed: !r.is_completed && dueDate != null && dueDate < today,
    logCount: r.log_count != null ? Number(r.log_count) : 0,
    actualHours: r.actual_sum != null ? Number(r.actual_sum) : 0,
    hasBlocker: r.has_blocker === true,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** DATE 컬럼은 드라이버가 Date 객체로 줄 수 있다. 시간대 변환 없이 YYYY-MM-DD 로 되돌린다. */
function toDateString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}
