import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_v2_projection_messages ADD COLUMN report_sequence INTEGER`;
  yield* sql`ALTER TABLE orchestration_v2_projection_turn_items ADD COLUMN report_sequence INTEGER`;
  yield* sql`CREATE TABLE orchestration_v2_followup_ownership (
    owner_task_id TEXT NOT NULL,
    source_task_id TEXT NOT NULL,
    handoff_sequence INTEGER NOT NULL,
    PRIMARY KEY (owner_task_id, source_task_id)
  ) WITHOUT ROWID`;
});
