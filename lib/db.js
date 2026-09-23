// lib/db.js
// 모든 API 라우트가 공유하는 DB 연결 + 공통 헬퍼.
// @vercel/postgres 의 sql 태그드 템플릿은 값을 자동으로 파라미터 바인딩하므로
// SQL 인젝션이 구조적으로 차단된다. (문자열을 직접 이어붙이지 말 것)

import { sql } from '@vercel/postgres';

export { sql };

// ------------------------------------------------------------
// CORS / 프리플라이트
// ------------------------------------------------------------
export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
}

/**
 * 모든 핸들러 공통 전처리.
 * OPTIONS 프리플라이트면 즉시 응답하고 true 를 돌려준다(= 핸들러는 여기서 종료).
 */
export function preflight(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

// ------------------------------------------------------------
// 응답 헬퍼
// ------------------------------------------------------------
export function ok(res, data, status = 200) {
  return res.status(status).json(data);
}

/**
 * 실패 응답은 항상 같은 모양으로 내려준다.
 * 화면에서 "안 될 때 무엇이 보이나요"를 일관되게 표시하기 위함.
 */
export function fail(res, status, code, message, detail) {
  return res.status(status).json({
    error: { code, message, detail: detail ?? null },
  });
}

export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  return fail(res, 405, 'METHOD_NOT_ALLOWED', `허용되지 않은 요청 방식입니다. (${allowed.join(', ')})`);
}

/**
 * 핸들러 전체를 감싸 예기치 못한 예외가 500 JSON 으로 나가게 한다.
 * DB 접속 정보 같은 내부 정보가 응답에 새지 않도록 메시지를 고정한다.
 */
export async function guard(res, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error('[api error]', err);
    return fail(
      res,
      500,
      'INTERNAL_ERROR',
      '서버에서 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    );
  }
}

// ------------------------------------------------------------
// ID 생성
// ------------------------------------------------------------
export function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

// ------------------------------------------------------------
// 시간대 규칙
//   저장: TIMESTAMPTZ (UTC 기준으로 보관)
//   판정/표시: Asia/Seoul
//   "지연" 판정의 기준이 되는 '오늘'은 항상 서울 시간 기준으로 계산한다. (T06-C30)
// ------------------------------------------------------------
export const TIMEZONE = 'Asia/Seoul';

/** 서울 시간 기준 오늘 날짜를 'YYYY-MM-DD' 로 돌려준다. */
export function seoulToday() {
  // en-CA 로케일은 YYYY-MM-DD 형식을 준다.
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

// ------------------------------------------------------------
// 입력 검증 헬퍼
// ------------------------------------------------------------
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];

export function isPriority(v) {
  return PRIORITIES.includes(v);
}

/** 'YYYY-MM-DD' 형태이고 실제 존재하는 날짜인지 확인. */
export function isDateString(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** ISO 8601 타임스탬프 문자열인지 확인. */
export function isTimestampString(v) {
  if (typeof v !== 'string' || v.length < 10) return false;
  return !Number.isNaN(new Date(v).getTime());
}

/** 비어 있지 않은 문자열인지 확인하고 양끝 공백을 제거해 돌려준다. */
export function requireText(v, fieldName, maxLen = 2000) {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ValidationError(`${fieldName}을(를) 입력해 주세요.`);
  }
  const trimmed = v.trim();
  if (trimmed.length > maxLen) {
    throw new ValidationError(`${fieldName}이(가) 너무 깁니다. (최대 ${maxLen}자)`);
  }
  return trimmed;
}

/** 0 이상의 수치인지 확인. */
export function requireNonNegativeNumber(v, fieldName) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(`${fieldName}은(는) 0 이상의 숫자여야 합니다.`);
  }
  return n;
}

/** 쉼표로 구분된 문자열 또는 배열을 정규화된 태그 배열로 바꾼다. */
export function normalizeTags(v) {
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(',');
  else if (v == null) arr = [];
  else throw new ValidationError('태그 형식이 올바르지 않습니다.');

  const cleaned = arr
    .map((t) => String(t).trim())
    .filter((t) => t !== '')
    .map((t) => t.slice(0, 40));

  // 중복 제거, 최대 20개
  return [...new Set(cleaned)].slice(0, 20);
}

/** 검증 실패를 400 으로 내보내기 위한 전용 예외. */
export class ValidationError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ValidationError';
    this.detail = detail ?? null;
  }
}

/**
 * guard 안에서 ValidationError 를 400 으로 변환해 주는 래퍼.
 * 사용: return await handle(res, async () => { ... })
 */
export async function handle(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(res, 400, 'VALIDATION_ERROR', err.message, err.detail);
    }
    console.error('[api error]', err);
    return fail(
      res,
      500,
      'INTERNAL_ERROR',
      '서버에서 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    );
  }
}

// ------------------------------------------------------------
// 요청 바디 파싱
//   Vercel 은 Content-Type: application/json 이면 req.body 를 객체로 준다.
//   문자열로 오는 경우(다른 런타임/직접 호출)를 대비해 방어적으로 처리.
// ------------------------------------------------------------
export function readBody(req) {
  const b = req.body;
  if (b == null) return {};
  if (typeof b === 'object') return b;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      throw new ValidationError('요청 본문이 올바른 JSON 이 아닙니다.');
    }
  }
  return {};
}
