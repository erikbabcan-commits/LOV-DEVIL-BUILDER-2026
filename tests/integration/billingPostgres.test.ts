// @vitest-environment node
import { describe } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { dbFromPool } from "../../server/db/pool";
import { billingContract } from "../helpers/billingContract";
import { billingModeContract } from "../helpers/billingModeContract";

describe.skipIf(process.env.PROJECTS_PG_E2E !== "1")(
  "dedicated PostgreSQL billing",
  () => {
    billingContract(
      "billing HTTP → signed Stripe boundary → real PostgreSQL",
      async () => {
        const connectionString = process.env.PROJECTS_TEST_DATABASE_URL;
        if (
          !connectionString ||
          !["127.0.0.1", "localhost"].includes(
            new URL(connectionString).hostname,
          )
        )
          throw new Error("Dedicated loopback test database required");
        const schema = "lov_billing_" + randomUUID().replaceAll("-", "");
        const admin = new Pool({
          connectionString,
          max: 1,
          connectionTimeoutMillis: 5000,
        });
        await admin.query("CREATE SCHEMA " + schema);
        const pool = new Pool({
          connectionString,
          options: "-c search_path=" + schema,
          max: 5,
          statement_timeout: 10000,
          connectionTimeoutMillis: 5000,
        });
        return {
          db: dbFromPool(pool),
          close: async () => {
            await pool.end();
            try {
              await admin.query("DROP SCHEMA " + schema + " CASCADE");
            } finally {
              await admin.end();
            }
          },
        };
      },
      true,
    );
    billingModeContract(
      "explicit test/live mode through native PostgreSQL",
      async () => {
        const connectionString = process.env.PROJECTS_TEST_DATABASE_URL;
        if (
          !connectionString ||
          !["127.0.0.1", "localhost"].includes(
            new URL(connectionString).hostname,
          )
        )
          throw new Error("Dedicated loopback test database required");
        const schema = "lov_billing_mode_" + randomUUID().replaceAll("-", ""),
          admin = new Pool({
            connectionString,
            max: 1,
            connectionTimeoutMillis: 5000,
          });
        await admin.query("CREATE SCHEMA " + schema);
        const pool = new Pool({
          connectionString,
          options: "-c search_path=" + schema,
          max: 5,
          statement_timeout: 10000,
          connectionTimeoutMillis: 5000,
        });
        return {
          db: dbFromPool(pool),
          close: async () => {
            await pool.end();
            try {
              await admin.query("DROP SCHEMA " + schema + " CASCADE");
            } finally {
              await admin.end();
            }
          },
        };
      },
      true,
    );
  },
);
