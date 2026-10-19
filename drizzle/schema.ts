import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
