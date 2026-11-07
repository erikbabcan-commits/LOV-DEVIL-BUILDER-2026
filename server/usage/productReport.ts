import type { DbLike } from '../db/pool';

export function productReportWindow(week: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || week < '2000-01-01' || week >= '9999-01-01')
    throw new Error('invalid_report_week');
  const start = new Date(week + 'T00:00:00Z');
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== week || start.getUTCDay() !== 1)
    throw new Error('invalid_report_week');
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

function count(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)))
    throw new Error('invalid_report_count');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid_report_count');
  return result;
}

/** One statement gives all aggregates the same database snapshot. */
export async function weeklyProductReport(db: DbLike, week: string, now = new Date()) {
  const { start, end } = productReportWindow(week);
  // Capability check keeps the operator report usable against older API schemas.
  const schema = await db.query(`SELECT EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'users'::regclass
      AND attname = 'first_observed_app_save_at' AND NOT attisdropped
  ) AS present`);
  const tracksFirstSave = schema.rows[0]?.present === true;
  const firstSaveColumn = tracksFirstSave ? 'first_observed_app_save_at' : 'NULL::timestamptz';
  const result = await db.query(`
    WITH publications AS (
      SELECT owner_id, project_id, updated_at
      FROM publish_jobs
      WHERE state = 'published' AND updated_at >= $1 AND updated_at < $2
    ),
    cohort AS (
      SELECT id, created_at, ${firstSaveColumn} AS first_save_at
      FROM users WHERE created_at >= $1 AND created_at < $2
    ),
    cohort_publications AS (
      SELECT p.owner_id, MIN(p.updated_at) AS first_publication
      FROM publications p JOIN cohort c ON c.id = p.owner_id AND p.updated_at >= c.created_at
      GROUP BY p.owner_id
    ),
    billing AS (
      SELECT COALESCE((SELECT mode FROM billing_environment WHERE id = 'stripe'), 'unconfigured') AS mode
    )
    SELECT
      (SELECT COUNT(*) FROM publications) AS successful_publications,
      (SELECT COUNT(DISTINCT (owner_id, project_id)) FROM publications) AS published_apps,
      (SELECT COUNT(*) FROM cohort) AS signups,
      (SELECT COUNT(*) FROM cohort c WHERE EXISTS (
        SELECT 1 FROM cohort_publications p WHERE p.owner_id = c.id
      ) OR EXISTS (
        SELECT 1 FROM builder_projects p WHERE p.owner_id = c.id AND p.deleted_at IS NULL
          AND CASE WHEN jsonb_typeof(p.workspace->'snapshots') = 'array'
            THEN jsonb_array_length(p.workspace->'snapshots') > 0 ELSE FALSE END
      )) AS saved_or_published_apps,
      (SELECT COUNT(*) FROM cohort WHERE first_save_at >= created_at AND first_save_at < $2) AS observed_first_saves,
      (SELECT COUNT(*) FROM cohort_publications) AS cohort_publishers,
      CASE WHEN billing.mode = 'live' THEN (
        SELECT COUNT(*) FROM cohort_publications p WHERE EXISTS (
          SELECT 1 FROM billing_events e
          WHERE e.user_id = p.owner_id AND e.event_type = 'invoice.paid'
            AND e.processed_at >= p.first_publication AND e.processed_at < $2
        )
      ) END AS cohort_live_invoice_events,
      billing.mode AS billing_mode
    FROM billing`, [start, end]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !['live', 'test', 'unconfigured'].includes(row?.billing_mode))
    throw new Error('invalid_report_result');
  return {
    schemaVersion: 2,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    generatedAt: now.toISOString(),
    completeWeek: now >= end,
    publishedApps: count(row.published_apps),
    successfulPublications: count(row.successful_publications),
    signupCohort: {
      backendAccounts: count(row.signups),
      withCurrentSavedOrWeeklyPublishedApp: count(row.saved_or_published_apps),
      withObservedFirstAppSaveInWeek: tracksFirstSave ? count(row.observed_first_saves) : null,
      withPublicationInWeek: count(row.cohort_publishers),
      withLiveInvoicePaidEventAfterPublicationInWeek: row.billing_mode === 'live'
        ? count(row.cohort_live_invoice_events) : null,
    },
    firstAppSaveEvidence: tracksFirstSave ? 'server-observed' : 'unavailable',
    billingEvidence: row.billing_mode as 'live' | 'test' | 'unconfigured',
  };
}
