-- ============================================================
-- 플랜두씨(Plan-Do-See) 다이어리 — 데이터베이스 스키마 v2
-- 대상: Vercel Postgres (Neon)
-- 시간대 규칙: 저장은 UTC(TIMESTAMPTZ), 표시/판정은 Asia/Seoul
-- 실행 방법: Vercel 대시보드 > Storage > Postgres > Query 탭에 붙여넣고 실행
-- ============================================================

-- ------------------------------------------------------------
-- 1. plans : 계획 (현재 유효한 값)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id               TEXT PRIMARY KEY,
  title            TEXT        NOT NULL,
  content          TEXT,                    -- 계획 내용(자유 설명). 성공 기준과는 별개, 선택 입력
  start_date       DATE        NOT NULL,
  end_date         DATE        NOT NULL,
  priority         TEXT        NOT NULL DEFAULT 'MEDIUM',
  success_criteria TEXT        NOT NULL,
  estimated_hours  NUMERIC(6,2) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT plans_priority_check CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
  CONSTRAINT plans_date_order_check CHECK (end_date >= start_date)
);

-- ------------------------------------------------------------
-- 2. plan_history : 계획 수정 이력 (수정 "전" 값의 스냅샷)
--    T06-C08 — 계획을 고쳐도 고치기 전 계획이 그대로 남는다
--    plans 를 UPDATE 하기 직전에 기존 행을 이 표로 복사한다.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_history (
  history_id       BIGSERIAL PRIMARY KEY,
  plan_id          TEXT        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  title            TEXT        NOT NULL,
  content          TEXT,
  start_date       DATE        NOT NULL,
  end_date         DATE        NOT NULL,
  priority         TEXT        NOT NULL,
  success_criteria TEXT        NOT NULL,
  estimated_hours  NUMERIC(6,2) NOT NULL,
  valid_from       TIMESTAMPTZ NOT NULL,  -- 이 버전이 만들어진 시각 (원본 updated_at)
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()  -- 이력으로 밀려난 시각
);

CREATE INDEX IF NOT EXISTS idx_plan_history_plan_id
  ON plan_history (plan_id, recorded_at DESC);

-- 이미 만들어진 테이블에 content 컬럼이 없을 수 있으므로 안전하게 추가한다.
-- (CREATE TABLE IF NOT EXISTS 는 이미 존재하는 테이블의 컬럼을 바꾸지 않는다)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE plan_history ADD COLUMN IF NOT EXISTS content TEXT;

-- ------------------------------------------------------------
-- 3. tasks : 할 일 (계획에 딸림)
--    T06-C09~C20
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  content         TEXT        NOT NULL,
  due_date        DATE,
  priority        TEXT        NOT NULL DEFAULT 'MEDIUM',
  tags            TEXT[]      NOT NULL DEFAULT '{}',
  estimated_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
  is_completed    BOOLEAN     NOT NULL DEFAULT false,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT tasks_priority_check CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
  -- 완료 상태와 완료 시각의 정합성: 완료면 시각이 있어야 하고, 미완료면 없어야 한다
  CONSTRAINT tasks_completed_at_check CHECK (
    (is_completed = true  AND completed_at IS NOT NULL) OR
    (is_completed = false AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tasks_plan_id   ON tasks (plan_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due_date  ON tasks (due_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_tags      ON tasks USING GIN (tags);

-- ------------------------------------------------------------
-- 4. task_logs : 실행 기록 (실제로 한 일, 할 일에 딸림)
--    T06-C23~C27 — 시작/끝 시각, 실제 소요, 막힌 이유
--    T06-C21/C22 — idempotency_key UNIQUE 로 중복 완료를 DB가 막는다
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_logs (
  id              TEXT PRIMARY KEY,
  task_id         TEXT        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL,
  actual_hours    NUMERIC(6,2) NOT NULL DEFAULT 0,
  blocker_reason  TEXT,                       -- 막혔던 이유 (없으면 NULL)
  idempotency_key TEXT        NOT NULL UNIQUE, -- 같은 요청 재전송 시 중복 삽입 차단
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_logs_time_order_check CHECK (ended_at >= started_at),
  CONSTRAINT task_logs_actual_hours_check CHECK (actual_hours >= 0)
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs (task_id, created_at DESC);

-- ------------------------------------------------------------
-- 5. retrospectives : 돌아보기 (기간별 회고 + 다음 계획으로 넘길 한 줄)
--    T06-C33 — 고칠 점 한 건이 다음 계획으로 넘어간다
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retrospectives (
  id               TEXT PRIMARY KEY,
  plan_id          TEXT        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  period_start     DATE        NOT NULL,
  period_end       DATE        NOT NULL,
  status           TEXT,
  reflection       TEXT,
  next_action_item TEXT,
  -- 이 회고의 고칠 점을 이어받아 만들어진 계획 (없으면 NULL)
  carried_to_plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT retro_status_check CHECK (status IS NULL OR status IN ('SUCCESS', 'PARTIAL', 'FAIL')),
  CONSTRAINT retro_period_order_check CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_retro_plan_id ON retrospectives (plan_id, created_at DESC);
