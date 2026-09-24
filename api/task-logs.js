// api/task-logs.js — 실행 기록(Do)
//   GET  /api/task-logs?taskId=      그 할 일의 실행 기록 목록
//   POST /api/task-logs              실행 기록 생성 (idempotencyKey 필수)
//
// 중복 방지(T06-C21, T06-C22): idempotency_key 에 UNIQUE 제약이 걸려 있어
// 같은 키로 두 번 INSERT 하면 두 번째는 DB가 거부한다. 프론트에서 버튼을 잠그는
// 방식에 의존하지 않는다. 여기서는 그 UNIQUE 위반을 잡아 "중복" 응답으로 바꿔 준다.

import { sql } from '@vercel/postgres';
import {
  preflight, ok, fail, methodNotAllowed, handle,
  newId, isTimestampString, requireNonNegativeNumber, readBody, ValidationError,
} from '../lib/db.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  return await handle(res, async () => {
    switch (req.method) {
      case 'GET':  return await getLogs(req, res);
      case 'POST': return await createLog(req, res);
      default:     return methodNotAllowed(res, ['GET', 'POST']);
    }
  });
}

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------
async function getLogs(req, res) {
  const taskId = req.query.taskId;
  if (!taskId) throw new ValidationError('taskId 가 필요합니다.');

  const { rows } = await sql`
    SELECT * FROM task_logs
    WHERE task_id = ${taskId}
    ORDER BY started_at DESC, created_at DESC
  `;
  return ok(res, { taskId, logs: rows.map(mapLogRow) });
}

// ------------------------------------------------------------
// POST — 생성
// ------------------------------------------------------------
async function createLog(req, res) {
  const body = readBody(req);
  const f = validateLogFields(body);

  const { rows: task } = await sql`
    SELECT id FROM tasks WHERE id = ${f.taskId} AND deleted_at IS NULL
  `;
  if (task.length === 0) {
    return fail(res, 404, 'TASK_NOT_FOUND', '그 할 일을 찾을 수 없습니다.');
  }

  // 같은 키가 이미 있으면 새로 쓰지 않고 기존 기록을 그대로 돌려준다.
  // (버튼을 연달아 두 번 눌러도 기록은 한 건만 남는다 — T06-C21)
  const { rows: existing } = await sql`
    SELECT * FROM task_logs WHERE idempotency_key = ${f.idempotencyKey}
  `;
  if (existing.length > 0) {
    return ok(res, { log: mapLogRow(existing[0]), duplicate: true });
  }

  const id = newId('log');
  try {
    await sql`
      INSERT INTO task_logs (id, task_id, content, started_at, ended_at, actual_hours, blocker_reason, idempotency_key)
      VALUES (${id}, ${f.taskId}, ${f.content}, ${f.startedAt}, ${f.endedAt}, ${f.actualHours}, ${f.blockerReason}, ${f.idempotencyKey})
    `;
  } catch (err) {
    // 동시에 두 요청이 들어와 여기서 경합했을 때도 UNIQUE 제약이 최종 방어선이 된다.
    if (isUniqueViolation(err)) {
      const { rows: again } = await sql`
        SELECT * FROM task_logs WHERE idempotency_key = ${f.idempotencyKey}
      `;
      if (again.length > 0) return ok(res, { log: mapLogRow(again[0]), duplicate: true });
    }
    throw err;
  }

  const { rows } = await sql`SELECT * FROM task_logs WHERE id = ${id}`;
  return ok(res, { log: mapLogRow(rows[0]), duplicate: false }, 201);
}

function isUniqueViolation(err) {
  // Postgres 의 unique_violation 코드
  return err && err.code === '23505';
}

// ------------------------------------------------------------
// 검증 / 매핑
// ------------------------------------------------------------
function validateLogFields(body) {
  if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
    throw new ValidationError('taskId 가 필요합니다.');
  }

  // 실제로 한 일 내용 — 자유 설명, 선택 입력.
  const contentRaw = body.content;
  const content =
    typeof contentRaw === 'string' && contentRaw.trim() !== ''
      ? contentRaw.trim().slice(0, 2000)
      : null;

  if (!isTimestampString(body.startedAt)) {
    throw new ValidationError('시작 시각(startedAt)이 올바르지 않습니다.');
  }
  if (!isTimestampString(body.endedAt)) {
    throw new ValidationError('끝난 시각(endedAt)이 올바르지 않습니다.');
  }
  if (new Date(body.endedAt) < new Date(body.startedAt)) {
    throw new ValidationError('끝난 시각은 시작 시각보다 앞설 수 없습니다.');
  }
  const actualHours = requireNonNegativeNumber(body.actualHours ?? 0, '실제로 걸린 시간');

  const blockerReasonRaw = body.blockerReason;
  const blockerReason =
    typeof blockerReasonRaw === 'string' && blockerReasonRaw.trim() !== ''
      ? blockerReasonRaw.trim().slice(0, 1000)
      : null;

  let idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    // 클라이언트가 키를 빼먹은 경우를 대비한 안전망. 정상 흐름에서는 프론트가 항상 채워 보낸다.
    idempotencyKey = newId('auto-key');
  }

  return {
    taskId: body.taskId.trim(),
    content,
    startedAt: new Date(body.startedAt).toISOString(),
    endedAt: new Date(body.endedAt).toISOString(),
    actualHours,
    blockerReason,
    idempotencyKey: idempotencyKey.trim().slice(0, 200),
  };
}

function mapLogRow(r) {
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
