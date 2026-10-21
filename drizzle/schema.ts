import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const oauthStates = sqliteTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  expiresAt: integer("expires_at").notNull(),
  ownerId: text("owner_id"),
}, (table) => [index("oauth_states_expiry").on(table.expiresAt)]);

export const googleTokens = sqliteTable("google_tokens", {
  userId: text("user_id").primaryKey(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  accessTokenEnc: text("access_token_enc"),
  accessExpires: integer("access_expires"),
  updatedAt: text("updated_at").notNull(),
});

export const events = sqliteTable("events", {
  id: text("id").notNull(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  start: text("start").notNull(),
  end: text("end").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  recurrence: text("recurrence").notNull().default("[]"),
  type: text("type").notNull().default("schedule"),
  dueDate: text("due_date"),
  dueTime: text("due_time"),
  completed: integer("completed").notNull().default(0),
  googleEventId: text("google_event_id"),
  syncedAt: text("synced_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.id] }),
  index("events_by_user_start").on(table.userId, table.start),
]);

export const eventTemplates = sqliteTable("event_templates", {
  userId: text("user_id").notNull(),
  id: text("id").notNull(),
  shortcut: text("shortcut").notNull(),
  title: text("title").notNull(),
  time: text("time").notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  recurrence: text("recurrence"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.id] }),
  uniqueIndex("event_templates_by_user_shortcut").on(table.userId, table.shortcut),
]);

export const eventBatches = sqliteTable("event_batches", {
  userId: text("user_id").notNull(),
  batchId: text("batch_id").notNull(),
  requestHash: text("request_hash").notNull(),
  claimNonce: text("claim_nonce").notNull(),
  status: text("status").notNull(),
  eventIdsJson: text("event_ids_json").notNull(),
  syncJson: text("sync_json").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.batchId] })]);
